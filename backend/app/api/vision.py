"""视觉路由（12 §8.4）：照片上传/列表/下载/收藏 + 视觉模式开关 + 主动搭话。

照片为环形缓冲（12 §6）：每用户上限 XIAOYI_VISION_CAP 张，超出淘汰最早一张；
收藏照片（is_favorite）不参与自动淘汰（上限 XIAOYI_VISION_FAV_CAP）。
所有端点按 user_id 隔离，需要登录。

图片本体以 base64 存 Photo.image（本地 SQLite/Postgres 均无压力，gallery 直接内嵌展示）。
"""
import base64
import io
import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.config import (XIAOYI_VISION_CAP, XIAOYI_VISION_FAV_CAP, XIAOYI_VISION_ENABLED,
                        XIAOYI_VISION_TALK_EVERY)
from app.core.auth import get_current_user
from app.core import memory_engine
from app.core.media_utils import MAX_FILE_SIZE, parse_upload
from app.db.sql_models import Photo, User
from app.dependencies import get_db

router = APIRouter(prefix="/api/vision", tags=["vision"])

logger = logging.getLogger("xiaoyi")


def _photo_dict(p: Photo) -> dict:
    return {
        "id": p.id,
        "shot_at": p.shot_at.isoformat() if p.shot_at else None,
        "description": p.description or "",
        "is_pretty": p.is_pretty,
        "is_private": p.is_private,
        "worth_speaking": p.worth_speaking,
        "source": p.source,
        "is_favorite": p.is_favorite,
        # 列表内嵌 base64：gallery 照片墙直接 <img> 展示，无需二次请求
        "image": p.image or "",
    }


def _enforce_cap(db: DbSession, user_id: str) -> None:
    """环形淘汰（12 §6.2）：超过上限时删除该用户最早的非收藏照片，直到不超限。

    收藏照片优先保留；若收藏本身也超上限（异常情况），从最早开始删。
    """
    from sqlalchemy import func
    total = db.query(func.count(Photo.id)).filter_by(user_id=user_id).scalar() or 0
    while total > XIAOYI_VISION_CAP:
        # 先淘汰非收藏中最旧的，非收藏清空后（理论异常）再淘汰收藏中最旧的
        target = (
            db.query(Photo)
            .filter_by(user_id=user_id, is_favorite=False)
            .order_by(Photo.shot_at.asc())
            .first()
        )
        if not target:
            target = (
                db.query(Photo)
                .filter_by(user_id=user_id)
                .order_by(Photo.shot_at.asc())
                .first()
            )
        if not target:
            break
        db.delete(target)
        db.flush()
        total -= 1


class StatusRequest(BaseModel):
    enabled: bool


class FavoriteRequest(BaseModel):
    favorite: bool


@router.post("/photo")
async def upload_photo(
    source: str = Form("poll"),  # poll / trigger / upload
    analyze: int = Form(1),      # 1=上传后调用视觉模型描述（前端轮询/触发默认开启）
    file: UploadFile = File(...),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """上传一张照片（轮询 / 语音触发 / 网页上传共用）。

    保存照片 + 视觉描述 + 场景判定（analyze=1 时），执行环形淘汰。
    返回 {ok, photo, description, is_pretty, is_private, worth_speaking, proactive_reply?}。
    proactive_reply：轮询命中主动搭话时返回小亦的主动评论（前端展示 + TTS）。
    """
    if source not in ("poll", "trigger", "upload"):
        source = "poll"
    if file.size is not None and file.size > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="图片超过 10MB 限制")

    data = await file.read()
    parsed = parse_upload(file.filename or "", file.content_type or "", data)
    if parsed.get("kind") != "image" or not parsed.get("data_url"):
        raise HTTPException(status_code=400, detail="仅支持图片文件")
    data_url = parsed["data_url"]

    description = ""
    is_pretty = is_private = worth_speaking = False
    if analyze:
        from app.core.llm_provider import llm
        info = await llm.describe_image(data_url)
        description = info.get("description") or ""
        is_pretty = bool(info.get("is_pretty"))
        is_private = bool(info.get("is_private"))
        worth_speaking = bool(info.get("worth_speaking"))

    photo = Photo(
        id=str(uuid.uuid4()), user_id=user.id, image=data_url,
        shot_at=datetime.utcnow(), description=description,
        is_pretty=is_pretty, is_private=is_private, worth_speaking=worth_speaking,
        source=source,
    )
    db.add(photo)
    db.commit()
    _enforce_cap(db, user.id)
    db.commit()

    result = {
        "ok": True,
        "photo": _photo_dict(photo),
        "description": description,
        "is_pretty": is_pretty,
        "is_private": is_private,
        "worth_speaking": worth_speaking,
    }

    # 触发/上传模式：照片入库 + 描述即完成——小亦的回复由前端聊天链路驱动
    #（trigger 语音触发 = 截帧作附件走 sendTurn SSE；upload 网页上传 = /api/chat/stream），
    # 避免 vision_analyze 生成回复 + SSE 生成回复的双重回复（2026-08-28 实施修正）。
    # vision_analyze 仍保留为 memory_engine 能力（chat_core.vision_analyze），供未来直接调用。

    # 主动搭话：轮询照片满足"好看+不私密+值得说"且达到计数周期时触发（12 §4）
    if analyze and source == "poll":
        try:
            result["proactive_reply"] = await _maybe_proactive_talk(db, user, photo, data_url, source)
        except Exception:
            logger.warning("proactive talk failed, degraded", exc_info=True)

    return result


async def _maybe_proactive_talk(db: DbSession, user: User, photo: Photo, data_url: str,
                                source: str) -> str | None:
    """主动搭话判定（12 §4）：约每 XIAOYI_VISION_TALK_EVERY 张、且照片满足
    好看 + 不私密 + 值得说，才让小亦主动评论一句。返回小亦的回复；未触发返回 None。

    拍照频率低（默认 2 分钟/张），且搭话周期为 150 张才一次，同步等待 LLM
    生成回复（数秒）可接受——换取前端能拿到回复文本直接展示 + TTS 朗读。
    """
    from sqlalchemy import func
    # 周期：本用户轮询照片总数对 TALK_EVERY 取模命中 0 时才可能触发
    total = db.query(func.count(Photo.id)).filter_by(user_id=user.id, source="poll").scalar() or 0
    if total % XIAOYI_VISION_TALK_EVERY != 0:
        return None
    if not (photo.is_pretty and not photo.is_private and photo.worth_speaking):
        return None
    if photo.spoken:
        return None
    photo.spoken = True
    db.commit()

    session_id = memory_engine.sql.ensure_session(user.id, "", source)
    try:
        return await memory_engine.vision_proactive_talk(
            user.id, session_id, source, data_url, photo_id=photo.id,
        )
    except Exception:
        logger.warning("proactive talk generation failed", exc_info=True)
        return None


@router.get("/photos")
def list_photos(
    page: int = 1,
    page_size: int = 60,
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """分页列出照片（按拍摄时间倒序）。page_size 上限 100，防一次拉太多。"""
    page = max(1, page)
    page_size = min(max(1, page_size), 100)
    total = db.query(Photo).filter_by(user_id=user.id).count()
    rows = (
        db.query(Photo)
        .filter_by(user_id=user.id)
        .order_by(Photo.shot_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {"photos": [_photo_dict(p) for p in rows], "total": total}


@router.get("/photos/{photo_id}/download")
def download_photo(
    photo_id: str,
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """下载原图：base64 data url 解码为二进制流返回。"""
    p = db.query(Photo).filter_by(id=photo_id, user_id=user.id).first()
    if not p or not p.image:
        raise HTTPException(status_code=404, detail="照片不存在")
    try:
        header, _, b64 = p.image.partition(",")
        raw = base64.b64decode(b64)
        mime = header.replace("data:", "").split(";")[0] or "image/png"
    except Exception:
        raise HTTPException(status_code=500, detail="照片数据损坏")
    ext = "png" if "png" in mime else "jpg"
    return StreamingResponse(
        io.BytesIO(raw),
        media_type=mime,
        headers={"Content-Disposition": f'attachment; filename=photo_{photo_id}.{ext}'},
    )


@router.post("/photos/{photo_id}/favorite")
def set_favorite(
    photo_id: str,
    req: FavoriteRequest,
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """收藏 / 取消收藏。收藏照片不参与自动淘汰；收藏数超上限时拒绝新增。"""
    p = db.query(Photo).filter_by(id=photo_id, user_id=user.id).first()
    if not p:
        raise HTTPException(status_code=404, detail="照片不存在")
    if req.favorite and not p.is_favorite:
        from sqlalchemy import func
        fav_count = db.query(func.count(Photo.id)).filter_by(user_id=user.id, is_favorite=True).scalar() or 0
        if fav_count >= XIAOYI_VISION_FAV_CAP:
            raise HTTPException(status_code=400, detail=f"收藏已达上限（{XIAOYI_VISION_FAV_CAP} 张）")
    p.is_favorite = req.favorite
    db.commit()
    return {"ok": True, "is_favorite": p.is_favorite}


@router.get("/status")
def get_status(db: DbSession = Depends(get_db), user: User = Depends(get_current_user)):
    """读取视觉模式开关（12 §5）。默认关闭；关闭时前端不得打开摄像头。

    生效值 = 用户开关 AND 部署级总闸（XIAOYI_VISION_ENABLED，env 默认关）——
    总闸关闭时即使曾开启也视为关，前端不打开摄像头。
    """
    return {"enabled": bool(user.vision_enabled) and XIAOYI_VISION_ENABLED}


@router.put("/status")
def put_status(req: StatusRequest, db: DbSession = Depends(get_db),
               user: User = Depends(get_current_user)):
    """写入视觉模式开关。开启后前端才能轮询拍照；关闭立即停止摄像头。"""
    user.vision_enabled = req.enabled
    db.commit()
    return {"enabled": bool(req.enabled) and XIAOYI_VISION_ENABLED}

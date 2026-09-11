"""对话路由（01 §5.2/§5.5 / 12 §2）：多类型文件上传 + SSE 流式聊天。

- POST /api/chat         非流式（JSON，兼容 CLI/chatApi.send），返回 {reply, session_id}
- POST /api/chat/stream  SSE 流式（multipart/form-data，files[] 可上传图片/文档），
                         首帧回传实际 session_id

媒体类错误（无法识别的文件类型 / 模型不支持图片）一律以「聊天式自然语言回复」反馈：
后端生成完整礼貌的句子作为正常 assistant 回复返回并落库，绝不上屏报错代码/错误码，
细节只进后端日志（12 §4 约定）。
"""
import asyncio
import json
import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core.auth import get_current_user
from app.core import memory_engine
from app.core.media_utils import MAX_FILE_SIZE, MAX_FILES, parse_upload, unsupported_reply
from app.db.sql_models import User

router = APIRouter(prefix="/api/chat", tags=["chat"])

logger = logging.getLogger("xiaoyi")


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None
    source: str = "web"  # web / desktop


async def _collect_attachments(files: list[UploadFile]) -> list[dict]:
    """读取并解析上传文件列表（超限文件不读内容，直接记为 unsupported + reason=too_large）。"""
    if not files:
        return []
    out = []
    for f in files[:MAX_FILES]:
        # 大小预检：UploadFile.size 为 Starlette 已接收的文件大小（个别代理可能拿不到，取不到时
        # 读完后由 parse_upload 内的 len(data) 预检兜底）
        if f.size is not None and f.size > MAX_FILE_SIZE:
            out.append({"name": f.filename or "未命名文件", "kind": "unsupported",
                        "size": f.size, "reason": "too_large"})
            continue
        data = await f.read()
        # parse_upload 走 pypdf/python-docx/openpyxl CPU 密集解析，下沉线程池防事件循环
        # 卡顿（大文件解析数秒会冻结全站 chat_stream，2026-08-17 修）
        out.append(await asyncio.to_thread(
            parse_upload, f.filename or "", f.content_type or "", data
        ))
    return out


# ---------------------------------------------------------------------------
# 非流式（JSON，兼容 CLI / chatApi.send；文件上传走下方 stream 接口）
# ---------------------------------------------------------------------------
@router.post("")
async def chat(req: ChatRequest, user: User = Depends(get_current_user)):
    try:
        reply, session_id = await memory_engine.chat(
            req.message, user_id=user.id, session_id=req.session_id or "", source=req.source,
        )
    except memory_engine.ChatModelNotConfigured as e:
        raise HTTPException(status_code=400, detail=str(e))
    except (ConnectionError, TimeoutError, RuntimeError) as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"reply": reply, "session_id": session_id}


# ---------------------------------------------------------------------------
# 流式（multipart/form-data：message + files[]）
# ---------------------------------------------------------------------------
@router.post("/stream")
async def chat_stream(
    message: str = Form(...),
    session_id: str | None = Form(None),
    source: str = Form("web"),
    files: list[UploadFile] = File([]),
    user: User = Depends(get_current_user),
):
    attachments = await _collect_attachments(files)
    unsupported = [a for a in attachments if a.get("kind") == "unsupported"]
    supported = [a for a in attachments if a.get("kind") != "unsupported"]

    async def event_stream():
        try:
            # 无法识别的文件类型：直接以聊天式回复反馈并落库（12 §4）；
            # 全部为超限文件时用"文件过大"文案，否则用通用"无法识别"文案
            if unsupported:
                names = "、".join(a["name"] for a in unsupported)
                too_large = unsupported and all(a.get("reason") == "too_large" for a in unsupported)
                reply = unsupported_reply(names, too_large=bool(too_large))
                sid = await memory_engine.chat_media_reply(
                    user.id, session_id or "", message, reply, source, unsupported
                )
                yield f"data: {json.dumps({'session_id': sid}, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'media_reply': reply, 'code': 'media_unsupported'}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
                return
            # 先确保会话存在，回传实际 session_id 首帧（chat_stream 内部幂等 ensure）
            sid = await asyncio.to_thread(
                memory_engine.sql.ensure_session, user.id, session_id or "", source
            )
            yield f"data: {json.dumps({'session_id': sid}, ensure_ascii=False)}\n\n"
            async for delta, thinking, is_media in memory_engine.chat_stream(
                message, user_id=user.id, session_id=sid, source=source,
                attachments=supported,
            ):
                if is_media:
                    # 模型不支持图片等：以聊天式回复呈现（前端按正常回复气泡渲染）
                    frame = {"media_reply": delta, "thinking": thinking, "code": "media_not_supported"}
                else:
                    frame = {"delta": delta, "thinking": thinking}
                yield f"data: {json.dumps(frame, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        except memory_engine.ChatModelNotConfigured as e:
            # 对话模型未配置：明确 code，前端据此显示设置引导（05 §11）
            yield f"data: {json.dumps({'error': str(e), 'code': 'chat_model_not_configured'}, ensure_ascii=False)}\n\n"
        except Exception as e:
            # 错误帧后立即关闭连接（01 §5.5 约定）；同时记日志，避免此类异常不可排查
            logger.warning("chat_stream error", exc_info=True)
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )

"""会话路由（07 §5~§10）。

路由顺序约定：/search 必须定义在 /{session_id} 之前（07 §5）。
"""
from fastapi import APIRouter, Query, Depends, HTTPException, Body
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from app.db.sql_models import Session as SessionModel, Message, User
from app.core.auth import get_current_user
from app.core.logger import logger
from app.db.chroma_client import chroma
from app.db.neo4j_client import neo4j_client
from app.dependencies import get_db
import uuid

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


class CreateSessionRequest(BaseModel):
    source: str = "web"  # web / desktop


class SessionTitleRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=128)


# ---------- 列表 ----------
@router.get("")
def list_sessions(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    offset = (page - 1) * page_size
    total = db.query(SessionModel).filter_by(user_id=user.id, is_deleted=False).count()
    items = (
        db.query(SessionModel)
        .filter_by(user_id=user.id, is_deleted=False)
        .order_by(SessionModel.updated_at.desc())
        .offset(offset).limit(page_size).all()
    )
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [{"id": s.id, "title": s.title, "updated_at": s.updated_at} for s in items],
    }


# ---------- 新建 ----------
@router.post("")
def create_session(
    req: CreateSessionRequest = Body(default=CreateSessionRequest()),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    s = SessionModel(id=str(uuid.uuid4()), user_id=user.id, title="新会话", source=req.source)
    db.add(s)
    db.commit()
    db.refresh(s)
    return {"id": s.id, "title": s.title, "source": s.source}


# ---------- 搜索（必须在 /{session_id} 之前注册） ----------
@router.get("/search")
def search_sessions(
    q: str,
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    session_ids = db.query(Message.session_id).filter(
        Message.user_id == user.id,
        Message.content.ilike(f"%{q}%"),
    ).distinct().all()
    sessions = db.query(SessionModel).filter(
        SessionModel.user_id == user.id,
        SessionModel.is_deleted.is_(False),
        SessionModel.id.in_([s[0] for s in session_ids]) |
        SessionModel.title.ilike(f"%{q}%"),
    ).all()
    return [{"id": s.id, "title": s.title} for s in sessions]


# ---------- 详情 ----------
@router.get("/{session_id}")
def get_session(
    session_id: str,
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    session = db.query(SessionModel).filter_by(id=session_id, user_id=user.id, is_deleted=False).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return {
        "id": session.id,
        "title": session.title,
        "messages": [
            {"id": m.id, "role": m.role, "content": m.content, "thinking": m.thinking or "",
             "attachments": m.attachments or "", "created_at": m.created_at}
            for m in session.messages
        ],
    }


# ---------- 修改标题 ----------
@router.put("/{session_id}/title")
def rename_session(
    session_id: str,
    req: SessionTitleRequest,
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    session = db.query(SessionModel).filter_by(id=session_id, user_id=user.id, is_deleted=False).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    session.title = req.title.strip()
    db.commit()
    return {"id": session.id, "title": session.title}


# ---------- 删除（2026-08-15 起：免密软删除，三层数据保留） ----------
# 聊天界面删除会话仅隐藏界面入口（is_deleted=True），SQL/Chroma/KG 数据全部保留，
# 供后续记忆检索与模型思考继续使用；设置页「清空数据」（POST /api/data/clear）仍为硬删除。
@router.delete("/{session_id}")
def delete_session(
    session_id: str,
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    session = db.query(SessionModel).filter_by(id=session_id, user_id=user.id, is_deleted=False).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    session.is_deleted = True
    db.commit()
    return {"ok": True, "soft_deleted": True}


# ---------- 会话内消息分页 ----------
@router.get("/{session_id}/messages")
def get_session_messages(
    session_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    session = db.query(SessionModel).filter_by(id=session_id, user_id=user.id, is_deleted=False).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    base = (
        db.query(Message)
        .filter(Message.session_id == session_id, Message.user_id == user.id)
        .order_by(Message.created_at, Message.id)  # 稳定排序
    )
    total = base.count()
    messages = base.offset((page - 1) * page_size).limit(page_size).all()
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [
            {"id": m.id, "role": m.role, "content": m.content, "thinking": m.thinking or "",
             "attachments": m.attachments or "", "created_at": m.created_at}
            for m in messages
        ],
    }


# ---------- 导出 ----------
@router.get("/{session_id}/export")
def export_session(
    session_id: str,
    format: str = "markdown",
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    session = db.query(SessionModel).filter_by(id=session_id, user_id=user.id, is_deleted=False).first()
    if not session:
        raise HTTPException(status_code=404)

    if format not in ("markdown", "json"):
        raise HTTPException(status_code=400, detail=f"不支持的导出格式：{format}")

    if format == "markdown":
        lines = [f"# {session.title}\n"]
        for m in session.messages:
            lines.append(f"**{m.role}**: {m.content}\n")
            # 导出带思考过程（AGENTS.md：get_session/messages/导出均返回 thinking）
            if m.role == "assistant" and (m.thinking or "").strip():
                lines.append(f"> 深度思考：{m.thinking}\n")
        return Response("\n".join(lines), media_type="text/markdown")

    data = {
        "id": session.id,
        "title": session.title,
        "source": session.source,
        # 消息级 source（2026-08-24 起）：与 import_session 的 m.get("source") 对应，
        # 导出→导入单会话往返不丢渠道字段
        "messages": [{"role": m.role, "content": m.content, "thinking": m.thinking or "",
                      "attachments": m.attachments or "", "source": m.source or ""}
                     for m in session.messages],
    }
    return JSONResponse(data)

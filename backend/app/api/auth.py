"""认证路由（01 §5.4.1）：send_code / login / register / me。

- login 按 body 区分登录方式：带 `code` 走验证码、带 `password` 走密码，两者互斥。
- register 时密码必填；注册成功后即登录态（返回 token）。
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.core.auth import (
    get_current_user, hash_password, verify_password, send_sms_code, verify_sms_code, create_token,
)
from app.config import SMS_MOCK
from app.db.sql_models import User
from app.dependencies import get_db

router = APIRouter(prefix="/api/auth", tags=["auth"])


class PhoneRequest(BaseModel):
    phone: str


class LoginRequest(BaseModel):
    phone: str
    code: str | None = None
    password: str | None = None


class RegisterRequest(BaseModel):
    phone: str
    code: str
    password: str
    nickname: str | None = None


@router.post("/send_code")
def send_code(req: PhoneRequest):
    code = send_sms_code(req.phone)
    # mock 阶段直接返回验证码（05 注册时序图「mock 阶段直接返回验证码」），
    # 生产接短信服务商后仅返回 {ok: true}
    return {"ok": True, "code": code if SMS_MOCK else None}


@router.post("/login")
def login(req: LoginRequest, db: DbSession = Depends(get_db)):
    if (req.code is None) == (req.password is None):
        raise HTTPException(status_code=400, detail="code 与 password 必须二选一")

    user = db.query(User).filter_by(phone=req.phone).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    if req.code is not None:
        verify_sms_code(req.phone, req.code)
    else:
        if not verify_password(user, req.password):
            raise HTTPException(status_code=403, detail="密码错误")

    # 登录时兜底确保自我节点存在（注册时若 Neo4j 未就绪会延迟到此处创建）；
    # 节点名经 self_node_display_name 脱敏手机号（03 §4，图谱不存明文手机号）
    try:
        from app.db.neo4j_client import neo4j_client
        from app.core.logger import logger
        from app.core.auth import self_node_display_name
        neo4j_client.ensure_self_node(user.id, self_node_display_name(user.nickname, user.phone))
    except Exception:
        logger.warning(f"ensure self node failed for user {user.id}")

    return {"token": create_token(user), "user": _user_dict(user)}


@router.post("/register")
def register(req: RegisterRequest, db: DbSession = Depends(get_db)):
    if db.query(User).filter_by(phone=req.phone).first():
        raise HTTPException(status_code=409, detail="该手机号已注册")
    if not req.password:
        raise HTTPException(status_code=400, detail="密码必填")

    verify_sms_code(req.phone, req.code)

    user = User(
        id=str(uuid.uuid4()),
        phone=req.phone,
        password_hash=hash_password(req.password),
        nickname=req.nickname or f"用户{req.phone}",
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    # 注册即建图谱自我节点（名称=昵称，无昵称时脱敏手机号；Neo4j 未就绪不阻断注册，03 §自我节点）
    try:
        from app.db.neo4j_client import neo4j_client
        from app.core.logger import logger
        from app.core.auth import self_node_display_name
        neo4j_client.ensure_self_node(user.id, self_node_display_name(user.nickname, user.phone))
    except Exception:
        logger.error(f"create self node failed for user {user.id}, will be lazy-created on next login")

    return {"token": create_token(user), "user": _user_dict(user)}


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return _user_dict(user)


def _user_dict(user: User) -> dict:
    return {"id": user.id, "phone": user.phone, "nickname": user.nickname}

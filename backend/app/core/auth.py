"""认证模块（01 §5.4）：密码哈希、JWT 签发/校验、验证码（mock）、get_current_user。

统一命名约定（07 §9 / 09 §6 引用）：
- hash_password(password) / verify_password(user, password)
- verify_sms_code(phone, code)
- get_current_user：FastAPI 依赖，未登录返回 401
"""
import hashlib
import hmac
import time
import uuid

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session as DbSession

from app.config import JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRE_HOURS, SMS_MOCK
from app.db.sql_models import User
from app.dependencies import get_db

_bearer = HTTPBearer(auto_error=False)


# ---------- 密码（统一用 sha256+salt 的双重哈希，避免引入额外 bcrypt 依赖时的问题；
# 生产可替换为 passlib[bcrypt]） ----------
def hash_password(password: str) -> str:
    salt = uuid.uuid4().hex
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000)
    return f"{salt}${digest.hex()}"


def verify_password(user: User, password: str) -> bool:
    if not user.password_hash:
        return False
    try:
        salt, expected = user.password_hash.split("$", 1)
    except ValueError:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000)
    return hmac.compare_digest(digest.hex(), expected)


# ---------- JWT ----------
def create_token(user: User) -> str:
    payload = {
        "sub": user.id,
        "phone": user.phone,
        "exp": int(time.time()) + JWT_EXPIRE_HOURS * 3600,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])


def mask_phone(phone: str) -> str:
    """手机号脱敏显示（03 §4）：`用户+{前3}****{后4}`，避免明文手机号进入知识图谱自我节点名。"""
    if len(phone) >= 7:
        return f"用户+{phone[:3]}****{phone[-4:]}"
    return "用户+****"


def self_node_display_name(nickname: str, phone: str) -> str:
    """图谱自我节点显示名：有昵称用昵称，无昵称（含默认「用户+手机号」）用脱敏手机号。

    注册/登录/打开图谱页兜底建自我节点时统一走此函数，保证图谱不存明文手机号。
    """
    if not nickname:
        return mask_phone(phone)
    # 默认昵称形如「用户13800138000」（无自定义昵称时由注册兜底生成），须脱敏
    if nickname == f"用户{phone}":
        return mask_phone(phone)
    if nickname.startswith("用户+") and phone and phone in nickname:
        return mask_phone(phone)
    return nickname


# ---------- 验证码（mock：直接打印/返回，不真实发送短信） ----------
_codes: dict[str, dict] = {}   # phone -> {code, expire_at, attempts}
_CODE_TTL = 300                 # 5 分钟有效
_CODE_RESEND_COOLDOWN = 60      # 60 秒内不可重复发送
_CODE_MAX_ATTEMPTS = 5          # 验证码最多尝试 5 次，超出作废


def send_sms_code(phone: str) -> str:
    """生成并"发送"验证码。mock 阶段直接返回验证码（前端可提示）；
    真实接入时在此调用短信服务商 API。"""
    now = time.time()
    prev = _codes.get(phone)
    if prev and now < prev["sent_at"] + _CODE_RESEND_COOLDOWN:
        # 发送冷却：防刷短信接口（2026-08-17 加）
        raise HTTPException(status_code=400, detail="验证码发送过于频繁，请稍后再试")
    code = str(uuid.uuid4().int)[:6]
    _codes[phone] = {"code": code, "expire_at": now + _CODE_TTL,
                     "sent_at": now, "attempts": 0}
    if SMS_MOCK:
        # 便于本地开发与 CLI 调试：验证码直接出现在后端日志/响应
        print(f"[SMS-MOCK] 发送验证码 {code} 到 {phone}")
    return code


def verify_sms_code(phone: str, code: str) -> None:
    rec = _codes.get(phone)
    if not rec:
        raise HTTPException(status_code=400, detail="验证码已过期，请重新获取")
    if time.time() > rec["expire_at"]:
        _codes.pop(phone, None)
        raise HTTPException(status_code=400, detail="验证码已过期，请重新获取")
    if rec["code"] != code:
        rec["attempts"] += 1
        if rec["attempts"] >= _CODE_MAX_ATTEMPTS:
            _codes.pop(phone, None)   # 连续失败过多：作废验证码，防暴力穷举（2026-08-17 加）
            raise HTTPException(status_code=400, detail="验证码错误次数过多，请重新获取")
        raise HTTPException(status_code=400, detail="验证码错误")
    _codes.pop(phone, None)  # 一次性使用


# ---------- FastAPI 依赖 ----------
def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: DbSession = Depends(get_db),
) -> User:
    if not credentials or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        payload = decode_token(credentials.credentials)
        user_id = payload.get("sub")
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = db.query(User).filter_by(id=user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user

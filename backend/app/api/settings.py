"""设置路由（05 §11）：模型库、功能模型分配、绑定手机号、修改密码。"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.core.auth import get_current_user, hash_password, verify_sms_code
from app.db.sql_models import Model, FunctionAssignment, User
from app.dependencies import get_db

router = APIRouter(prefix="/api/settings", tags=["settings"])

FUNCS = ("chat_model_id", "extract_model_id", "embedding_model_id")


class ModelCreateRequest(BaseModel):
    name: str
    provider: str = "openai"  # 自由字符串，兼容 OpenAI 协议即可；前端下拉含主流厂商 + 自定义（05 §11）
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    temperature: float = 0.7
    max_tokens: int = 2048
    capabilities: list[str] = []  # chat / embedding。添加时为空，由 test_model 自动探测能力后写回


class AssignRequest(BaseModel):
    func: str
    model_id: str


class ScanRequest(BaseModel):
    provider: str = "openai"
    base_url: str = ""
    api_key: str = ""


class BindPhoneRequest(BaseModel):
    phone: str
    code: str
    password: str


class ChangePasswordRequest(BaseModel):
    phone: str
    code: str
    new_password: str


def _model_dict(m: Model) -> dict:
    return {
        "id": m.id,
        "name": m.name,
        "provider": m.provider,
        "base_url": m.base_url,
        "api_key": m.api_key,
        "model": m.model,
        "temperature": m.temperature,
        "max_tokens": m.max_tokens,
        "capabilities": [c for c in (m.capabilities or "").split(",") if c],
    }


@router.get("/models")
def get_models(db: DbSession = Depends(get_db), user: User = Depends(get_current_user)):
    items = db.query(Model).filter_by(user_id=user.id).order_by(Model.created_at).all()
    return {"models": [_model_dict(m) for m in items]}


@router.post("/models")
def add_model(req: ModelCreateRequest, db: DbSession = Depends(get_db),
              user: User = Depends(get_current_user)):
    m = Model(
        id=str(uuid.uuid4()), user_id=user.id, name=req.name, provider=req.provider,
        base_url=req.base_url, api_key=req.api_key, model=req.model or req.name,
        temperature=req.temperature, max_tokens=req.max_tokens,
        capabilities=",".join(req.capabilities),
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return _model_dict(m)


# ---------- 模型管理（2026-08-15 起：测试连通性 / 修改 / 删除 / 扫描模型列表） ----------
# 注意：POST /models/scan 必须定义在 /models/{model_id}/test 之前，
# 否则 "scan" 会被 FastAPI 当作 model_id 路径参数捕获。
@router.post("/models/scan")
async def scan_models(req: ScanRequest, user: User = Depends(get_current_user)):
    """按 provider + base_url 扫描该端点可用的模型列表（Ollama 走 /api/tags，其余走 OpenAI 兼容 /models）。"""
    from app.core.llm_provider import llm
    ok, models, detail = await llm.list_models({
        "provider": req.provider,
        "base_url": req.base_url,
        "api_key": req.api_key,
    })
    return {"ok": ok, "models": models, "detail": detail}


@router.post("/models/{model_id}/test")
async def test_model(
    model_id: str,
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    m = db.query(Model).filter_by(id=model_id, user_id=user.id).first()
    if not m:
        raise HTTPException(status_code=404, detail="Model not found")

    from app.core.llm_provider import _ensure_v1, detect_capabilities
    caps = await detect_capabilities({
        "model": m.model or m.name,
        "provider": m.provider,   # 供 test_connection 判断是否本地 Ollama，给出针对性提示
        "base_url": _ensure_v1(m.base_url),
        "api_key": m.api_key,
    })
    caps_list = []
    if caps["chat"]:
        caps_list.append("chat")
    if caps["embedding"]:
        caps_list.append("embedding")
    # 服务可达才写回能力（网络失败时保留旧值，避免误清空）
    if caps["reachable"]:
        m.capabilities = ",".join(caps_list)
        db.commit()

    if caps["chat"]:
        detail = "连接成功，支持对话"
    elif caps["embedding"]:
        detail = "连接成功，支持向量化（嵌入），不支持对话"
    elif caps["reachable"]:
        detail = "模型服务可达，但未探测到对话/向量化能力"
    else:
        detail = "无法连接模型服务"
    return {"ok": caps["reachable"], "detail": detail, "capabilities": caps_list}


@router.put("/models/{model_id}")
def update_model(
    model_id: str,
    req: ModelCreateRequest,
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    m = db.query(Model).filter_by(id=model_id, user_id=user.id).first()
    if not m:
        raise HTTPException(status_code=404, detail="Model not found")
    m.name = req.name
    m.provider = req.provider
    m.base_url = req.base_url
    m.api_key = req.api_key
    m.model = req.model or req.name
    m.temperature = req.temperature
    m.max_tokens = req.max_tokens
    m.capabilities = ",".join(req.capabilities)
    db.commit()
    db.refresh(m)
    return _model_dict(m)


@router.delete("/models/{model_id}")
def delete_model(
    model_id: str,
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    m = db.query(Model).filter_by(id=model_id, user_id=user.id).first()
    if not m:
        raise HTTPException(status_code=404, detail="Model not found")

    # 若该模型正被功能分配引用，同步置空对应分配（避免残留无效引用）
    a = db.query(FunctionAssignment).filter_by(user_id=user.id).first()
    if a:
        for func in FUNCS:
            if getattr(a, func) == model_id:
                setattr(a, func, "")

    db.delete(m)
    db.commit()
    return {"ok": True}


@router.get("/function-models")
def get_function_models(db: DbSession = Depends(get_db), user: User = Depends(get_current_user)):
    a = db.query(FunctionAssignment).filter_by(user_id=user.id).first()
    if not a:
        return {
            "chat_model_id": "", "extract_model_id": "", "embedding_model_id": "",
            "chat_configured": False, "extract_configured": False, "embedding_configured": False,
        }
    # configured = 已分配且模型条目仍存在（前端据此显示/隐藏「未配置」提示）
    def _configured(mid: str) -> bool:
        return bool(mid) and db.query(Model).filter_by(id=mid, user_id=user.id).first() is not None
    return {
        "chat_model_id": a.chat_model_id,
        "extract_model_id": a.extract_model_id,
        "embedding_model_id": a.embedding_model_id,
        "chat_configured": _configured(a.chat_model_id),
        "extract_configured": _configured(a.extract_model_id),
        "embedding_configured": _configured(a.embedding_model_id),
    }


@router.put("/function-models")
async def assign_function_model(req: AssignRequest, db: DbSession = Depends(get_db),
                                user: User = Depends(get_current_user)):
    if req.func not in FUNCS:
        raise HTTPException(status_code=400, detail=f"func 必须为 {FUNCS} 之一")

    # 功能分配类型校验：聊天/记忆抽取通路只能放对话模型，向量化通路只能放向量化模型
    if req.model_id:
        m = db.query(Model).filter_by(id=req.model_id, user_id=user.id).first()
        if not m:
            raise HTTPException(status_code=404, detail="模型不存在")
        caps = [c for c in (m.capabilities or "").split(",") if c]
        # 能力未确认（添加后没测过）时自动探测一次
        if not caps:
            from app.core.llm_provider import _ensure_v1, detect_capabilities
            dcaps = await detect_capabilities({
                "model": m.model or m.name,
                "provider": m.provider,
                "base_url": _ensure_v1(m.base_url),
                "api_key": m.api_key,
            })
            if dcaps["reachable"]:
                caps = (["chat"] if dcaps["chat"] else []) + (["embedding"] if dcaps["embedding"] else [])
                m.capabilities = ",".join(caps)
                db.commit()
        # 服务可达且能力已知时严格校验（探测失败不阻断分配，返回 warning）
        if caps:
            needs_chat = req.func in ("chat_model_id", "extract_model_id")
            if needs_chat and "chat" not in caps:
                raise HTTPException(status_code=400, detail="该模型不支持对话，请选择对话模型")
            if req.func == "embedding_model_id" and "embedding" not in caps:
                raise HTTPException(status_code=400, detail="该模型不支持向量化，请选择向量化模型")

    a = db.query(FunctionAssignment).filter_by(user_id=user.id).first()
    if not a:
        a = FunctionAssignment(id=str(uuid.uuid4()), user_id=user.id)
        db.add(a)
    setattr(a, req.func, req.model_id)
    db.commit()
    return {req.func: req.model_id}


@router.post("/bind-phone")
def bind_phone(req: BindPhoneRequest, db: DbSession = Depends(get_db),
               user: User = Depends(get_current_user)):
    """为当前账号补手机号/密码。

    网页注册的默认账号（phone 为空/占位）补录真实手机号与密码，之后可用手机号+密码登录。
    """
    # 1) 校验验证码（与 /api/auth/login 的 code 校验同源）
    verify_sms_code(req.phone, req.code)
    # 2) 校验 phone 未被其他账号占用
    if db.query(User).filter(User.phone == req.phone, User.id != user.id).first():
        raise HTTPException(status_code=409, detail="该手机号已被绑定")
    # 3) 更新 phone 与 password_hash（此后可用手机号+密码登录 Web/CLI）
    user.phone = req.phone
    user.password_hash = hash_password(req.password)
    db.commit()
    return {"ok": True}


@router.post("/change-password")
def change_password(req: ChangePasswordRequest, db: DbSession = Depends(get_db),
                    user: User = Depends(get_current_user)):
    """修改账号密码（需手机号 + 验证码确认）。"""
    if req.phone != user.phone:
        raise HTTPException(status_code=400, detail="手机号与当前账号不匹配")
    if len(req.new_password) < 6:
        raise HTTPException(status_code=400, detail="新密码至少 6 位")
    verify_sms_code(req.phone, req.code)
    user.password_hash = hash_password(req.new_password)
    db.commit()
    return {"ok": True}

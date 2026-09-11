"""探活端点（01 §5.6）：Docker healthcheck 依赖 GET /api/health，无需认证。"""
from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter(tags=["health"])


@router.get("/api/health")
def health():
    """探活：只确认进程存活，不依赖外部存储（避免存储故障时容器被误判崩溃重启）。"""
    return JSONResponse({"status": "ok"})

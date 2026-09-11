"""数据管理路由（09 §4/§5/§6）：导出 / 导入 / 清空（需密码确认）。

外部存储（Chroma / Neo4j）在导出/导入/清空时可能暂时不可用：不阻断主流程，
收集 warnings 随响应返回，便于前端提示与后续重试（见 09 §4.1 健壮性）。
"""
import json
import zipfile
import io

from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.config import MAX_IMPORT_SIZE
from app.core.auth import get_current_user, verify_password
from app.core.logger import logger
from app.core.memory_engine import sql
from app.db.chroma_client import chroma
from app.db.neo4j_client import neo4j_client
from app.db.sql_models import User

router = APIRouter(prefix="/api/data", tags=["data"])


class _LimitedReader(io.RawIOBase):
    """限制读取总字节数：zip 炸弹防护——压缩包可能很小（Content-Length 校验通过）但解压后巨大。"""

    def __init__(self, raw, limit):
        self.raw = raw
        self.limit = limit
        self.read_total = 0

    def read(self, size=-1):
        chunk = self.raw.read(size if size and size >= 0 else 64 * 1024)
        if not chunk:
            return b""
        self.read_total += len(chunk)
        if self.read_total > self.limit:
            raise HTTPException(status_code=413, detail="备份解压后过大，请检查备份文件")
        return chunk

    def readable(self):
        return True


def _try_call(desc: str, fn, warnings: list[str], fallback):
    try:
        return fn()
    except Exception as e:
        logger.warning(f"data op partial failure: {desc}: {e}")
        warnings.append(f"{desc} 暂不可用（{e}），已跳过")
        return fallback


# ---------- 导出全部 ----------
@router.get("/export")
def export_all(user: User = Depends(get_current_user)):
    # 只导出当前用户的数据（09 §4.1）
    warnings: list[str] = []
    sessions = sql.get_all_sessions_with_messages(user.id)
    vector_data = _try_call("Chroma 向量", lambda: chroma.get_all(user.id), warnings, [])
    graph_data = _try_call("知识图谱", lambda: neo4j_client.export_all(user.id), warnings, {"nodes": [], "edges": []})

    export_payload = {
        "version": "1.0",
        "user_id": user.id,
        "sessions": sessions,
        "vectors": vector_data,
        "graph": graph_data,
        "warnings": warnings,
    }

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w") as zf:
        zf.writestr("xiaoyi_export.json", json.dumps(export_payload, ensure_ascii=False, indent=2))
    zip_buffer.seek(0)

    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=xiaoyi_backup.zip"},
    )


# ---------- 导入 ----------
@router.post("/import")
def import_all(request: Request, file: UploadFile = File(...),
               user: User = Depends(get_current_user)):
    # 大小限制：防超大备份拖垮服务（Content-Length 头校验，nginx 另兜底）
    content_length = int(request.headers.get("content-length") or 0)
    if content_length > MAX_IMPORT_SIZE:
        raise HTTPException(status_code=413, detail="备份文件过大（上限 50MB）")

    try:
        with zipfile.ZipFile(file.file) as zf:
            with zf.open("xiaoyi_export.json") as f:
                # 解压限流（zip 炸弹防护）：解压后字节数上限为导入体积上限的 5 倍
                data = json.load(_LimitedReader(f, MAX_IMPORT_SIZE * 5))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="不是合法的 zip 备份文件")
    except KeyError:
        raise HTTPException(status_code=400, detail="备份文件缺少 xiaoyi_export.json")
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as e:
        raise HTTPException(status_code=400, detail="备份文件内容损坏，无法解析")

    # 版本校验：未来 schema 变更可做迁移（json 内容非对象同样拒绝）
    if not isinstance(data, dict) or data.get("version") != "1.0":
        raise HTTPException(status_code=400, detail="不支持的备份版本")

    # 校验备份归属：只能导入到原用户的数据空间
    if data.get("user_id") and data["user_id"] != user.id:
        raise HTTPException(status_code=403, detail="备份不属于当前用户")

    # 导入 SQL：合并策略——已存在的 id 跳过（幂等），新数据插入
    imported = 0
    warnings: list[str] = []
    for session in data.get("sessions", []):
        if sql.import_session(session, user.id, skip_existing=True):
            imported += 1

    # 导入 Chroma：按 id 幂等 upsert（已存在 id 覆盖为一致）
    _try_call("Chroma 向量", lambda: chroma.import_collection(data.get("vectors", []), user.id), warnings, None)

    # 导入 Neo4j：节点按 id/name 合并，关系幂等
    _try_call("知识图谱", lambda: neo4j_client.import_graph(data.get("graph", {}), user.id), warnings, None)

    result = {"status": "ok", "sessions": imported}
    if warnings:
        result["warnings"] = warnings
    return result


# ---------- 清空（需密码确认，09 §6） ----------
class ClearRequest(BaseModel):
    type: str = "all"  # 'sql' | 'chroma' | 'kg' | 'all'
    password: str


@router.post("/clear")
def clear_data(clear_request: ClearRequest, user: User = Depends(get_current_user)):
    if not verify_password(user, clear_request.password):
        raise HTTPException(status_code=403, detail="密码错误")

    if clear_request.type in ("sql", "all"):
        sql.clear_messages_and_sessions(user.id)
    warnings: list[str] = []
    if clear_request.type in ("chroma", "all"):
        _try_call("Chroma 清理", lambda: chroma.clear_collection(user.id), warnings, None)
    if clear_request.type in ("kg", "all"):
        _try_call("知识图谱清理", lambda: neo4j_client.clear_graph(user.id), warnings, None)

    result = {"status": "cleared"}
    if warnings:
        result["warnings"] = warnings
    return result

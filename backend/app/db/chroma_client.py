"""Chroma 封装：collection 按 user_id 隔离（user_{user_id}）。

方法均为同步阻塞调用（Chroma 客户端为同步 API），调用方（memory_engine / forgetter）
用 asyncio.to_thread 包裹，避免卡事件循环（见 02 §7）。

向量生成走设置页分配的 embedding 模型（OpenAI 兼容 /v1/embeddings，如 Ollama bge-m3），
不再硬编码 sentence-transformers——此前初始化强制联网 huggingface.co 校验导致写消息/
查记忆反复重试卡死（见 2026-08-23 台账）。未配置向量化模型时（embedding_cfg=None）
跳过写入/检索（保持「未配置则降级」约定）。

重依赖（chromadb）惰性加载：应用启动不强制连接外部服务，首次使用时才初始化。
"""
import logging
from typing import Any

from app.config import CHROMA_HOST, CHROMA_PORT, CHROMA_COLLECTION_PREFIX

logger = logging.getLogger(__name__)


def _is_dimension_error(e: Exception) -> bool:
    """判断异常是否为向量维度不匹配（旧 collection 384 维 vs 新模型 1024 维）。

    Chroma 不同版本对维度不匹配抛的类型不完全一致，按异常类名/消息双重判断，
    避免把网络级故障误判为维度问题（那会误删 collection）。
    """
    name = type(e).__name__
    return "Dimension" in name or "dimension" in str(e)


class ChromaClient:
    def __init__(self):
        self._client = None

    # ---------- 内部工具（惰性） ----------
    def _get_client(self):
        if self._client is None:
            import chromadb
            self._client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
        return self._client

    def _collection(self, user_id: str):
        return self._get_client().get_or_create_collection(
            name=f"{CHROMA_COLLECTION_PREFIX}{user_id}",
            metadata={"hnsw:space": "cosine"},
        )

    def _embeddings(self, texts: list[str], embedding_cfg: dict) -> list[list[float]]:
        """调用配置的 embedding 模型生成向量。

        双通道（2026-09-03 起）：
        - 本地 Ollama（host ∈ localhost/127.0.0.1/0.0.0.0/host.docker.internal）
          → 原生 `POST {host}/api/embed`（body 带 keep_alive）。OpenAI 兼容
          /v1/embeddings 对 keep_alive 透传不可靠，而 keep_alive 是「chat+bge-m3
          同驻不换载」（语音二轮卡顿根治，台账 33 节）的关键：换载消灭后单次 embed
          由几秒~超时降到 ~100ms。
        - 云端 OpenAI 兼容 → 保留 `POST {base_url}/embeddings`（云端不识别 keep_alive）。

        base_url 已由 _ensure_v1 补齐 /v1，原生 /api/embed 需剥掉 /v1 后缀。
        30s 超时（2026-09-03 由 60s→10s→30s 定稿）：embedding 调用方全都不阻塞用户侧——
        upsert 是后台任务（_spawn_background 异步写），retrieve 有 0.6s wait_for 门控
        （超时弃用结果但线程照跑）。10s 在 xiaoyi 冷启动加载抢 Ollama 队列时会让 bge-m3
        排队超时 → 记忆向量静默丢失；放宽到 30s 只让后台/被弃用线程多等（零用户侧代价），
        换来冷启动时向量真写成功、日志不刷超时。调用失败抛异常，由调用方降级。
        """
        import httpx
        base_url = (embedding_cfg.get("base_url") or "").rstrip("/")
        if not base_url:
            raise RuntimeError("embedding base_url is empty")
        host = base_url.split("//")[-1].split(":")[0].lower()
        is_local = host in ("localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal")
        headers = {"Content-Type": "application/json"}
        if embedding_cfg.get("api_key"):
            headers["Authorization"] = f"Bearer {embedding_cfg['api_key']}"
        # Ollama 原生端点（无 /v1），keep_alive 生效
        if is_local:
            native = base_url[: base_url.rfind("/v1")] if base_url.endswith("/v1") else base_url
            payload = {"model": embedding_cfg.get("model"), "input": texts}
            if embedding_cfg.get("keep_alive"):
                payload["keep_alive"] = embedding_cfg["keep_alive"]
            with httpx.Client(timeout=30) as client:
                resp = client.post(f"{native}/api/embed", headers=headers, json=payload)
            if resp.status_code != 200:
                raise RuntimeError(f"embedding api error: HTTP {resp.status_code}")
            return [e for e in resp.json().get("embeddings", [])]
        # OpenAI 兼容（云端）
        body = {"model": embedding_cfg.get("model"), "input": texts}
        with httpx.Client(timeout=30) as client:
            resp = client.post(f"{base_url}/embeddings", headers=headers, json=body)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"embedding api error: HTTP {resp.status_code}")
        data = resp.json()
        return [item["embedding"] for item in data.get("data", [])]

    def _reset_collection(self, user_id: str) -> None:
        """维度不匹配时删除重建 collection（向量随后续对话重建，SQL 主数据不受影响）。"""
        try:
            self._get_client().delete_collection(f"{CHROMA_COLLECTION_PREFIX}{user_id}")
        except Exception:
            logger.warning("chroma collection delete failed (ignore): %s", user_id, exc_info=True)

    # ---------- 写入 ----------
    def upsert(self, ids: list[str], documents: list[str],
               metadatas: list[dict], user_id: str | None = None,
               embedding_cfg: dict | None = None) -> None:
        """写入 embedding。ids 已含 user_id 元数据时可不传 user_id。

        未配置向量化模型（embedding_cfg=None）→ 跳过向量写入（保持既有降级约定）。
        旧 collection 维度与新模型不一致时重建后重试一次。
        """
        if not embedding_cfg:
            return
        for m in metadatas:
            if user_id and "user_id" not in m:
                m["user_id"] = user_id
        coll_user = metadatas[0]["user_id"]
        try:
            embeddings = self._embeddings(documents, embedding_cfg)
            self._collection(coll_user).upsert(
                ids=ids, documents=documents, embeddings=embeddings, metadatas=metadatas
            )
        except Exception as e:
            if not _is_dimension_error(e):
                raise
            logger.warning("chroma dimension mismatch, rebuild collection: %s", coll_user, exc_info=True)
            self._reset_collection(coll_user)
            embeddings = self._embeddings(documents, embedding_cfg)
            self._collection(coll_user).upsert(
                ids=ids, documents=documents, embeddings=embeddings, metadatas=metadatas
            )

    def update_metadata(self, ids: list[str], metadatas: list[dict], user_id: str | None = None) -> None:
        for m in metadatas:
            if user_id and "user_id" not in m:
                m["user_id"] = user_id
        self._collection(metadatas[0]["user_id"]).update(ids=ids, metadatas=metadatas)

    # ---------- 查询 ----------
    def query(self, user_id: str, query_texts: list[str], n_results: int = 5,
              embedding_cfg: dict | None = None) -> dict[str, Any]:
        """语义检索当前用户 collection。无命中时 metadatas 可能为 None（调用方需 or []）。

        未配置向量化模型 → 返回空结果（调用方 _flatten_chroma 安全消费）。
        """
        if not embedding_cfg:
            return {}
        try:
            coll = self._collection(user_id)
            # 小集合静默降级（2026-08-24 修）：collection 为空时直接返回空结果，
            # 省去一次无意义的 embedding 调用，也去掉新用户阶段每次检索打出的告警噪音
            #（此前空集合 query 抛 NotFoundError 被调用方 catch 降级但每次都有日志）
            try:
                if coll.count() == 0:
                    return {}
            except Exception:
                pass  # count 失败不阻断正常查询（部分服务端实现无 count）
            result = coll.query(
                query_embeddings=self._embeddings(query_texts, embedding_cfg),
                n_results=n_results,
                include=["documents", "metadatas", "distances"],
            )
            return result
        except Exception as e:
            if not _is_dimension_error(e):
                raise
            logger.warning("chroma dimension mismatch, rebuild collection: %s", user_id, exc_info=True)
            self._reset_collection(user_id)
            return {}

    # ---------- 会话/全量/清理 ----------
    def get_all(self, user_id: str) -> list[dict]:
        coll = self._collection(user_id)
        got = coll.get(include=["documents", "metadatas", "embeddings"])
        out = []
        for i, doc_id in enumerate(got.get("ids") or []):
            out.append({
                "id": doc_id,
                "document": (got.get("documents") or [])[i],
                "metadata": (got.get("metadatas") or [])[i],
                "embedding": (got.get("embeddings") or [])[i],
            })
        return out

    def import_collection(self, items: list[dict], user_id: str) -> None:
        """幂等 upsert：已存在 id 覆盖为一致（09 §5）。"""
        for it in items:
            meta = dict(it.get("metadata") or {})
            meta["user_id"] = user_id
            self._collection(user_id).upsert(
                ids=[it["id"]], documents=[it.get("document", "")],
                embeddings=[it["embedding"]], metadatas=[meta],
            )

    def clear_collection(self, user_id: str) -> None:
        try:
            self._get_client().delete_collection(f"{CHROMA_COLLECTION_PREFIX}{user_id}")
        except Exception:
            pass  # 不存在时忽略


chroma = ChromaClient()

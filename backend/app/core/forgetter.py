"""遗忘与蒸馏（02 §5/§6）：MemoryWeight 权重计算 + process_forgetting 三层同步处理。

三层同步语义：SQL 标记归档 / Chroma 打标保留+摘要并存 / KG 事件蒸馏为特征。
"""
import math
import asyncio
import logging
from datetime import datetime

from app.config import ARCHIVE_THRESHOLD, MEMORY_LAMBDA, WEIGHT_ALPHA, WEIGHT_BETA, WEIGHT_GAMMA, WEIGHT_DELTA
from app.db.sql_models import Message

logger = logging.getLogger(__name__)


class MemoryWeight:
    """权重 = α*recency + β*frequency + γ*importance + δ*emotion，参数在 config 配置。"""

    def __init__(self, lambda_decay=None, alpha=None, beta=None, gamma=None, delta=None):
        self.lambda_decay = lambda_decay if lambda_decay is not None else MEMORY_LAMBDA
        self.alpha = alpha if alpha is not None else WEIGHT_ALPHA
        self.beta = beta if beta is not None else WEIGHT_BETA
        self.gamma = gamma if gamma is not None else WEIGHT_GAMMA
        self.delta = delta if delta is not None else WEIGHT_DELTA

    def recency(self, last_mentioned_at: datetime) -> float:
        seconds = max(0.0, (datetime.utcnow() - last_mentioned_at).total_seconds())
        return math.exp(-self.lambda_decay * seconds / 86400.0)  # 以天为单位衰减

    def frequency(self, mention_count: int) -> float:
        return min(1.0, mention_count / 10.0)  # 封顶在 1.0

    def compute(self, msg) -> float:
        r = self.recency(msg.last_mentioned_at)
        f = self.frequency(msg.mention_count)
        i = msg.importance or 0.0
        e = msg.emotion_score or 0.0
        return (
            self.alpha * r +
            self.beta * f +
            self.gamma * i +
            self.delta * e
        )


async def process_forgetting(db_session, chroma, kg_client, llm):
    """定时遗忘任务：重算权重 → 对低权重消息三层同步处理。

    幂等性：msg_{id} 打标是覆盖同一 id 的 metadata；sum_{id} 是固定 id 的 upsert；
    KG 的 merge 是「存在即返回，不存在才创建」。因此中途失败重试不会产生重复摘要/三元组。
    """
    threshold = ARCHIVE_THRESHOLD

    # 先重算权重（含 recency 时间衰减），否则权重不会随时间自然下降。
    # 全库遍历 + commit 为同步阻塞 SQL，且 hourly 运行，须下沉到线程池防事件循环卡顿；
    # 线程内完成读写并返回纯 dict，避免跨线程访问 ORM 对象（commit 后属性过期会触发
    # reload 同步查询，2026-08-17 修）
    def _scan_and_weight():
        weight_calc = MemoryWeight()
        # 全量扫描分页（2026-08-24 修）：此前一次性 .all() 拉全表，消息量大时内存
        # 与一次事务耗时都不可控；改为按 id 稳定排序、每批 500 条迭代扫描
        low = []
        _PAGE = 500
        cursor = 0
        while True:
            rows = (
                db_session.query(Message)
                .filter(Message.is_archived.is_(False))
                .order_by(Message.id)
                .limit(_PAGE)
                .offset(cursor)
                .all()
            )
            if not rows:
                break
            for msg in rows:
                msg.weight = weight_calc.compute(msg)
                if msg.weight < threshold:
                    low.append({"id": msg.id, "user_id": msg.user_id, "content": msg.content})
            cursor += len(rows)
            if len(rows) < _PAGE:
                break
        db_session.commit()  # 先持久化刷新后的权重
        return low

    low_weight_msgs = await asyncio.to_thread(_scan_and_weight)

    # 每个用户用其配置的向量化模型生成摘要向量；未配置该用户 embedding 时摘要向量
    # 写入会被 chroma.upsert 跳过（embedding_cfg=None 直接 return，metadata 打标照常）
    from app.core.memory_engine import _model_configs
    embedding_cfgs: dict = {}
    extract_cfgs: dict = {}
    for uid in {m["user_id"] for m in low_weight_msgs}:
        cfgs = _model_configs(db_session, uid)
        embedding_cfgs[uid] = cfgs["embedding"]
        # 摘要/三元组抽取也必须用该用户配置的「记忆抽取模型」——此前忘传导致
        # 本地 Ollama 用户（key 空）摘要退化截断、三元组恒空（2026-08-24 审核修复）
        extract_cfgs[uid] = cfgs["extract"]

    try:
        archived_ids = []
        for msg in low_weight_msgs:
            uid = msg["user_id"]
            # 1. 生成摘要（LLM 调用本身是 async，无需 to_thread；用该用户抽取模型配置）
            summary = await llm.summarize(msg["content"], model_config=extract_cfgs.get(uid))

            # 1a. 原消息 embedding 打标 is_archived=true（保留原向量，供长期语义检索）
            await asyncio.to_thread(
                chroma.update_metadata,
                ids=[f"msg_{msg['id']}"],
                metadatas=[{
                    "user_id": msg["user_id"],
                    "source": "sql_archive",
                    "original_id": msg["id"],
                    "is_archived": True,
                }],
            )

            # 1b. 新增摘要 embedding（并存，id=sum_{id}）
            await asyncio.to_thread(
                chroma.upsert,
                ids=[f"sum_{msg['id']}"],
                documents=[summary],
                metadatas=[{
                    "user_id": msg["user_id"],
                    "source": "sql_archive_summary",
                    "original_id": msg["id"],
                    "is_archived": True,
                }],
                embedding_cfg=embedding_cfgs.get(uid),
            )

            # 2. 蒸馏到知识图谱（带上 user_id；merge 幂等）
            #    宾语按 objectKind 分 Person/Thing（2026-09-03 起模型显式给 objectKind，
            #    不再用 KNOWS 特判）
            triples = await llm.extract_triples(msg["content"], model_config=extract_cfgs.get(uid))
            for sub, pred, obj, obj_kind in triples:
                sub_id = await asyncio.to_thread(kg_client.merge_person, sub, user_id=msg["user_id"])
                if obj_kind == "person":
                    obj_id = await asyncio.to_thread(kg_client.merge_person, obj, user_id=msg["user_id"])
                else:
                    obj_id = await asyncio.to_thread(kg_client.merge_thing, obj, user_id=msg["user_id"])
                await asyncio.to_thread(kg_client.link, sub_id, pred, obj_id, user_id=msg["user_id"])

            # 3. 三层都成功后，SQL 标记归档（批量 update + commit 下沉线程池）
            archived_ids.append(msg["id"])

        def _mark_archived():
            db_session.query(Message).filter(Message.id.in_(archived_ids)).update(
                {Message.is_archived: True}, synchronize_session=False
            )
            db_session.commit()

        await asyncio.to_thread(_mark_archived)
    except Exception as e:
        db_session.rollback()
        logger.error(f"forgetting failed, rollback: {e}")
        raise

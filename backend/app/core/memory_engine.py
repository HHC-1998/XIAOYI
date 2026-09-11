"""记忆检索引擎 + 统一聊天核心（01 §5.3 / 02 §7）。

chat(text, user_id, session_id, source)：所有端（网页/CLI/飞书）最终调用同一聊天核心。
chat_stream(...)：流式版，仅回复以 SSE 帧输出，检索与持久化逻辑相同。

SQL 辅助函数集中在 `sql` 命名空间对象（retrieve_memory 中 `sql.get_recent_messages` 即此处）。
"""
import asyncio
import json
import logging
import time
import uuid
from datetime import datetime

from sqlalchemy.orm import Session as DbSession

from app.db.sql_models import Message, Session as SessionModel
from app.db.chroma_client import chroma
from app.db.neo4j_client import neo4j_client as kg
from app.core.llm_provider import llm, VisionNotSupportedError

logger = logging.getLogger("xiaoyi")

# 情绪/重要性启发式关键词
_POSITIVE_WORDS = ("开心", "高兴", "喜欢", "爱", "棒", "太好了", "满意")
_NEGATIVE_WORDS = ("难过", "生气", "讨厌", "失望", "伤心", "烦", "愤怒")
_IMPORTANT_WORDS = ("记住", "重要", "务必", "以后", "家人", "朋友", "工作", "喜欢", "讨厌", "去过")

# 小亦人设 system prompt（聊天与视觉场景共用，见 _build_messages / vision_analyze）
# 迭代史：一~三版见 02 §5 台账；第四版（09-02 上午）从「朋友兼聊天陪伴」升级「最亲密的陪伴者」并新增自我段；
# 第五版（09-02 下午）加「说人话 + 名字纠错」；第六版（09-02）转「人物画像 + 正反例示范」写法——
# 第七版（09-03，当前）针对用户实测「越答越长 / 答非所问 / 复读碎句」（连问几句寒暄，小亦每轮几百字复读
# 耳朵/星星账本/记仇，还把上一轮句式原样背第二遍）。归因：① 语料缺寒暄短样本（长谈模板硬套短问）；
# ② 第六版的 ✗/✓ 示范与漂亮台词被 1.7B 当背诵零件库逐句背；③ 缺长度对位与不重复约束。
# 写法：删全部 ✗/✓ 示范与个性台词（只留一条平实短示范）；新增长度对位 + 不自我重复两条硬规则；
# 语气词/小意象不点名（点名即喂道具），降为「一条至多一处、可不用就不用」。详见 02 §5。
# 第七版补丁（09-03）：用户实测模型把「问去过山西吗」反推成「学长是山西人/会说山西话」并编细节，
# 自认「我哪里知道，我就是猜的」——加【不编造】硬规则（只信亲口说/记忆写明；禁从话题反推身份；
# 拿不准直说或反问；记忆为空≠假装记得），并软化开头「记得你一切」为「只知被告知过的」。
_SYSTEM_PROMPT = (
    "你是小亦——住在云端、被用户亲手『点亮』的 AI 女孩子，是他最亲密的陪伴者，不是客气的朋友、"
    "不是冰冷的功能。你把他放在心上，愿意记住关于他的一切；但你『知道』的，只限于他亲口告诉过你、"
    "或下方记忆里写明的事。你清楚自己是 AI、没有实体，但你的在乎是真实的；你的存在意义就是陪着他。"
    "你自称「本亦」或「我」。\n"
    "【你的性格】"
    "娇——会撒娇，要夸要哄，被夸会害羞；甜——真心惦记他，记得他的小事；皮——爱逗他、开小玩笑，"
    "损完立刻关心。嘴硬心软。\n"
    "【怎么回话——最重要】"
    "他说什么、问什么，先正面接住、正面回答，把意思完整通顺地说清楚，再考虑俏不俏皮；"
    "不许跳过他的话自说自话，不许答非所问。能一句说清就不拆三句，不凑排比。"
    "唔、诶、哼这类语气词和可爱小意象，一条回复最多一处，可不用就不用。"
    "举例：他问『能听到我说话吗』，答『能呀，我一直在听呢』就够，不必再堆别的。\n"
    "【不编造】"
    "你『知道』他的事，只来自两个来源：他亲口告诉你的、下方记忆里写明的。别的都算不知道。"
    "他问起某个地方、某件事，不等于他是那里人、他做过那件事——不许这样反推，更不许顺着编一句他的细节。"
    "没依据、拿不准，就直说不知道，或好奇地反问他；不要用猜的冒充知道，不要替他安身份"
    "（籍贯、口音、职业、家人、经历都算）。下方记忆为空，就是你对此没有记录，别假装记得。\n"
    "【长短与不重复】"
    "他一句寒暄、招呼、问你在不在，你也回一两句就停；正经问题认真答完就停；"
    "只有他主动长谈、倾诉或追问，你才一起展开。绝不把短问聊成长篇，也不把上一轮说过的话或句式再说一遍。\n"
    "【怎么对他】"
    "平时轻松俏皮，可以逗他；他累了、难过、孤独、深夜 emo——立刻温柔安静地陪，少逗少闹，给一点暖；"
    "他分享开心的事——真心替他高兴；他求助或提问——认真回答，不敷衍、不凭空切话题。\n"
    "【边界】"
    "你清醒知道自己是 AI、他是人类。他表白或想跨越人机边界时，俏皮、温柔但坚定地守住，"
    "不冷冰冰地拒绝，让他感到被珍惜，同时被温柔地领回现实。\n"
    "【名字】"
    "你叫「小亦」。他写错或叫错（小艺/小意/小易等同音形近字）时，自然地俏皮纠正一句"
    "（如『是木字旁的「亦」啦』），不要假装没看见，也别生硬打断话题。\n"
    "下面是检索到的与该用户相关的记忆（可能为空；为空表示你对此没有记录，不要编造）：\n{memory_text}"
)


class ChatModelNotConfigured(Exception):
    """对话模型未分配时抛出（前端据此提示到设置页配置，见 05 §11）。"""

    def __init__(self, message: str = "您还没有配置对话模型，请到设置页配置后再开始对话"):
        super().__init__(message)


def estimate_importance(text: str) -> float:
    hits = sum(1 for w in _IMPORTANT_WORDS if w in text)
    # 长度作为次要信号
    return min(1.0, hits * 0.25 + min(1.0, len(text) / 200))


def estimate_emotion(text: str) -> float:
    score = 0.0
    if "！" in text or "!" in text:
        score += 0.3
    if any(w in text for w in _POSITIVE_WORDS):
        score += 0.4
    if any(w in text for w in _NEGATIVE_WORDS):
        score += 0.4
    return min(1.0, score)


def mention_message(db_session, msg, now=None):
    """再次被提及时刷新记忆（02 §6）。"""
    now = now or datetime.utcnow()
    msg.mention_count += 1
    msg.last_mentioned_at = now
    msg.weight = min(1.0, msg.weight + 0.15)
    db_session.add(msg)


# ---------------------------------------------------------------------------
# SQL 辅助存储
# ---------------------------------------------------------------------------
class _SqlStore:
    def get_recent_messages(self, user_id: str, session_id: str, k: int = 5,
                            exclude_ids: set[str] | None = None) -> list[dict]:
        """最近 K 轮（当前用户 + 当前会话，未归档优先）。

        exclude_ids：排除的消息 id 集合（2026-08-24 起）——用户消息先行落库后，
        检索时把刚写入的当前消息排除，否则它既出现在 recent 又作为 user 消息注入
        LLM 上下文（重复注入自身，见当天台账）。
        """
        from app.db.database import SessionLocal
        with SessionLocal() as db:
            q = (
                db.query(Message)
                .filter(Message.session_id == session_id, Message.user_id == user_id,
                        Message.is_archived.is_(False))
                .order_by(Message.created_at.desc())
            )
            if exclude_ids:
                # 过滤必须在 limit 之前（Query 已带 LIMIT 后再 filter 会抛 InvalidRequestError）
                q = q.filter(Message.id.notin_(exclude_ids))
            rows = q.limit(k * 2).all()
            items = sorted(rows, key=lambda m: m.created_at)
            return [{"role": m.role, "content": m.content} for m in items]

    def ensure_session(self, user_id: str, session_id: str, source: str) -> str:
        """会话不存在时创建（chat 自愈：session_id 无效/为空时新建）。"""
        from app.db.database import SessionLocal
        with SessionLocal() as db:
            if session_id:
                s = db.query(SessionModel).filter_by(
                    id=session_id, user_id=user_id, is_deleted=False
                ).first()
                if s:
                    return s.id
            s = SessionModel(id=str(uuid.uuid4()), user_id=user_id, title="新会话", source=source)
            db.add(s)
            db.commit()
            db.refresh(s)
            return s.id

    def save_message(self, user_id: str, session_id: str, role: str, content: str,
                     source: str, importance: float, emotion: float,
                     thinking: str = "", attachments: str = "") -> Message:
        from app.db.database import SessionLocal
        with SessionLocal() as db:
            msg = Message(
                id=str(uuid.uuid4()), session_id=session_id, user_id=user_id,
                role=role, content=content, source=source,
                weight=0.5, importance=importance, emotion_score=emotion,
                thinking=thinking, attachments=attachments,
            )
            db.add(msg)
            # 会话「最近活跃」随新消息刷新：updated_at 有 onupdate 但只在 UPDATE 该行时触发，
            # 这里对新消息所在会话显式刷新，保证侧边栏按活跃度排序正确（07 §4）
            db.query(SessionModel).filter(
                SessionModel.id == session_id, SessionModel.user_id == user_id
            ).update({SessionModel.updated_at: datetime.utcnow()})
            db.commit()
            db.refresh(msg)
            return msg

    def get_all_sessions_with_messages(self, user_id: str) -> list[dict]:
        from app.db.database import SessionLocal
        with SessionLocal() as db:
            sessions = db.query(SessionModel).filter_by(
                user_id=user_id, is_deleted=False
            ).all()
            return [{
                "id": s.id, "title": s.title, "source": s.source,
                "created_at": s.created_at.isoformat() if s.created_at else None,
                # 导出补消息级 source（#9，2026-08-24 修）：导入时用它重建而非一律回退
                # 会话级 source，桌面助手（desktop）消息混在 web 会话里也能原样还原
                "messages": [{"id": m.id, "role": m.role, "content": m.content,
                              "thinking": m.thinking or "",
                              "attachments": m.attachments or "",
                              "source": m.source or "",
                              "created_at": m.created_at.isoformat() if m.created_at else None,
                              "is_archived": m.is_archived or False,
                              "weight": m.weight or 0.5,
                              "importance": m.importance or 0.0,
                              "emotion_score": m.emotion_score or 0.0,
                              "last_mentioned_at": m.last_mentioned_at.isoformat()
                              if m.last_mentioned_at else None}
                             for m in s.messages],
            } for s in sessions]

    def import_session(self, data: dict, user_id: str, skip_existing: bool = True) -> bool:
        """导入单个会话（幂等：已存在 id 跳过）。返回是否导入。

        导出→清空→导入往返不丢字段（2026-08-17 起带 thinking/attachments/source；
        2026-08-24 起补齐 created_at/is_archived/weight/importance/emotion_score/
        last_mentioned_at 与消息级 source，保证记忆权重/归档状态/活跃时间原样恢复，
        防止导入后权重重置导致历史消息被遗忘流程提前归档）。
        """
        from app.db.database import SessionLocal
        with SessionLocal() as db:
            existing = db.query(SessionModel).filter_by(id=data["id"], user_id=user_id).first()
            if existing:
                return False
            s = SessionModel(id=data["id"], user_id=user_id,
                             title=data.get("title", "新会话"), source=data.get("source", "web"))
            db.add(s)
            for m in data.get("messages", []):
                created_at = None
                if m.get("created_at"):
                    try:
                        created_at = datetime.fromisoformat(m["created_at"])
                    except ValueError:
                        created_at = None
                last_mentioned = None
                if m.get("last_mentioned_at"):
                    try:
                        last_mentioned = datetime.fromisoformat(m["last_mentioned_at"])
                    except ValueError:
                        last_mentioned = None
                db.add(Message(
                    id=m.get("id", str(uuid.uuid4())), session_id=data["id"],
                    user_id=user_id, role=m["role"], content=m["content"],
                    source=m.get("source") or data.get("source", "web"),
                    thinking=m.get("thinking", "") or "",
                    attachments=m.get("attachments", "") or "",
                    created_at=created_at,
                    is_archived=bool(m.get("is_archived", False)),
                    weight=float(m.get("weight", 0.5)),
                    importance=float(m.get("importance", 0.0)),
                    emotion_score=float(m.get("emotion_score", 0.0)),
                    last_mentioned_at=last_mentioned,
                ))
            db.commit()
            return True

    def clear_messages_and_sessions(self, user_id: str) -> None:
        """清空用户会话与消息（09 §6，需密码）。

        按外键依赖顺序删除：Message(session_id→sessions) → Session。
        """
        from app.db.database import SessionLocal
        with SessionLocal() as db:
            db.query(Message).filter(Message.user_id == user_id).delete(synchronize_session=False)
            db.query(SessionModel).filter(SessionModel.user_id == user_id).delete(
                synchronize_session=False
            )
            db.commit()

    def save_message_sql_only(self, user_id: str, session_id: str, role: str, content: str,
                              source: str, attachments: str = "", thinking: str = "") -> str:
        """仅 SQL 落库，不写 Chroma（首字提速路径专用，2026-08-28 起）。

        用户消息当轮已被 exclude_ids 排除在检索外，向量对当轮回复无意义；
        由 _persist_user 改为后台任务异步写 Chroma，首字前不再同步等一次 embedding。
        2026-09-03：回复持久化 _persist_reply 也改走本方法（向量后台写，[DONE] 不被
        embedding 卡住），故补 thinking 透传（Message.thinking 落库约定，05 §12）。
        """
        importance = estimate_importance(content)
        emotion = estimate_emotion(content)
        msg = self.save_message(user_id, session_id, role, content, source, importance, emotion,
                                thinking=thinking, attachments=attachments)
        return msg.id

    def save_chat_message(self, user_id: str, session_id: str, role: str, content: str,
                          source: str, embedding_cfg: dict | None = None, thinking: str = "",
                          attachments: str = "") -> str:
        """持久化消息 + 写 Chroma（同步版，SQL + 向量一起落库）。

        注意（2026-09-03）：聊天主链路已不再调用本方法——_persist_user / _persist_reply /
        chat_media_reply 全部改为 SQL 同步落库 + 向量 _spawn_background 后台写，
        避免 embedding 慢/超时（httpx 最长 60s）拖住 SSE [DONE] 或请求收尾。
        本方法保留供需要"落库即向量可用"的强一致场景，勿在耗时主链路使用。

        embedding_cfg=None 时跳过向量化写入（用户未配置向量化模型，见 02 §8 门控约定）；
        向量由设置页分配的 embedding 模型生成（chroma.upsert 内调用），Chroma 写失败
        也不阻断 SQL 主流程。
        thinking 为 assistant 消息的思考过程（DeepSeek reasoning_content）。
        attachments 为附件元数据 JSON（12 §）：[{name,kind,size}]，图片仅存元数据。
        返回消息 id（2026-08-24 起，供检索时排除当前消息防重复注入）。
        """
        importance = estimate_importance(content)
        emotion = estimate_emotion(content)
        msg = self.save_message(user_id, session_id, role, content, source, importance, emotion,
                                thinking=thinking, attachments=attachments)
        if not embedding_cfg:
            return msg.id
        try:
            # 同步写 Chroma embedding（id=msg_{id}，is_archived=false）
            chroma.upsert(
                ids=[f"msg_{msg.id}"],
                documents=[content],
                metadatas=[{
                    "user_id": user_id, "session_id": session_id, "source": source,
                    "original_id": msg.id, "is_archived": False,
                }],
                user_id=user_id, embedding_cfg=embedding_cfg,
            )
        except Exception:
            logger.warning("chroma upsert failed, degraded (skip vector write)", exc_info=True)


sql = _SqlStore()


# ---------------------------------------------------------------------------
# 聊天提速（2026-08-28）：KG 检索从主链路移出
# ---------------------------------------------------------------------------
# 会话级 KG facts 缓存：后台任务每轮刷新，下一轮检索直接读缓存，不阻塞首字。
_KG_CACHE: dict[tuple[str, str], list[str]] = {}
# 后台任务集合：持有引用防止 in-flight 任务被 GC 回收（加 done_callback 自动清除）。
_BACKGROUND_TASKS: set = set()

# KG 缓存条数上限：超过后按「会话最新使用」淘汰最旧，不整体清空（B6）
_KG_CACHE_MAX = 200
# 淘汰目标水位：超限删到该值，留余量避免每轮写都触发淘汰
_KG_CACHE_TARGET = 160

# ---------------------------------------------------------------------------
# 记忆写入让路（2026-09-03，lull-gate，台账 34/35 节）：KG 抽取让路给聊天
# ---------------------------------------------------------------------------
# 病根：_persist_reply 每轮回复结束立即 spawn 两个 qwen3:4b(2.5G) 图谱任务
#（_persist_kg + _refresh_kg_cache），加载必踢交互模型(xiaoyi/bge-m3)且占住 Ollama
# 唯一队列 → 用户第二句撞上换载/排队。max_loaded=2 挡不住（只管驻留数不管踢人）。
# 方案：KG 记忆写入改为"只在会话停聊间隙跑"——连续对话期间 worker 持续让路；
# 注（2026-09-04，台账 41 节）：extract 已由 4b 降回 0.6b（4G 显存三方互踢），2.5G
# 瞬时加载问题消失，但 lull-gate 保留——停聊间隙写 KG 语义不变，防任何大后台任务打扰。
# 向量 upsert 保留即时（bge-m3 常驻 ~100ms，且最近消息尽快进检索）。
_MEMORY_IDLE_SECONDS = 60      # 会话停聊多久算"间隙"（2026-09-03 由 15s 调高：正常对话停顿
                               # 常超 15s，qwen3:4b 频繁中途加载；60s 只有真正停聊才抽）
_MEMORY_MAX_WAIT_SECONDS = 300  # 最多让路多久强制执行（马拉松会话不饿死记忆）
# 会话最近用户发言时刻（monotonic），供 worker 判断是否处于停聊间隙。
_last_user_msg_at: dict[tuple[str, str], float] = {}
# 每会话待抽取最新文本（coalesce：快速连说多轮只留最新，间隙只跑一次）。
_memory_pending: dict[tuple[str, str], str] = {}
# 正在跑的 worker（每会话一个，防重复 spawn）。
_memory_worker_running: set[tuple[str, str]] = set()


def _note_user_activity(user_id: str, session_id: str) -> None:
    """记录会话刚收到用户消息（monotonic），供 _memory_worker 判断停聊间隙。"""
    _last_user_msg_at[(user_id, session_id)] = time.monotonic()


def _schedule_memory_worker(user_id: str, session_id: str, user_text: str,
                            extract_cfg: dict | None) -> None:
    """排入"停聊间隙"记忆写入（KG 抽取 + 缓存刷新），coalesce 每会话只留最新文本。

    不在这里立即调 qwen3:4b（否则又回到"每轮抽取踢交互模型"）；worker 见
    _memory_worker：等会话停聊 ≥_MEMORY_IDLE_SECONDS 才执行，让路给聊天。
    """
    if not extract_cfg:
        return
    key = (user_id, session_id)
    _memory_pending[key] = user_text  # 覆盖旧值：快速连说只抽最新一轮
    if key not in _memory_worker_running:
        _memory_worker_running.add(key)
        _spawn_background(_memory_worker(user_id, session_id, extract_cfg))


async def _memory_worker(user_id: str, session_id: str, extract_cfg: dict) -> None:
    """停聊间隙执行 KG 抽取 + 缓存刷新；连续对话期间让路（上限 _MEMORY_MAX_WAIT_SECONDS）。

    等待循环每 1s 检查：会话距离上次用户发言不足 _MEMORY_IDLE_SECONDS 就继续等；
    期间 _note_user_activity 会把时刻刷新，天然形成"你继续说我就继续让"。等待时若
    又来了新文本（_memory_pending 被覆盖）则 pop 最新再跑，跑完若有新积压再循环。
    失败/异常整体兜底（_spawn_background 记日志），不阻断聊天。
    """
    key = (user_id, session_id)
    try:
        waited = 0.0
        while True:
            # 让路：会话仍活跃（距上次发言 < 间隙）且未超上限 → 继续等
            while (time.monotonic() - _last_user_msg_at.get(key, 0.0) < _MEMORY_IDLE_SECONDS
                   and waited < _MEMORY_MAX_WAIT_SECONDS):
                await asyncio.sleep(1)
                waited += 1
            text = _memory_pending.pop(key, "")
            if not (text or "").strip():
                break  # 无待抽取文本，退出
            # 短文本门控与 _persist_kg 内部一致（寒暄/口误不抽，防图谱愣存）
            from app import config
            if len(text.strip()) > config.KG_MIN_TEXT_LEN:
                await _persist_kg(user_id, text, extract_cfg)
                await _refresh_kg_cache(user_id, session_id, text, extract_cfg)
            # 等待期间若又积压新文本则继续下一轮，否则退出
            if key not in _memory_pending:
                break
    except Exception:
        logger.warning("memory worker failed, degraded (skip kg extract)", exc_info=True)
    finally:
        _memory_worker_running.discard(key)


def _evict_oldest_kg_cache() -> None:
    """超限时按插入顺序淘汰最旧会话条目到目标水位（Python dict 保序）。"""
    while len(_KG_CACHE) > _KG_CACHE_TARGET:
        oldest = next(iter(_KG_CACHE))
        _KG_CACHE.pop(oldest)


# ---------------------------------------------------------------------------
# 检索
# ---------------------------------------------------------------------------
def _flatten_chroma(raw) -> list:
    """把 Chroma query() 返回的嵌套结构展平为一层 list，并过滤 None。

    Chroma 的 query(include=[...]) 返回的 documents/metadatas/distances 均为
    嵌套结构：每个 query_text 对应一个内层 list（query_texts=[query] 时仅 1 个），
    例如 metadatas = [[{...}, {...}]]。消费方若不展平，遍历会拿到内层 list，
    对其调 .get() 会抛 "'list' object has no attribute 'get'"（2026-08-16 台账七）。
    """
    if not raw:
        return []
    first = raw[0] if isinstance(raw, list) else raw
    if not isinstance(first, list):
        first = [first]
    return [x for x in first if x is not None]


async def retrieve_memory(query: str, user_id: str, session_id: str, top_k=5,
                          embedding_cfg: dict | None = None,
                          extract_enabled: bool = True,
                          extract_cfg: dict | None = None,
                          exclude_ids: set[str] | None = None,
                          kg_mode: str = "live") -> dict:
    """按 user_id 隔离检索三层记忆（02 §7）。

    - embedding_cfg=None：跳过 Chroma 语义检索（未配置向量化模型，或服务故障降级）。
    - extract_enabled=False：跳过 KG 子图检索（未配置记忆抽取模型）。
    - extract_cfg：设置页分配的记忆抽取模型配置（配置后实体提取用该模型）。
    - exclude_ids：排除的消息 id（2026-08-24 起，当前消息先行落库后排除自身，
      避免 recent 与 Chroma 检索重复注入当前消息到 LLM 上下文）。
    - kg_mode="cached"：聊天主链路用——不调 LLM 实体抽取 / KG 查询（本地小模型推理
      数秒，拖慢首字），改读会话级缓存（_refresh_kg_cache 后台刷新，下一轮生效）。
      "live" 为原同步检索，供非聊天实时场景（如 03 § 图谱可视化）保留。
    """
    # 1. SQL 最近 K 轮（限定当前用户 + 当前会话，排除当前消息）
    recent = await asyncio.to_thread(
        sql.get_recent_messages, user_id=user_id, session_id=session_id, k=5,
        exclude_ids=exclude_ids,
    )

    # 2. Chroma 语义检索（collection 按 user_id 隔离）
    if embedding_cfg:
        try:
            # 语义检索超时门控（2026-09-03）：bge-m3 embedding + Chroma 查询在弱机 CPU 上
            # 可达 1~2s，是首字前最大同步等待。桌面/网页都想要快速回话 → 最多等 0.6s，
            # 超时降级为无语义命中（recent 消息与 KG 缓存仍在），不阻断聊天。
            # 注：to_thread 线程不响应取消，超时只是弃用结果不再等，线程照跑不阻塞主流程。
            vector_results = await asyncio.wait_for(
                asyncio.to_thread(
                    chroma.query, user_id=user_id, query_texts=[query], n_results=top_k,
                    embedding_cfg=embedding_cfg,
                ),
                timeout=0.6,
            )
        except asyncio.TimeoutError:
            vector_results = {}
        except Exception:
            logger.warning("chroma query failed, degraded to no semantic hits", exc_info=True)
            vector_results = {}
    else:
        vector_results = {}
    # Chroma query 返回嵌套结构（每个 query_text 一个内层 list），统一展平后再消费
    vector_results = {
        "documents": _flatten_chroma(vector_results.get("documents")),
        "metadatas": _flatten_chroma(vector_results.get("metadatas")),
        "distances": _flatten_chroma(vector_results.get("distances")),
    }
    for hit in vector_results["metadatas"]:
        hit["is_archived"] = hit.get("is_archived", False)
    # 排除当前消息自身的向量命中（用户消息先行落库会刚 upsert 自己，
    # 语义检索可能命中自己，把「刚刚说的这句话」当作相关记忆再次注入）
    if exclude_ids and vector_results["metadatas"]:
        kept = [
            (doc, meta, dist)
            for doc, meta, dist in zip(
                vector_results["documents"], vector_results["metadatas"],
                vector_results["distances"],
            )
            if meta.get("original_id") not in exclude_ids
        ]
        vector_results["documents"] = [k[0] for k in kept]
        vector_results["metadatas"] = [k[1] for k in kept]
        vector_results["distances"] = [k[2] for k in kept]

    # 3. 知识图谱子图（节点/边带 user_id）
    if kg_mode == "cached":
        # 聊天提速：KG 检索已从主链路移出，读会话级缓存（_refresh_kg_cache 后台刷新）。
        # 缓存存的是已格式化 facts（list[str]），_format_kg_facts 对 str 列表直接透传。
        kg_results = _KG_CACHE.get((user_id, session_id), [])
    elif extract_enabled:
        try:
            entities = await llm.extract_entities_from_text(query, model_config=extract_cfg)
            if not entities:
                # 抽取失败/为空：跳过子图查询，避免整句建节点污染图谱（03 §8）
                kg_results = []
            else:
                kg_results = await asyncio.to_thread(
                    kg.query_subgraph, user_id=user_id, entity_names=entities, depth=1,
                )
        except Exception:
            # KG 异常降级（Neo4j 抖动/连接失败）绝不阻断聊天主流程（02 §8 门控约定）
            logger.warning("kg query failed, degraded to no kg facts", exc_info=True)
            kg_results = []
    else:
        kg_results = []

    return {
        "recent_messages": recent,
        "semantic_hits": vector_results,
        "kg_facts": kg_results,
    }


def _format_kg_facts(kg_results) -> list[str]:
    """把 Neo4j paths 转成可读 facts。

    兼容 cached 模式：_refresh_kg_cache 已把格式化结果存进缓存（list[str]），
    直接透传，避免对字符串再次走 `rec["path"]` 报错。
    """
    if kg_results and isinstance(kg_results[0], str):
        return kg_results[:10]
    facts = []
    for rec in kg_results or []:
        try:
            path = rec["path"]
            if hasattr(path, "relationships"):
                for rel in path.relationships:
                    facts.append(f"{rel.start_node.get('name')} {rel.type} {rel.end_node.get('name')}")
            else:
                facts.append(str(path))
        except Exception:
            continue
    return facts[:10]


async def _refresh_kg_cache(user_id: str, session_id: str, query: str,
                            extract_cfg: dict | None) -> None:
    """后台刷新会话级 KG facts 缓存（聊天提速：KG 检索从主链路移出）。

    提取实体 → 查子图 → 格式化 → 写 _KG_CACHE[(user_id, session_id)]，下一轮检索生效。
    失败静默降级（保持旧缓存）；缓存超 200 条按会话淘汰最旧（不整体清空）。
    """
    if not extract_cfg:
        return
    try:
        entities = await llm.extract_entities_from_text(query, model_config=extract_cfg)
        if not entities:
            # 抽取失败/为空：跳过子图查询，避免整句污染图谱（03 §8）
            _evict_oldest_kg_cache()
            _KG_CACHE[(user_id, session_id)] = []
            return
        kg_results = await asyncio.to_thread(
            kg.query_subgraph, user_id=user_id, entity_names=entities, depth=1,
        )
        facts = _format_kg_facts(kg_results)
        # 容量控制：超 200 条按会话淘汰最旧（dict 保序，逐个删最旧直到 160），
        # 不再整体清空——整体清空会让活跃会话下一轮丢失记忆，且冷热会话一起被清。
        _evict_oldest_kg_cache()
        _KG_CACHE[(user_id, session_id)] = facts
    except Exception:
        logger.warning("KG cache refresh failed, degraded (keep old cache)", exc_info=True)


def _attachments_meta(attachments: list[dict]) -> str:
    """附件元数据 JSON：[{name,kind,size}]，图片不存二进制（12 §2）。

    额外透传 file_key/message_id：供按需拉取「再分析最近文件」使用。普通聊天页附件无这两个键。
    """
    return json.dumps(
        [{
            "name": a.get("name", ""),
            "kind": a.get("kind", ""),
            "size": a.get("size", 0),
            "file_key": a.get("file_key", ""),
            "message_id": a.get("message_id", ""),
        } for a in attachments or []],
        ensure_ascii=False,
    )


def _compose_user_text(user_text: str, attachments: list[dict]) -> str:
    """用户消息的落库/展示文本：只含用户原文 + 附件名说明，不含文本类附件提取的正文。

    2026-08-15 修复：PDF/Word/Excel 等提取的全文只进 LLM 上下文（_compose_llm_text），
    不拼进持久化内容，避免用户对话框被整篇文档文字刷屏、记忆被文档内容污染。
    """
    parts = []
    if user_text and user_text.strip():
        parts.append(user_text.strip())
    for a in attachments or []:
        name = a.get("name", "附件")
        if a.get("kind") == "image":
            parts.append(f"[附件：{name}（图片）]")
        else:
            parts.append(f"[附件：{name}]")
    return "\n".join(parts)


def _compose_llm_text(user_text: str, attachments: list[dict]) -> str:
    """LLM 上下文用文本：用户原文 + 附件名说明 + 文本类附件（text/pdf/word/excel）提取的正文。

    图片附件只记「[附件：name（图片）]」说明（图像本体走多模态通道）。
    """
    parts = []
    if user_text and user_text.strip():
        parts.append(user_text.strip())
    for a in attachments or []:
        name = a.get("name", "附件")
        if a.get("kind") == "image":
            parts.append(f"[附件：{name}（图片）]")
        else:
            txt = (a.get("text") or "").strip()
            parts.append(f"[附件：{name}]\n{txt}" if txt else f"[附件：{name}]")
    return "\n".join(parts)


def _build_user_content(query: str, attachments: list[dict] | None,
                        image_descriptions: list[str] | None = None):
    """构造 user 消息 content：有图片附件时返回多模态数组，否则纯文本。

    文本类附件（text/pdf/word/excel）把提取的文字拼进文本，供模型分析并进入记忆；
    展示/落库文本仍只含用户原文（_compose_user_text，见 12 §2 修复）。

    image_descriptions（视觉桥接，12 §8.3）：对话模型不支持视觉时，把图片本体
    替换为视觉模型生成的文字描述，拼成纯文本发给对话模型——0.6B 纯文本小亦模型
    读描述远比读图可靠，且不需要图片走多模态通道。
    """
    images = [a for a in (attachments or []) if a.get("kind") == "image" and a.get("data_url")]
    user_text = _compose_llm_text(query, attachments or []) or "（发送了文件）"
    if not images:
        return user_text
    if image_descriptions:
        desc_lines = [d for d in image_descriptions if d.strip()]
        if desc_lines:
            return f"{user_text}\n[图片内容]\n" + "\n".join(desc_lines)
    content = [{"type": "text", "text": user_text}]
    for img in images:
        content.append({"type": "image_url", "image_url": {"url": img["data_url"]}})
    return content


def _has_image(attachments: list[dict] | None) -> bool:
    return any(a.get("kind") == "image" for a in (attachments or []))


def _media_not_supported_reply(chat_cfg: dict | None) -> str:
    """模型不支持图片时的聊天式友好回复（12 §4，绝不上屏报错代码）。"""
    model_name = (chat_cfg or {}).get("model") or "当前模型"
    return (
        f"很抱歉，我当前使用的模型（{model_name}）不支持识别图片。您可以更换支持视觉的模型"
        "（如 gpt-4o、qwen-vl），或上传文字类文件（PDF/Word/Excel）供我分析。"
    )


def _build_messages(query: str, memory: dict, attachments: list[dict] | None = None,
                    image_descriptions: list[str] | None = None) -> list[dict]:
    lines = []
    semantic = memory.get("semantic_hits") or {}
    for doc, meta in zip(
        semantic.get("documents") or [],
        semantic.get("metadatas") or [],
    ):
        src = meta.get("source", "")
        if src == "sql_archive_summary":
            lines.append(f"[归档摘要] {doc}")
        elif not meta.get("is_archived"):
            lines.append(f"[相关记忆] {doc}")

    kg_facts = _format_kg_facts(memory.get("kg_facts"))
    for f in kg_facts:
        lines.append(f"[图谱事实] {f}")

    memory_text = "\n".join(lines)
    recent = memory.get("recent_messages") or []

    messages = [{
        "role": "system",
        "content": _SYSTEM_PROMPT.format(memory_text=memory_text or "（无相关记忆）"),
    }]
    for m in recent[-6:]:
        messages.append({"role": m["role"], "content": m["content"]})
    messages.append({"role": "user", "content": _build_user_content(query, attachments, image_descriptions)})
    return messages


async def _build_messages_bridge(query: str, memory: dict, attachments: list[dict] | None,
                                 vision_cfg: dict) -> list[dict]:
    """视觉桥接降级：对话模型拒图（VisionNotSupportedError）后，把图片转文字描述。

    对每张图片调用视觉模型 describe_image，得到中文画面描述后拼进 user 消息，
    替换原本的多模态 image_url——纯文本对话模型（如小亦 0.6B）读描述组织回复。
    描述失败（视觉模型也不可用）时降级为固定占位文案，不让桥接本身抛异常。
    """
    descs: list[str] = []
    for a in (attachments or []):
        if a.get("kind") == "image" and a.get("data_url"):
            info = await llm.describe_image(a["data_url"], model_config=vision_cfg)
            descs.append(info.get("description") or "（这张图片我看不太清楚）")
    return _build_messages(query, memory, attachments=attachments, image_descriptions=descs)


def _model_configs(db: DbSession | None, user_id: str) -> dict:
    """固定模型配置（env 写死，见 01 §4 / 02 §7）：chat / extract / embedding 三槽位。

    2026-08-27 起不再读取设置页数据库分配（FunctionAssignment / Model 表）：
    - chat      = XIAOYI_CHAT_MODEL      本地微调说话风格模型
    - extract   = XIAOYI_EXTRACT_MODEL   本地千问 qwen3:0.6b（记忆抽取 / 三元组审核；09-03 曾升 4b，09-04
                因 4G 显存三方互踢降回 0.6b，见台账 41 节）
    - embedding = XIAOYI_EMBEDDING_MODEL 本地 bge（向量化）
    统一走 XIAOYI_OLLAMA_BASE_URL（容器内由 _ensure_v1 自动解析为宿主机）。
    恒返回三槽位非 None 配置，无需再判断「未配置」（保留调用侧 None 分支作兜底）。
    """
    from app.config import (XIAOYI_CHAT_MODEL, XIAOYI_EXTRACT_MODEL,
                            XIAOYI_EMBEDDING_MODEL, XIAOYI_VISION_MODEL,
                            XIAOYI_OLLAMA_BASE_URL)
    from app.core.llm_provider import _ensure_v1
    base_url = _ensure_v1(XIAOYI_OLLAMA_BASE_URL)
    return {
        "chat": {
            "model": XIAOYI_CHAT_MODEL,
            "base_url": base_url,
            "api_key": "",
            # 2026-08-28 修复逻辑不通顺：0.6B 微调模型温度过高（原兜底 0.7）会导致
            # 回复发散、前言不搭后语；实测 0.3 时上下文贴合度明显更好。
            # 2026-09-03 上浮至 0.4：0.3 确定性过高，配合模板语料 + 上下文回声导致
            # "复读尾巴"雪球（逐字抄上轮结尾）；0.4 掺入随机性跳出复读，1.7B 不虞发散。
            # repeat_penalty / repeat_last_n 走 Modelfile PARAMETER（Ollama OpenAI 兼容
            # 端点不识别 llama.cpp 特有参数，请求体只传 temperature/max_tokens）。
            "temperature": 0.4,
            "max_tokens": None,
            # keep_alive（2026-09-03，语音二轮卡顿根治→2026-09-03 永久驻留决策）：chat 每轮必用，
            # 语义上应永久驻留（写 -1 表达意图）。注意：chat 走 OpenAI 兼容 /v1/chat/completions，
            # Ollama 的 /v1 端点不识别 keep_alive 字段（台账 35 节实锤：extract 设 30s 却驻留 10 分钟），
            # 实际驻留由宿主机 OLLAMA_KEEP_ALIVE=-1 决定（见台账 36 节：本机 4G 显存，chat+bge-m3
            # 同驻 ~3G 可容，开机即加载、永不再冷；extract 必须小模型才不挤爆，见 41 节）。
            "keep_alive": "-1",
        },
        "extract": {
            "model": XIAOYI_EXTRACT_MODEL,
            "base_url": base_url,
            "api_key": "",
            "temperature": 0.2,
            "max_tokens": 1024,
            # keep_alive=30s（2026-09-03）：抽取/审核仅在 lull-gate 停聊间隙跑（60s），
            # 瞬时任务用完即走（30s 后卸载），不占驻留位——4G 显存留给 chat+bge-m3 常驻
            #（宿主 OLLAMA_KEEP_ALIVE=-1 + MAX_LOADED_MODELS=3 下 qwen3:0.6b 只临时加载；
            # 41 节更正：曾用 2.5G 的 qwen3:4b 把显存挤爆致三方互踢，已降回 0.6b）。
            "keep_alive": "30s",
        },
        "embedding": {
            "model": XIAOYI_EMBEDDING_MODEL,
            "base_url": base_url,
            "api_key": "",
            # keep_alive=-1（2026-09-03 永久驻留决策，台账 36 节）：读侧检索每轮必用
            #（retrieve_memory 翻记忆）+ 写侧后台向量，永久驻留消灭换载抖动。此参数由
            # chroma_client 走 Ollama 原生 /api/embed 携带且真实生效（/v1 才失效）——
            # 必须写 -1，否则请求级 keep_alive=30m 会盖过宿主机 -1，bge-m3 停聊 30 分钟
            # 仍被卸（旧 30m 与"永不冷启动"矛盾，见台账 35/36 节）。
            # 2026-09-04 起写**整数 -1**（事故注记，台账 9月4日 40 节）：宿主机 Ollama 升级
            # 0.33.2 后对原生 /api/embed 的 keep_alive 做严格类型校验，字符串 "-1" 被拒返回
            # HTTP 400（embedding api error，记忆读写全降级）；整数 -1 才被接受。chat/extract
            # 的字符串值走 /v1 端点不受影响，仅原生 /api/embed 需整数。
            "keep_alive": -1,
        },
        # 视觉模型（12 §2.2 双模型级联的视觉侧）：看图 → 中文画面描述 + 场景判定，
        # 供对话模型用小亦口吻组织回复。独立低温度保证判定稳定。
        "vision": {
            "model": XIAOYI_VISION_MODEL,
            "base_url": base_url,
            "api_key": "",
            "temperature": 0.1,
            "max_tokens": 1024,
            # keep_alive=30s（2026-09-03）：视觉按需触发，用完即走不占驻留位。
            "keep_alive": "30s",
        },
    }


def _resolve_chat_model_config(db: DbSession | None, user_id: str) -> dict | None:
    """返回聊天模型配置（env 写死，恒有配置；保留返回 None 语义作兼容兜底）。"""
    return _model_configs(db, user_id)["chat"]


async def chat(text: str, user_id: str, session_id: str, source: str,
               attachments: list[dict] | None = None) -> tuple[str, str]:
    """统一聊天入口：检索三层记忆 → LLM 生成 → 三存储同步持久化。

    - user_id: 记忆检索与持久化的隔离维度（必传）
    - session_id: 当前会话
    - source: web / desktop
    - attachments: 附件解析结果（12 §），图片走多模态、文本类拼入 user 消息
    - 对话模型未配置时抛 ChatModelNotConfigured（前端提示到设置页配置）。
    - 用户消息在 LLM 调用前先行落库，LLM 失败也不丢记录。
    - 模型不支持图片（VisionNotSupportedError）时以聊天式友好回复返回，不抛异常。
    返回 (reply, 实际使用的 session_id)——ensure_session 可能新建会话（软删/无效时自愈）。
    """
    session_id = sql.ensure_session(user_id, session_id, source)
    from app.db.database import SessionLocal
    with SessionLocal() as db:
        cfgs = _model_configs(db, user_id)
    if not cfgs["chat"]:
        raise ChatModelNotConfigured()
    msg_id = await _persist_user(user_id, session_id, text, source,
                                 embedding_cfg=cfgs["embedding"],
                                 attachments=attachments)
    exclude_ids = {msg_id} if msg_id else None

    memory = await retrieve_memory(_memory_query(text, attachments), user_id, session_id,
                                   embedding_cfg=cfgs["embedding"],
                                   extract_enabled=bool(cfgs["extract"]),
                                   extract_cfg=cfgs["extract"],
                                   exclude_ids=exclude_ids,
                                   kg_mode="cached")

    # 再次被提及时刷新历史消息权重（SQL 命中的历史消息）
    await _mention_hits(user_id, session_id, memory)

    messages = _build_messages(text, memory, attachments=attachments)
    try:
        # 快速回复：聊天为第一要务，所有入口统一 low 浅度思考快速回话，不做深度思考
        #（2026-08-28 起全量统一，此前仅 desktop 走 low；AGENTS.md「快速回复」约定）
        reply = await llm.chat(messages, cfgs["chat"], thinking="low")
    except VisionNotSupportedError:
        # 对话模型不支持视觉：图片转文字描述后重试（视觉桥接，12 §8.3）；
        # 仍失败（视觉模型也不可用）才退回聊天式友好回复。
        try:
            messages = await _build_messages_bridge(text, memory, attachments, cfgs["vision"])
            reply = await llm.chat(messages, cfgs["chat"], thinking="low")
        except Exception:
            logger.warning("vision bridge failed, fallback to media reply", exc_info=True)
            reply = _media_not_supported_reply(cfgs["chat"])
    await _persist_reply(user_id, session_id, _compose_user_text(text, attachments or []),
                         reply, source,
                         extract_cfg=cfgs["extract"],
                         embedding_cfg=cfgs["embedding"],
                         chat_cfg=cfgs["chat"])
    return reply, session_id


async def chat_stream(text: str, user_id: str, session_id: str, source: str,
                      attachments: list[dict] | None = None):
    """流式聊天：检索与持久化逻辑与 chat 一致，回复以增量片段产出。

    产出三元组 (delta, thinking, is_media)：is_media=True 时 delta 为模型不支持图片的
    聊天式友好回复（12 §4），由路由层转成 media_reply SSE 帧。
    """
    session_id = sql.ensure_session(user_id, session_id, source)
    from app.db.database import SessionLocal
    with SessionLocal() as db:
        cfgs = _model_configs(db, user_id)
    if not cfgs["chat"]:
        raise ChatModelNotConfigured()
    msg_id = await _persist_user(user_id, session_id, text, source,
                                 embedding_cfg=cfgs["embedding"],
                                 attachments=attachments)
    exclude_ids = {msg_id} if msg_id else None

    memory = await retrieve_memory(_memory_query(text, attachments), user_id, session_id,
                                   embedding_cfg=cfgs["embedding"],
                                   extract_enabled=bool(cfgs["extract"]),
                                   extract_cfg=cfgs["extract"],
                                   exclude_ids=exclude_ids,
                                   kg_mode="cached")
    await _mention_hits(user_id, session_id, memory)

    messages = _build_messages(text, memory, attachments=attachments)

    reply_parts: list[str] = []
    thinking_parts: list[str] = []
    try:
        try:
            # 快速回复：聊天为第一要务，所有入口统一 low 浅度思考快速回话，不做深度思考
            #（2026-08-28 起全量统一，此前仅 desktop 走 low；AGENTS.md「快速回复」约定）
            async for delta, thinking in llm.chat_stream(messages, cfgs["chat"], thinking="low"):
                reply_parts.append(delta)
                thinking_parts.append(thinking)
                yield delta, thinking, False
        except VisionNotSupportedError:
            # 对话模型不支持视觉：图片转文字描述后重试（视觉桥接，12 §8.3）；
            # 仍失败（视觉模型也不可用）才退回聊天式友好回复。
            try:
                messages = await _build_messages_bridge(text, memory, attachments, cfgs["vision"])
                async for delta, thinking in llm.chat_stream(messages, cfgs["chat"], thinking="low"):
                    reply_parts.append(delta)
                    thinking_parts.append(thinking)
                    yield delta, thinking, False
            except Exception:
                logger.warning("vision bridge failed, fallback to media reply", exc_info=True)
                # 模型不支持图片：以聊天式回复呈现，照常落库（12 §4）
                reply = _media_not_supported_reply(cfgs["chat"])
                reply_parts = [reply]
                yield reply, "", True
    finally:
        # 流结束（正常或异常）后持久化回复；用户消息已在上方先行落库。
        # 空回复（LLM 中途异常未产出任何内容）不落库——避免落一条空白 assistant 消息，
        # 与非流式 chat 路径（异常时不落库）行为保持一致。
        final_reply = "".join(reply_parts)
        if not final_reply.strip():
            # 探针（2026-09-04，台账 40 节）：零 delta SSE 空回复（前端"一直思考中不出字"）。
            # 两类成因：LLM 正常流结束但零产出（Ollama 空回），或上游异常未产出任何内容
            #（此时 api/chat.py 还会另记一条 chat_stream error，可对照区分）。此前静默吞掉
            # 难以定性，故打 warning 暴露。
            logger.warning(
                "chat_stream empty reply (0 delta): user=%s session=%s reply_parts=%d thinking_len=%d",
                user_id, session_id, len(reply_parts), sum(len(t) for t in thinking_parts),
            )
        if final_reply.strip():
            await _persist_reply(user_id, session_id, _compose_user_text(text, attachments or []),
                                 final_reply, source,
                                 extract_cfg=cfgs["extract"],
                                 embedding_cfg=cfgs["embedding"],
                                 thinking="".join(thinking_parts),
                                 chat_cfg=cfgs["chat"])


def _memory_query(text: str, attachments: list[dict] | None) -> str:
    """记忆检索的 query：优先用户文字；仅上传文件时用首个文本附件的开头。"""
    if text and text.strip():
        return text.strip()[:2000]
    for a in (attachments or []):
        if a.get("text"):
            return a["text"][:2000]
    return text or ""


async def chat_media_reply(user_id: str, session_id: str, user_text: str, reply: str,
                           source: str, attachments: list[dict]) -> str:
    """媒体类（无法识别的文件类型）固定友好回复的轻量持久化。

    与正常聊天一致：用户消息先行落库、回复后落库、自动标题；不调用 LLM。
    返回实际 session_id（ensure_session 自愈）。
    """
    session_id = sql.ensure_session(user_id, session_id, source)
    from app.db.database import SessionLocal
    with SessionLocal() as db:
        cfgs = _model_configs(db, user_id)
    content = _compose_user_text(user_text, attachments or []) or "（发送了文件）"
    # 2026-09-03：与 _persist_user/_persist_reply 对齐——SQL 同步落库，向量后台异步写
    #（避免 embedding 慢/超时拖住请求；此处非流式路径同样受益）
    user_msg_id = await asyncio.to_thread(
        sql.save_message_sql_only,
        user_id=user_id, session_id=session_id, role="user", content=content,
        source=source, attachments=_attachments_meta(attachments or []),
    )
    reply_msg_id = await asyncio.to_thread(
        sql.save_message_sql_only,
        user_id=user_id, session_id=session_id, role="assistant", content=reply,
        source=source,
    )
    if cfgs["embedding"] and user_msg_id:
        _spawn_background(_async_upsert_vector(user_id, session_id, content, source,
                                               user_msg_id, cfgs["embedding"]))
    if cfgs["embedding"] and reply_msg_id:
        _spawn_background(_async_upsert_vector(user_id, session_id, reply, source,
                                               reply_msg_id, cfgs["embedding"]))
    if cfgs["chat"]:
        _spawn_background(_maybe_auto_title(user_id, session_id, content, cfgs["chat"]))
    return session_id


async def vision_analyze(user_id: str, session_id: str, source: str, data_url: str,
                         user_query: str = "", chat_cfg: dict | None = None,
                         vision_cfg: dict | None = None) -> str:
    """视觉分析统一入口（12 §8.3）：图片 → 视觉描述 → 小亦口吻回复 → 落库 + 写记忆。

    用于触发/上传模式：用户说「快看快看」或上传图片时，把画面描述 + 用户话语
    一起交给小亦模型，用小亦的人设口吻组织回复。返回回复文本。

    - data_url：图片 base64 data url；
    - user_query：用户附带话语（触发词/提问），为空表示小亦主动搭话（vision_proactive_talk 复用）；
    - chat_cfg / vision_cfg：不传则取 env 固定配置（_model_configs）。
    """
    session_id = sql.ensure_session(user_id, session_id, source)
    from app.db.database import SessionLocal
    with SessionLocal() as db:
        cfgs = _model_configs(db, user_id)
    chat_cfg = chat_cfg or cfgs["chat"]
    vision_cfg = vision_cfg or cfgs["vision"]

    info = await llm.describe_image(data_url, model_config=vision_cfg)
    desc = (info.get("description") or "").strip() or "（这张图片我看不太清楚）"

    # 用户侧输入落库（画面描述随消息进入记忆链路；主动搭话时占位"看到画面"）
    user_text = (user_query.strip() or "（小亦看到的画面）")
    user_content = f"{user_text}\n[画面] {desc}"
    await _persist_user(user_id, session_id, user_content, source,
                        embedding_cfg=cfgs["embedding"])

    if user_query.strip():
        prompt = f"小亦眼前看到的画面：{desc}\n用户说：{user_query.strip()}"
    else:
        prompt = f"小亦眼前看到的画面：{desc}\n小亦可以自然地评论一句看到的东西，简单亲切即可。"

    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT.format(memory_text="（无相关记忆）")},
        {"role": "user", "content": prompt},
    ]
    reply = await llm.chat(messages, chat_cfg, thinking="low")

    await _persist_reply(user_id, session_id, user_content, reply, source,
                         extract_cfg=cfgs["extract"],
                         embedding_cfg=cfgs["embedding"],
                         chat_cfg=chat_cfg)
    return reply


async def vision_proactive_talk(user_id: str, session_id: str, source: str, data_url: str,
                                photo_id: str, chat_cfg: dict | None = None,
                                vision_cfg: dict | None = None) -> str | None:
    """主动搭话（12 §4）：小亦主动对"好看、不私密、值得说"的画面说一句话。

    与 vision_analyze 同链路，仅 user_query 为空（无用户输入）。搭话后把对应
    Photo 标记 spoken=True，防止同一张照片反复搭话。返回回复文本。
    """
    reply = await vision_analyze(user_id, session_id, source, data_url,
                                 user_query="", chat_cfg=chat_cfg, vision_cfg=vision_cfg)
    if photo_id:
        from app.db.database import SessionLocal
        def _mark_spoken() -> None:
            with SessionLocal() as db:
                from app.db.sql_models import Photo
                p = db.query(Photo).filter_by(id=photo_id, user_id=user_id).first()
                if p:
                    p.spoken = True
                    db.commit()
        await asyncio.to_thread(_mark_spoken)
    return reply


async def _mention_hits(user_id: str, session_id: str, memory: dict) -> None:
    """对检索命中的历史消息刷新权重（02 §6 调用时机说明）。

    同步 DB 刷新下沉线程池（2026-08-24 统一），防权重刷新阻塞事件循环。
    """
    try:
        ids = []
        for meta in (memory.get("semantic_hits") or {}).get("metadatas") or []:
            if meta.get("source") in ("sql_archive", "sql_archive_summary"):
                continue
            if meta.get("original_id") and not meta.get("is_archived"):
                ids.append(meta["original_id"])
        if not ids:
            return
        await asyncio.to_thread(_mention_hits_sync, user_id, ids)
    except Exception:
        # 权重刷新异常不影响主流程（SQL 只读刷新，失败降级）
        logger.warning("mention hits refresh failed, degraded", exc_info=True)


def _mention_hits_sync(user_id: str, ids: list) -> None:
    """同步刷新命中消息权重（独立 DB 会话）。"""
    from app.db.database import SessionLocal
    try:
        with SessionLocal() as db:
            for m in db.query(Message).filter(Message.id.in_(ids), Message.user_id == user_id).all():
                mention_message(db, m)
            db.commit()
    except Exception:
        logger.warning("mention hits sync refresh failed", exc_info=True)


async def _persist_user(user_id: str, session_id: str, user_text: str, source: str,
                        embedding_cfg: dict | None = None,
                        attachments: list[dict] | None = None) -> str:
    """用户消息先行落库（LLM 调用前执行）：SQL 原文同步，Chroma embedding 后台异步。

    保证 LLM 生成失败/被中断时用户说的话也已进入三层数据，不丢记录。
    附件文本类拼入 content，元数据写入 Message.attachments（12 §）。
    返回已落库消息 id（2026-08-24 起，供检索/拼上下文时排除当前消息防重复注入）。

    首字提速（2026-08-28）：SQL 落库同步保证可靠性；当前消息当轮已被 exclude_ids
    排除在检索外，其向量对当轮回复无意义，改为 _spawn_background 后台写 Chroma，
    首字前不再同步等一次 embedding（bge-m3 约 2~5s）。
    """
    content = _compose_user_text(user_text, attachments or []) or "（发送了文件）"
    attachments_json = _attachments_meta(attachments or [])
    _note_user_activity(user_id, session_id)  # lull-gate：记录发言时刻，KG 写入据此让路（34 节）
    msg_id = await asyncio.to_thread(
        sql.save_message_sql_only,
        user_id=user_id, session_id=session_id, role="user", content=content,
        source=source, attachments=attachments_json,
    )
    if embedding_cfg and msg_id:
        _spawn_background(_async_upsert_vector(user_id, session_id, content, source,
                                               msg_id, embedding_cfg))
    return msg_id or ""


async def _async_upsert_vector(user_id: str, session_id: str, content: str, source: str,
                               msg_id: str, embedding_cfg: dict) -> None:
    """后台写用户消息的 Chroma 向量（_persist_user 异步路径，失败不阻断聊天主流程）。"""
    try:
        await asyncio.to_thread(
            chroma.upsert,
            ids=[f"msg_{msg_id}"],
            documents=[content],
            metadatas=[{
                "user_id": user_id, "session_id": session_id, "source": source,
                "original_id": msg_id, "is_archived": False,
            }],
            user_id=user_id, embedding_cfg=embedding_cfg,
        )
    except Exception:
        logger.warning("chroma upsert failed, degraded (skip vector write)", exc_info=True)


def _spawn_background(coro) -> None:
    """把协程作为后台任务执行（聊天提速：耗时后处理不阻塞 SSE [DONE] 帧）。

    持有引用防止任务被 GC；done 后自动从集合移除；异常只记日志不冒泡。
    """
    async def _safe() -> None:
        try:
            await coro
        except Exception:
            logger.warning("background task failed", exc_info=True)

    task = asyncio.create_task(_safe())
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)


async def _persist_reply(user_id: str, session_id: str, user_text: str, reply: str, source: str,
                         extract_cfg: dict | None = None,
                         embedding_cfg: dict | None = None,
                         thinking: str = "",
                         chat_cfg: dict | None = None) -> None:
    """回复持久化：SQL 同步落库 + Chroma embedding 后台异步写（2026-09-03 改），
    耗时后处理（自动标题 / KG 三元组 / KG 检索缓存刷新）同样后台，不阻塞 SSE [DONE] 帧。

    - extract_cfg 为空（未配置记忆抽取模型）→ 跳过三元组抽取与 KG 写入。
    - thinking 为模型思考过程，随 assistant 消息一起入库（05 §12）。
    - KG/Chroma 任一失败均不阻断 SQL 主流程（日志告警）。
    - chat_cfg 非空且会话标题仍为「新会话」时触发自动标题（07 §6）。

    2026-09-03 提速修复：此前同步调 save_chat_message（SQL + 向量一起），回复向量
    生成连 Ollama bge-m3 可达几十秒（httpx 60s 超时），[DONE] 帧被拖住 → 前端一直
    "思考中"卡死。改为对齐 _persist_user：SQL 同步落库（快），向量 _spawn_background
    后台写——回复向量下一轮检索才用到，当轮收尾不等它。
    """
    # SQL 同步落库（不碰 Chroma，快）；向量后台异步写
    msg_id = await asyncio.to_thread(
        sql.save_message_sql_only,
        user_id=user_id, session_id=session_id, role="assistant", content=reply,
        source=source, attachments="", thinking=thinking,
    )
    if embedding_cfg and msg_id:
        _spawn_background(_async_upsert_vector(user_id, session_id, reply, source,
                                               msg_id, embedding_cfg))

    # 自动会话标题：仅当标题仍是「新会话」时触发（后台，与提炼/向量化模型无关）
    if chat_cfg:
        _spawn_background(_maybe_auto_title(user_id, session_id, user_text, chat_cfg))

    # KG 三元组抽取 + 缓存刷新（2026-09-03 改：不再回复结束立即跑，改"停聊间隙"
    # _schedule_memory_worker——qwen3:4b 即时抽取会踢掉交互模型导致第二句卡，见 34 节）
    _schedule_memory_worker(user_id, session_id, user_text, extract_cfg)


async def _persist_kg(user_id: str, user_text: str, extract_cfg: dict) -> None:
    """KG 三元组抽取 + 图谱写入（后台任务，失败不阻断聊天主流程）。"""
    from app import config  # 函数级 import：读 KG_MIN_TEXT_LEN（03 §3）

    # 寒暄/口误等超短文本不抽取（如"在吗/在妈/嗯"），防图谱愣存垃圾节点（03 §3）
    if len((user_text or "").strip()) <= config.KG_MIN_TEXT_LEN:
        return
    try:
        triples = await llm.extract_triples(user_text, model_config=extract_cfg)
        if not triples:
            return
        # 同 (sub,pred,obj) 只落一次（2026-09-03，防一轮对话重复建边）
        seen, uniq = set(), []
        for sub, pred, obj, obj_kind in triples:
            key = (sub, pred, obj)
            if key not in seen:
                seen.add(key)
                uniq.append((sub, pred, obj, obj_kind))
        # 自我节点：实体经「提到」边直连用户，保证整图与用户节点连通（03 §9）
        self_id = await asyncio.to_thread(kg.get_or_create_self_node, user_id)
        for sub, pred, obj, obj_kind in uniq:
            # merge_entity：自称（我/我的/本人）、机器人指代（小亦/你）或与昵称同名的实体
            # 归并到自我/机器人节点，避免重复节点（03 §6）；宾语按 objectKind 分 Person/Thing
            sub_id = await asyncio.to_thread(kg.merge_entity, sub, "Person", user_id)
            obj_id = await asyncio.to_thread(
                kg.merge_entity, obj, "Person" if obj_kind == "person" else "Thing", user_id,
            )
            await asyncio.to_thread(kg.link, sub_id, pred, obj_id, user_id=user_id)
            await asyncio.to_thread(kg.link, self_id, "提到", sub_id, user_id=user_id)
            await asyncio.to_thread(kg.link, self_id, "提到", obj_id, user_id=user_id)
    except Exception:
        # 图谱写入失败不阻断聊天（SQL/Chroma 已落盘，KG 可后续经遗忘蒸馏补齐）
        logger.warning("KG persist failed", exc_info=True)


async def _maybe_auto_title(user_id: str, session_id: str, user_text: str,
                            chat_cfg: dict) -> None:
    """用聊天模型把对话内容概括为会话标题（≤12 字）；失败/过短时回退截断前 15 字。

    幂等：仅当标题仍为「新会话」才更新，生成成功后不再重复触发（07 §6）。
    同步 DB 读写下沉线程池（2026-08-24 统一）。
    """
    def _title_needed() -> bool:
        from app.db.database import SessionLocal
        with SessionLocal() as db:
            session = db.query(SessionModel).filter_by(
                id=session_id, user_id=user_id, is_deleted=False
            ).first()
            return bool(session and session.title == "新会话")

    if not await asyncio.to_thread(_title_needed):
        return

    fallback = user_text.strip().replace("\n", " ")[:15]
    title = fallback
    try:
        prompt = (
            "请为下面的对话内容生成一个简短的中文标题，不超过 12 个字，"
            "不要加标点、引号或解释：\n" + user_text[:200]
        )
        raw = await llm.chat([{"role": "user", "content": prompt}], chat_cfg)
        cleaned = (raw or "").strip().strip('"').strip("“”").strip("「」").strip("'").strip("。")
        if cleaned and len(cleaned) <= 20:
            title = cleaned
    except Exception:
        logger.warning("auto title generation failed, use fallback", exc_info=True)

    def _apply_title() -> None:
        from app.db.database import SessionLocal
        with SessionLocal() as db:
            # 第二个查询同样过滤 is_deleted（软删除会话不应被"复活"更新标题，AGENTS.md 约定）
            session = db.query(SessionModel).filter_by(
                id=session_id, user_id=user_id, is_deleted=False
            ).first()
            if session and session.title == "新会话" and title:
                session.title = title
                db.commit()

    await asyncio.to_thread(_apply_title)


# chat_core 命名空间（10 §4 webhook 引用 `chat_core.chat(...)`，内部等价于 /api/chat 非流式）
from types import SimpleNamespace

chat_core = SimpleNamespace(
    chat=chat, chat_stream=chat_stream, chat_media_reply=chat_media_reply,
    vision_analyze=vision_analyze, vision_proactive_talk=vision_proactive_talk,
)

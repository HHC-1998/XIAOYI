"""全局配置：所有环境变量在此汇总，供各模块引用（文档中 `config.xxx` 即本模块）。

- 本地开发可直接用默认值；Docker 部署时由 compose 注入环境变量覆盖（见 06）。
- 模型库（settings）与 LLM 相关配置见 app/core/llm_provider.py。
"""
import os


def _int(name: str, default: int) -> int:
    return int(os.getenv(name, default))


def _float(name: str, default: float) -> float:
    return float(os.getenv(name, default))


# ---------- 数据库 ----------
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./xiaoyi.db")
# compose 内：postgresql://xiaoyi:PASS@postgres:5432/xiaoyi（见 06 §3）

# ---------- Chroma ----------
CHROMA_HOST = os.getenv("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.getenv("CHROMA_PORT", "8001"))  # compose 内为 8000，本地直连为 8001
CHROMA_COLLECTION_PREFIX = "user_"  # collection 按 user_id 隔离：user_{user_id}

# ---------- Neo4j ----------
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "xiaoyi_pass")
KG_MERGE_THRESHOLD = _float("KG_MERGE_THRESHOLD", 0.88)  # 实体去重余弦阈值（03 §5）

# ---------- LLM ----------
# 2026-08-27 起模型固定走本地（env 写死，见 01 §4 / 02 §7 / 06 §4）：
#   chat      = 本地微调说话风格模型
#   extract   = 本地千问（记忆抽取 / 三元组审核；2026-09-03 由 0.6b 升 4b，09-04 因 4G 显存
#               三方互踢降回 0.6b，见台账 41 节）
#   embedding = 本地 bge（向量化）
# 统一走本地 Ollama（XIAOYI_OLLAMA_BASE_URL），不再读取设置页模型库 / 功能分配，
# 也不再使用任何云端 API。OPENAI_API_KEY 仅为兼容保留（写死模型均不需要）。
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
XIAOYI_OLLAMA_BASE_URL = os.getenv("XIAOYI_OLLAMA_BASE_URL", "http://localhost:11434")
XIAOYI_CHAT_MODEL = os.getenv("XIAOYI_CHAT_MODEL", "xiaoyi")
XIAOYI_EXTRACT_MODEL = os.getenv("XIAOYI_EXTRACT_MODEL", "qwen3:0.6b")
XIAOYI_EMBEDDING_MODEL = os.getenv("XIAOYI_EMBEDDING_MODEL", "bge-m3")

# ---------- 视觉功能（12 §8.1） ----------
# 视觉模型固定走本地 Ollama：看图 → 中文画面描述 + 场景判定，供小亦模型用小亦口吻回复。
# XIAOYI_VISION_ENABLED 为部署级总闸（默认 1=功能可用；设 0 可彻底禁用视觉）；
# 用户级开关（User.vision_enabled，UI 控制）控制摄像头是否打开（12 §5 隐私保护）。
XIAOYI_VISION_MODEL = os.getenv("XIAOYI_VISION_MODEL", "qwen2.5vl:3b")
XIAOYI_VISION_INTERVAL = _int("XIAOYI_VISION_INTERVAL", 120)   # 主动轮询间隔（秒），默认 2 分钟
XIAOYI_VISION_ENABLED = os.getenv("XIAOYI_VISION_ENABLED", "1") == "1"  # 部署级总闸
XIAOYI_VISION_CAP = _int("XIAOYI_VISION_CAP", 1000)            # 环形缓冲上限（每用户照片数）
XIAOYI_VISION_FAV_CAP = _int("XIAOYI_VISION_FAV_CAP", 100)     # 收藏照片上限（超出不再新增）
XIAOYI_VISION_TALK_EVERY = _int("XIAOYI_VISION_TALK_EVERY", 150)  # 主动搭话周期（拍约 N 张才考虑一次）

# ---------- TTS（04 §9，edge-tts 在线合成） ----------
# 2026-09-03 十八轮：piper 本地合成（机械朗读）换回微软 edge-tts 在线神经语音；十九轮后音色定为晓伊。
# TTS 为 AGENTS.md「不接任何云端 API」约定的唯一有意例外（用户确认）；聊天/抽取/向量仍全本地 Ollama。
XIAOYI_TTS_VOICE = os.getenv("XIAOYI_TTS_VOICE", "zh-CN-XiaoyiNeural")  # 晓伊（元气活泼，用户试听选定）；可回晓晓 zh-CN-XiaoxiaoNeural / 云希 YunxiNeural 等
XIAOYI_TTS_RATE = os.getenv("XIAOYI_TTS_RATE", "+10%")    # 语速（用户试听选定，更俏皮）
XIAOYI_TTS_PITCH = os.getenv("XIAOYI_TTS_PITCH", "+0Hz")  # 音调，如 "+5Hz"

# ---------- 流式 ASR（04 §8，sherpa-onnx 边听边出字） ----------
# 模型目录：默认空 = 自动探测 backend/models/sherpa-asr（Docker 构建时排除、compose bind mount 挂入
# /app/models，见 04 §8 / 台账 38/39 节）。可经 env 覆盖指向其他绝对路径。目录须含
# encoder-*.onnx / decoder-*.onnx / joiner-*.onnx / tokens.txt（zipformer transducer 三件套，
# 只支持此族；缺 joiner 视为下载不完整、Python 层报错回退 whisper，绝不自动猜 paraformer，
# 见台账 39 节 C++ abort 事故）。
XIAOYI_STREAM_ASR_DIR = os.getenv("XIAOYI_STREAM_ASR_DIR", "")

# ---------- JWT 认证 ----------
JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = _int("JWT_EXPIRE_HOURS", 24 * 7)

# ---------- 记忆/遗忘参数（02 §5） ----------
ARCHIVE_THRESHOLD = _float("ARCHIVE_THRESHOLD", 0.25)  # 权重低于该值触发归档
MEMORY_LAMBDA = _float("MEMORY_LAMBDA", 0.05)
KG_MIN_TEXT_LEN = _int("KG_MIN_TEXT_LEN", 4)  # 文本长度≤该值时跳过 KG 抽取（寒暄/口误防愣存，03 §3）
WEIGHT_ALPHA = _float("WEIGHT_ALPHA", 0.3)   # recency
WEIGHT_BETA = _float("WEIGHT_BETA", 0.3)     # frequency
WEIGHT_GAMMA = _float("WEIGHT_GAMMA", 0.25)  # importance
WEIGHT_DELTA = _float("WEIGHT_DELTA", 0.15)  # emotion

# ---------- 数据管理（09） ----------
MAX_IMPORT_SIZE = 50 * 1024 * 1024  # 50MB 上限

# ---------- 验证码（mock 模式直接打印/返回） ----------
SMS_MOCK = os.getenv("SMS_MOCK", "1") == "1"  # mock 阶段不发真实短信

# ---------- 遗忘定时任务 ----------
FORGET_INTERVAL_MINUTES = _int("FORGET_INTERVAL_MINUTES", 60)  # 定时遗忘任务间隔

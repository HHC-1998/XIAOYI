"""SQLAlchemy 统一模型（01 §5.1 / 02 §4 / 07 §4 / 10 §5）。

所有主键统一 String(36) uuid；所有业务数据带 user_id 隔离。
"""
from sqlalchemy import Column, String, DateTime, Float, Integer, ForeignKey, Text, Boolean
from sqlalchemy.orm import relationship
from datetime import datetime

from app.db.database import Base


class User(Base):
    __tablename__ = "users"
    id = Column(String(36), primary_key=True)  # uuid
    phone = Column(String(128), unique=True, index=True)  # 手机号
    password_hash = Column(String(256))
    nickname = Column(String(64), default="")  # 默认 f"用户{phone}"
    created_at = Column(DateTime, default=datetime.utcnow)
    # 最近活跃（飞书 webhook 每次消息刷新；2026-08-17 影子机制废弃后仅留作活跃统计）
    last_active_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    # 原供影子账号绑定提醒限频（2026-08-17 影子机制废弃，列保留但不再写入）
    last_reminded_at = Column(DateTime, nullable=True)
    # 视觉模式开关（12 §5 隐私保护）：默认关；关闭时前端不得打开摄像头/轮询拍照
    vision_enabled = Column(Boolean, default=False)


class Session(Base):
    __tablename__ = "sessions"
    id = Column(String(36), primary_key=True)  # uuid
    user_id = Column(String(36), ForeignKey("users.id"), index=True)
    title = Column(String(128), default="新会话")
    source = Column(String(16), default="web")  # web / desktop
    # 软删除标记（2026-08-15 起聊天删除免密软删，数据保留在三库供记忆检索；
    # 设置页「清空数据」仍为硬删除）
    is_deleted = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    messages = relationship(
        "Message", back_populates="session",
        # 排序加 id 次级键：同一秒内 user/assistant 消息多轮时按插入顺序稳定返回
        # 注意：SQLAlchemy 2.0 的 relationship order_by 不接受字符串列表
        #（coercions 把 "Message.created_at" 当 SQL 字面量 → mapper 配置即崩，见当天台账二十四），
        # 须用 lambda 延迟求值返回列元组（Message 定义在本文件靠后，lambda 避免 NameError）
        order_by=lambda: (Message.created_at, Message.id),
    )


class Message(Base):
    __tablename__ = "messages"
    id = Column(String(36), primary_key=True)  # uuid
    session_id = Column(String(36), ForeignKey("sessions.id"), index=True)
    user_id = Column(String(36), ForeignKey("users.id"), index=True)  # 便于跨会话过滤
    role = Column(String(16))  # user / assistant
    content = Column(Text)
    # 模型思考过程（DeepSeek reasoning_content / Ollama thinking），assistant 消息可能有（05 §12）
    thinking = Column(Text, default="")
    # 附件元数据（2026-08-15 起多类型文件上传，12 §）：JSON 字符串 [{name,kind,size}]，
    # 图片仅存元数据不存二进制（二进制只在当次请求发给模型，不落库）
    attachments = Column(Text, default="")
    source = Column(String(16), default="web")
    weight = Column(Float, default=0.5)  # 记忆权重
    importance = Column(Float, default=0.0)
    emotion_score = Column(Float, default=0.0)
    mention_count = Column(Integer, default=1)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_mentioned_at = Column(DateTime, default=datetime.utcnow)
    is_archived = Column(Boolean, default=False)  # False=热记忆 True=已归档
    session = relationship("Session", back_populates="messages")


class Model(Base):
    """模型库（05 §11）：用户为不同功能维护的模型条目。"""
    __tablename__ = "models"
    id = Column(String(36), primary_key=True)  # uuid
    user_id = Column(String(36), ForeignKey("users.id"), index=True)
    name = Column(String(64))
    provider = Column(String(16), default="openai")  # openai / ollama / claude
    base_url = Column(String(256), default="")
    api_key = Column(String(256), default="")
    model = Column(String(64), default="")
    temperature = Column(Float, default=0.7)
    max_tokens = Column(Integer, default=2048)
    capabilities = Column(String(128), default="chat")  # 逗号分隔：chat,extract,embedding
    created_at = Column(DateTime, default=datetime.utcnow)


class FunctionAssignment(Base):
    """功能模型分配：chat_model_id / extract_model_id / embedding_model_id。"""
    __tablename__ = "function_assignments"
    id = Column(String(36), primary_key=True)  # uuid
    user_id = Column(String(36), ForeignKey("users.id"), unique=True, index=True)
    chat_model_id = Column(String(36), default="")
    extract_model_id = Column(String(36), default="")
    embedding_model_id = Column(String(36), default="")
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Photo(Base):
    """视觉照片（12 §6 环形缓冲）：每用户上限 XIAOYI_VISION_CAP 张，超出淘汰最早一张。

    - image 存 base64 数据（本地 SQLite/Postgres 均无压力；gallery 直接内嵌展示）。
    - is_pretty / is_private / worth_speaking 为视觉模型场景判定（12 §4 主动搭话用）。
    - spoken：该照片是否已用于主动搭话（避免反复搭同一张）。
    - is_favorite：用户收藏，收藏照片不参与自动淘汰（上限 XIAOYI_VISION_FAV_CAP）。
    """
    __tablename__ = "photos"
    id = Column(String(36), primary_key=True)  # uuid
    user_id = Column(String(36), ForeignKey("users.id"), index=True)
    image = Column(Text)  # base64 data url
    shot_at = Column(DateTime, default=datetime.utcnow)
    description = Column(Text, default="")   # 视觉模型生成的画面描述
    is_pretty = Column(Boolean, default=False)
    is_private = Column(Boolean, default=False)
    worth_speaking = Column(Boolean, default=False)
    source = Column(String(16), default="poll")  # poll / trigger / upload
    spoken = Column(Boolean, default=False)
    is_favorite = Column(Boolean, default=False)

"""SQLAlchemy 引擎 / SessionLocal / Base（01 §8 目录树 db/database.py）。

被 app/dependencies.py（get_db）引用。
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

from app.config import DATABASE_URL

# SQLite 需 check_same_thread=False 以兼容 FastAPI 线程池；PostgreSQL 无需
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
Base = declarative_base()


def init_db():
    """建表 + 轻量迁移（main.py 启动时调用）。"""
    from app.db import sql_models  # noqa: F401  确保模型已注册
    Base.metadata.create_all(bind=engine)
    _apply_light_migrations()


def _apply_light_migrations():
    """create_all 不会给已存在的表补新列，这里手工补（兼容 SQLite/PostgreSQL）。

    2026-08-15：sessions 表新增 is_deleted（软删除标记）。
    2026-08-15：messages 表新增 thinking（模型思考过程，DeepSeek reasoning_content）。
    """
    from sqlalchemy import inspect, text
    insp = inspect(engine)
    if "sessions" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("sessions")}
        if "is_deleted" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE sessions ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE"))
    if "messages" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("messages")}
        if "thinking" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE messages ADD COLUMN thinking TEXT DEFAULT ''"))
        # 2026-08-15：messages 表新增 attachments（多类型文件上传的附件元数据，12 §）
        if "attachments" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE messages ADD COLUMN attachments TEXT DEFAULT ''"))
    if "users" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("users")}
        # 2026-08-16：飞书影子账号生命周期管理（10 §5）——last_active_at 活跃刷新、last_reminded_at 提醒限频
        # 注意用 TIMESTAMP：PostgreSQL 不认 MySQL 的 DATETIME 类型（SQLite 两者皆可）
        if "last_active_at" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN last_active_at TIMESTAMP"))
        if "last_reminded_at" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN last_reminded_at TIMESTAMP"))
        # 2026-08-28：视觉模式开关（12 §5 隐私保护）——默认关，关闭时摄像头永不打开
        if "vision_enabled" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN vision_enabled BOOLEAN DEFAULT FALSE"))
    if "models" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("models")}
        # 2026-08-16：模型能力自动探测（detect_capabilities 写回 capabilities）——
        # create_all 不会给已存在表补列，旧库缺列时 GET/PUT models 会 AttributeError 500
        if "capabilities" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE models ADD COLUMN capabilities VARCHAR(128) DEFAULT 'chat'"))

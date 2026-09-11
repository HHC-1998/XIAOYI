"""FastAPI 入口（01 §8 目录树 app/main.py）。

- 启动时建表 + 启动遗忘定时任务（asyncio 后台循环，02 §8；原 APScheduler 描述已过时）。
- 注册全部路由（auth / chat / sessions / settings / memory / voice / data / health）。
"""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db.database import init_db
from app.config import FORGET_INTERVAL_MINUTES, JWT_SECRET
from app.api import (
    auth, chat, sessions, settings, memory, voice, data, health, vision,
)

logger = logging.getLogger("xiaoyi")


async def _forget_loop():
    """后台定时遗忘任务（02 §6）：重算权重 + 三层同步处理低权重消息 + 图谱衰减清理。"""
    from app.core.forgetter import process_forgetting
    from app.db.chroma_client import chroma
    from app.db.neo4j_client import neo4j_client
    from app.core.llm_provider import llm
    from app.db.database import SessionLocal

    interval = FORGET_INTERVAL_MINUTES * 60
    while True:
        await asyncio.sleep(interval)
        try:
            with SessionLocal() as db:
                await process_forgetting(db, chroma, neo4j_client, llm)
        except Exception as e:
            logger.error(f"forgetting task failed: {e}")
        try:
            # 知识图谱衰减（03 §9 新增）：所有用户的图谱节点权重按天衰减 + 清理孤立低权重 Thing。
            # 与消息遗忘独立调度，即使没有低权重消息也照常衰减（防图谱无限膨胀）。
            await _kg_decay_all()
        except Exception as e:
            logger.error(f"kg decay task failed: {e}")


async def _kg_decay_all():
    """对全部有图谱数据的用户执行 decay_kg（同步 Neo4j 调用下沉线程池）。"""
    from app.db.neo4j_client import neo4j_client

    def _run():
        # Neo4j 无全局 user 表：从图谱节点去重取 user_id（节点 user_id 恒非空）
        user_ids = [r["uid"] for r in neo4j_client.run(
            "MATCH (n) RETURN DISTINCT n.user_id AS uid"
        )]
        for uid in user_ids:
            try:
                neo4j_client.decay_kg(uid, days=1.0)
            except Exception as e:
                logger.error(f"kg decay failed for user {uid}: {e}")

    await asyncio.to_thread(_run)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if JWT_SECRET == "dev-secret-change-me":
        # 生产必须显式配置 JWT_SECRET，否则任何人都可伪造 token（2026-08-17 审查告警）
        logger.warning("JWT_SECRET 仍为默认值 dev-secret-change-me，生产部署必须通过环境变量配置！")
    init_db()
    logger.info("XIAOYI backend started")
    task = asyncio.create_task(_forget_loop())
    yield
    task.cancel()


app = FastAPI(title="XIAOYI", lifespan=lifespan)

# 开发模式跨域（生产经 nginx 同源代理，不需要）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(chat.router)
app.include_router(sessions.router)
app.include_router(settings.router)
app.include_router(memory.router)
app.include_router(voice.router)
app.include_router(data.router)
app.include_router(health.router)
app.include_router(vision.router)

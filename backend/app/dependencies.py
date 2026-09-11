"""依赖注入（01 §8 目录树 app/dependencies.py）。"""
from sqlalchemy.orm import Session as DbSession

from app.db.database import SessionLocal


def get_db():
    """FastAPI 依赖：每个请求一个独立 SQLAlchemy session。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

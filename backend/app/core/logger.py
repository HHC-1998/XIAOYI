"""统一日志（07 §9 / 02 §6 引用 `app.core.logger`）。"""
import logging

logger = logging.getLogger("xiaoyi")
logger.setLevel(logging.INFO)
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s"))
    logger.addHandler(_h)

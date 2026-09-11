"""多类型文件解析工具（12 §2）：供 chat.py（网页上传）共用。

- parse_upload：按扩展名 + MIME 判定文件种类并解析——
  image 转 base64 data URL；text/pdf/word/excel 提取纯文本；其余 kind=unsupported。
- 能力不做厂商预判：图片是否真能被模型理解由模型运行时决定（VisionNotSupportedError → 聊天式反馈）。
"""
import base64
import io
import logging

logger = logging.getLogger("xiaoyi")

# 上传限制（12 §2）：单文件 ≤10MB，一次 ≤5 个
MAX_FILE_SIZE = 10 * 1024 * 1024
MAX_FILES = 5

# 可解析的文件类型判定（扩展名 + MIME 双信号）
_TEXT_EXTS = {".txt", ".md", ".csv", ".json", ".log", ".yml", ".yaml", ".xml", ".html", ".py", ".js", ".ts", ".java"}
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
_IMAGE_MIME = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/svg+xml"}

# 文件种类 → 中文描述（聊天式"无法识别"反馈用）
KIND_LABELS = {
    "image": "图片",
    "pdf": "PDF 文档",
    "word": "Word 文档",
    "excel": "Excel 表格",
    "text": "文本文件",
    "video": "视频",
    "file": "文件",
}


def _file_ext(filename: str) -> str:
    name = filename or ""
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def detect_kind(filename: str, content_type: str) -> str:
    """按扩展名 + MIME 推断文件种类：image / pdf / word / excel / text / unsupported。"""
    ext = f".{_file_ext(filename)}"
    ct = (content_type or "").lower()
    if ext in _IMAGE_EXTS or ct.split(";")[0] in _IMAGE_MIME or ct.startswith("image/"):
        return "image"
    if ext == ".pdf" or ct.endswith("/pdf"):
        return "pdf"
    if ext in (".docx", ".doc") or "word" in ct:
        return "word"
    if ext == ".xlsx" or "spreadsheet" in ct:
        return "excel"
    if ext in _TEXT_EXTS or ct.startswith("text/"):
        return "text"
    return "unsupported"


def _extract_text(kind: str, filename: str, data: bytes) -> str:
    """提取文本类文件内容（text/pdf/word/excel）。提取失败返回占位说明，不抛异常。"""
    if kind == "text":
        return data.decode("utf-8", errors="replace")
    try:
        if kind == "pdf":
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(data))
            return "\n".join((page.extract_text() or "") for page in reader.pages)[:20000]
        if kind == "word":
            from docx import Document
            doc = Document(io.BytesIO(data))
            return "\n".join(p.text for p in doc.paragraphs)[:20000]
        if kind == "excel":
            from openpyxl import load_workbook
            wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
            lines = []
            for ws in wb.worksheets:
                for row in ws.iter_rows(values_only=True):
                    cells = [str(c) for c in row if c is not None]
                    if cells:
                        lines.append(", ".join(cells))
            return "\n".join(lines)[:20000]
    except Exception as e:
        logger.warning("extract text failed for %s: %s", filename, e)
        return f"[无法提取该文件内容：{filename}]"
    return ""


def parse_upload(filename: str, content_type: str, data: bytes) -> dict:
    """解析单个文件 → {name, kind, size, text?, data_url?}。

    - image：转 base64 data URL（是否发给模型由模型运行时能力决定，不做厂商预判）；
    - text/pdf/word/excel：提取纯文本（供模型分析 + 落库记忆）；
    - 其余 / 超过 10MB：kind=unsupported（超限附 reason="too_large"），
      由调用方以聊天式"无法识别/文件过大"回复反馈。
    """
    size = len(data)
    if size > MAX_FILE_SIZE:
        # 超限：不读取内容直接标记 unsupported（落实 12 §2 的 10MB 限制，防超大文件进内存）
        return {"name": filename or "未命名文件", "kind": "unsupported",
                "size": size, "reason": "too_large"}
    kind = detect_kind(filename, content_type)
    out = {"name": filename or "未命名文件", "kind": kind, "size": size}
    if kind == "image":
        mime = (content_type or "image/png").split(";")[0]
        out["data_url"] = f"data:{mime};base64,{base64.b64encode(data).decode()}"
    elif kind in ("text", "pdf", "word", "excel"):
        out["text"] = _extract_text(kind, filename or "", data)
    return out


def unsupported_reply(names: str, too_large: bool = False) -> str:
    """无法识别 / 超限的文件类型 → 聊天式友好回复（12 §4，绝不上屏报错代码）。"""
    if too_large:
        return f"很抱歉，{names} 超过单文件 10MB 限制，请压缩后重试。"
    return (
        f"很抱歉，我目前无法识别{names}，仅支持图片、文本、PDF、Word 和 Excel 格式，"
        "请换成这些格式后再试。"
    )

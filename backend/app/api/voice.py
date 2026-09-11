"""语音路由（04 §7/§9）：ASR 转写 + TTS 合成，均需认证。"""
import asyncio
import json
import logging
import os
import re
import tempfile
import unicodedata

import numpy as np
from fastapi import APIRouter, UploadFile, File, Depends, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from app.core.auth import decode_token, get_current_user
from app.core.asr_provider import asr
from app.core.audio_utils import convert_to_wav
from app.core.media_utils import MAX_FILE_SIZE
from app.core.tts_provider import synthesize
from app.core import stream_asr
from app.db.sql_models import User

router = APIRouter(prefix="/api/voice", tags=["voice"])

logger = logging.getLogger("xiaoyi")


def _strip_markdown(text: str) -> str:
    """TTS 前的 markdown 清理兜底（04 §9 / 08 §2.4）：前端 stripMarkdown 之外的双保险。

    去掉代码块/行内代码/标题/列表符号/链接/加粗斜体/emoji 等，避免语音念出 * # 等符号
    或表情描述文字。
    """
    text = text or ""
    text = re.sub(r"```[\s\S]*?```", "", text)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*([-*+]|\d+\.)\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*>\s?", "", text, flags=re.MULTILINE)
    text = re.sub(r"(\*\*|__)(.*?)\1", r"\2", text)
    text = re.sub(r"(\*|_)(.*?)\1", r"\2", text)
    text = re.sub(r"~~(.*?)~~", r"\1", text)
    text = re.sub(r"^\s*\|[\s\-:|]+\|\s*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"\|", "，", text)
    text = re.sub(r"<[^>]+>", "", text)
    # 表情符号/图形符号（Unicode So 类别）与 ZWJ/变体选择符：语音只念纯文本
    text = "".join(
        c for c in text
        if unicodedata.category(c) != "So" and c not in ("\u200d", "\ufe0f")
    )
    # 省略号（…… / ... / 。。。 / ⋯）→ 空格：edge-tts 遇省略号会明显停顿，朗读层去除（文字显示保留）
    # 只匹配"省略号形态"，不误伤单句号/单点；换空格而非空串，避免英文 wait...really 粘连（2026-09-03）
    text = re.sub(r"…+|\.{3,}|。{2,}|⋯+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


@router.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    # 转写大小预检：超过 10MB 直接拒绝（与上传限制一致，防超大音频读进内存/ffmpeg 挂起）
    if file.size is not None and file.size > MAX_FILE_SIZE:
        return JSONResponse({"detail": "音频文件过大（超过 10MB），无法转写"}, status_code=422)
    suffix = os.path.splitext(file.filename or "")[-1] or ".webm"
    wav_path = None
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        # 统一转 wav：已是前端解码的 16kHz 单声道 WAV 时直接透传（不再走 ffmpeg），
        # 其余格式（飞书/历史兼容）由 ffmpeg 兜底转换
        wav_path = await asyncio.to_thread(convert_to_wav, tmp_path)
        text = await asr.transcribe(wav_path)
        return JSONResponse({"text": text})
    except Exception as e:
        # 转写失败返回友好中文错误，前端据此展示具体原因，不再裸 500
        logger.warning("voice transcribe failed: %s", e, exc_info=True)
        return JSONResponse({"detail": "音频转写失败，请重试或稍后再试"}, status_code=422)
    finally:
        os.unlink(tmp_path)
        # 透传时 wav_path 即 tmp_path（已删除）；其余为新建 *_16k.wav 需单独清理
        if wav_path and wav_path != tmp_path and os.path.exists(wav_path):
            os.unlink(wav_path)


class TTSRequest(BaseModel):
    text: str


@router.post("/tts")
async def tts(
    req: TTSRequest,
    user: User = Depends(get_current_user),
):
    # 去 markdown + emoji 后再合成，避免语音念出 * # 等符号或表情描述（前端 stripMarkdown 之外的后端兜底）
    cleaned = _strip_markdown(req.text)
    # 长度上限：清洗后超限直接拒绝，防超长文本长时间占用合成/连接（桌面助手按句合成，正常远小于此值）
    if len(cleaned) > 5000:
        return JSONResponse({"detail": "文本过长（超过 5000 字符），无法合成语音"}, status_code=422)
    try:
        audio_path = await synthesize(cleaned or "嗯")
    except Exception as e:
        # 合成失败（edge-tts 在线服务不可用/网络失败等）返回友好中文错误，前端据此提示，不再裸 500
        logger.warning("tts synthesize failed: %s", e, exc_info=True)
        return JSONResponse({"detail": "语音合成失败，请稍后重试"}, status_code=422)
    # background 挂在响应上：文件流发送完成后删除临时 mp3，避免堆积
    return FileResponse(
        audio_path,
        media_type="audio/mpeg",
        background=BackgroundTask(os.unlink, audio_path),
    )


# ---------- 流式 ASR（04 §8 / 台账 38 节，sherpa-onnx "边听边出字"） ----------
# WebSocket /asr-stream：桌面助手人声帧实时推流 → 在线识别 → partial/final 逐字回推。
# 协议（复用同一连接跑多次对话，二进制与文本帧交错）：
#   Server → Client：
#     {"type":"ready"}                       —— 连接就绪（模型已确认可加载）
#     {"type":"partial","text":"..."}        —— 识别增量（结果变化才发，前端实时上屏）
#     {"type":"final","text":"..."}          —— 语音段结束的整句（进合并缓冲）
#     {"type":"error","detail":"..."}        —— 模型缺失/加载失败/识别异常（前端据此回退 whisper）
#   Client → Server 文本帧（json）：
#     {"type":"speech_start"}                —— VAD 确认人声开始，后端建流
#     {"type":"speech_end"}                  —— VAD 判段结束，后端收尾取 final
#     {"type":"cancel"}                      —— 丢弃当前流（VAD misfire / 打断丢弃段）
#   Client → Server 二进制帧：16k 单声道 Float32 PCM（vad-web 每帧 512 样本，4B/样本）
# 鉴权：?token=<JWT>（query 传参——浏览器 WebSocket 无法设 Authorization 头）


@router.websocket("/asr-stream")
async def asr_stream(ws: WebSocket, token: str = Query(...)):
    try:
        decode_token(token)   # 失败抛 PyJWTError → 4401
    except Exception:
        await ws.close(code=4401)
        return
    await ws.accept()
    if not stream_asr.available():
        # 模型未下载：发错误后关闭，前端据此回退一次性 faster-whisper 转写（不打断语音流程）
        await ws.send_json({"type": "error", "detail": "流式识别模型未下载（backend/models/sherpa-asr），已回退一次性转写"})
        await ws.close(code=4403)
        return
    await ws.send_json({"type": "ready"})
    stream = None            # 当前语音段的 OnlineStream
    last_partial = ""
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg["type"] != "websocket.receive":
                continue
            raw = msg.get("bytes")
            if raw is not None:
                # 二进制：人声帧。speech_start 前到达的帧忽略（VAD 已缓冲，不丢开头）
                if stream is None:
                    continue
                samples = np.frombuffer(raw, dtype=np.float32)
                try:
                    partial = await stream_asr.feed(stream, samples)
                except Exception as e:
                    logger.warning("stream asr feed failed: %s", e)
                    await ws.send_json({"type": "error", "detail": f"流式识别失败：{e}"})
                    break
                # 只发"结果变化"的 partial，减少前端无谓刷新
                if partial != last_partial:
                    last_partial = partial
                    await ws.send_json({"type": "partial", "text": partial})
                continue
            text = msg.get("text")
            if text is None:
                continue
            try:
                cmd = json.loads(text)
            except json.JSONDecodeError:
                continue
            ctype = cmd.get("type")
            if ctype == "speech_start":
                if stream is not None:
                    stream_asr.reset(stream)   # 上一段未正常结束（前端异常），丢弃重建
                try:
                    stream = await stream_asr.new_stream()
                except Exception as e:
                    logger.warning("stream asr create failed: %s", e)
                    await ws.send_json({"type": "error", "detail": f"流式识别初始化失败：{e}"})
                    break
                last_partial = ""
            elif ctype == "speech_end":
                if stream is not None:
                    try:
                        final = await stream_asr.finish(stream)
                    except Exception as e:
                        logger.warning("stream asr finish failed: %s", e)
                        await ws.send_json({"type": "error", "detail": f"流式识别收尾失败：{e}"})
                        stream = None
                        break
                    stream = None
                    await ws.send_json({"type": "final", "text": final})
            elif ctype == "cancel":
                if stream is not None:
                    stream_asr.reset(stream)
                    stream = None
                last_partial = ""
    except WebSocketDisconnect:
        pass
    except Exception as e:   # 兜底：识别链路异常不拖垮 WS（前端可重连/回退）
        logger.warning("asr-stream ws error: %s", e, exc_info=True)
        try:
            await ws.send_json({"type": "error", "detail": f"流式识别异常：{e}"})
        except Exception:
            pass
    finally:
        if stream is not None:
            try:
                stream_asr.reset(stream)
            except Exception:
                pass

"""TTS 语音合成（04 §9）：edge-tts 微软在线神经语音（2026-09-03 十八轮，替换 piper）。

- 调用微软 Edge 在线 TTS 服务（免费、无需 API Key），`Communicate.save()` 直出 mp3（无需 ffmpeg 转码）。
- 中文音色默认 `zh-CN-XiaoyiNeural`（晓伊）+ rate +10%（2026-09-03 二十轮用户试听选定，元气活泼更贴人设）；
  替换 piper `huayan-medium` 的机械朗读（piper 是约 60MB 小模型，prosody 能力弱、断句差——见台账 2026-09-03 十八轮）。
- 音色/语速/音调可经 env 配置：`XIAOYI_TTS_VOICE` / `XIAOYI_TTS_RATE` / `XIAOYI_TTS_PITCH`（见 config.py）。
- TTS 走在线服务 = AGENTS.md「不接任何云端 API」的**唯一有意例外**（用户 2026-09-03 确认；
  聊天 / 抽取 / 向量仍全本地 Ollama）。网络不可用时 `/api/voice/tts` 返回 422，前端有文字兜底。
- 对外接口保持不变：`synthesize(text) -> mp3 临时文件路径`（voice.py 与前端零改动）。
"""
import os
import tempfile
import uuid

import edge_tts

from app.config import XIAOYI_TTS_PITCH, XIAOYI_TTS_RATE, XIAOYI_TTS_VOICE


async def synthesize(text: str, output_path: str | None = None) -> str:
    """异步合成（edge-tts 原生 async，无需 to_thread），返回 mp3 路径。"""
    temp_created = False
    if not output_path:
        fd, output_path = tempfile.mkstemp(suffix=".mp3", prefix=f"tts_{uuid.uuid4().hex}_")
        os.close(fd)
        temp_created = True

    try:
        communicate = edge_tts.Communicate(
            text,
            XIAOYI_TTS_VOICE,
            rate=XIAOYI_TTS_RATE,
            pitch=XIAOYI_TTS_PITCH,
        )
        # save 以 wb 打开，覆盖 mkstemp 建的空文件；微软服务出网失败时抛异常走下方兜底
        await communicate.save(output_path)
    except Exception:
        if temp_created:
            try:
                os.unlink(output_path)
            except OSError:
                pass
        raise
    return output_path

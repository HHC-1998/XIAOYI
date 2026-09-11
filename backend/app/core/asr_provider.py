"""ASR 封装（04 §8）：OpenAI Whisper / 本地 faster-whisper。

全局单例 `asr`：未配置 OPENAI_API_KEY 时自动降级为本地模型（如已安装 faster-whisper）。
"""
import asyncio
import logging

from app.config import OPENAI_API_KEY

logger = logging.getLogger("xiaoyi")


class ASRProvider:
    """空实现：ASR 不可用时兜底返回空文本，避免接口 500（日志在 _build_asr 打）。"""

    async def transcribe(self, audio_path: str) -> str:
        logger.warning("ASR unavailable, return empty transcription")
        return ""


class OpenAIWhisperASR(ASRProvider):
    def __init__(self, api_key: str, base_url: str | None = None):
        from openai import AsyncOpenAI
        self.client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    async def transcribe(self, audio_path: str) -> str:
        with open(audio_path, "rb") as f:
            result = await self.client.audio.transcriptions.create(
                model="whisper-1",
                file=f,
                language="zh",
                # 上下文提示（prompt）：引导中文口语常见字/专名（"小亦/XIAOYI"等）解码，
                # 减少短句末尾字识别错误（与本地 faster-whisper 的 initial_prompt 对齐，
                # 见 AGENTS.md「后端 ASR 约定」）
                prompt="小亦，XIAOYI，你好，请问。这是一段中文口语对话。",
            )
        return result.text


class LocalWhisperASR(ASRProvider):
    def __init__(self, model_size: str = "small"):
        from faster_whisper import WhisperModel
        self.model = WhisperModel(model_size, device="cpu", compute_type="int8")

    async def transcribe(self, audio_path: str) -> str:
        segments, _ = await asyncio.to_thread(
            self.model.transcribe,
            audio_path,
            language="zh",
            # 贪心解码（beam_size=1）换首字/转写提速（2026-09-03）：CPU int8 上 beam_size=5
            # 束搜索贵数倍（每段转写 1~3s 的大头），贪心显著降耗时；中文专名/口误修正
            # 由 vad_filter 分段 + initial_prompt 热词承担，beam 的增量贡献小。若实测识别率
            # 明显下降（专名错字变多），再回调 3~5（权衡转写耗时与准确率）。
            beam_size=1,
            # Silero VAD：只转写人声段，跳过环境噪声/鼠标声等非语音段
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
            # 热词：把"小亦/XIAOYI"等专名引导进解码（此前"小娜"被识别成"麦麦小妮"）
            initial_prompt="小亦，XIAOYI，你好，请问。",
            # 每段独立解码，避免上段文本污染后续段（本地连续识别场景）
            condition_on_previous_text=False,
        )
        return "".join([s.text for s in segments])


# .env 示例/模板常留占位符（如 your-key-here），若当真 key 传给 OpenAI 云转写会 401；
# 占位符一律视为未配置，自动走本地 faster-whisper（2026-08-19 台账：语音转写全线失败根因）
_PLACEHOLDER_KEYS = {"", "your-key-here", "your_openai_api_key", "your-api-key", "sk-your-key", "sk-xxx"}


def _build_asr() -> ASRProvider:
    key = (OPENAI_API_KEY or "").strip()
    if key and key.lower() not in _PLACEHOLDER_KEYS:
        return OpenAIWhisperASR(api_key=key)
    try:
        return LocalWhisperASR("small")
    except Exception as e:
        # 两者都不可用时返回空实现（接口仍可调用，但返回空文本）；
        # 打日志便于排查（典型：容器内未预下载 faster-whisper 模型且访问不了 huggingface.co）
        logger.warning("local faster-whisper init failed, ASR degraded to empty: %s", e, exc_info=True)
        return ASRProvider()


asr = _build_asr()

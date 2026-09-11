"""流式 ASR 引擎（04 §8 / 台账 38 节）：sherpa-onnx 在线识别，"边听边出字"。

桌面助手接入：vad-web 把人声帧经 WebSocket 推给后端 → 本模块在线识别 → 逐字 partial 回推
前端实时上屏（三态卡·态1），speech_end 收尾取 final 一次性进合并缓冲。

与 faster-whisper 的分工：
- faster-whisper（asr_provider.py）：一次性整段转写——网页聊天页语音、以及流式 WS 不可用时的兜底。
- 本模块：流式逐字——只服务桌面助手。整段式引擎（whisper）无法做"边说边出字"（半句会认错、
  后字会改口），故引入流式引擎（zipformer transducer，只追加不回跳）。

模型族（2026-09-04 收紧，台账 39 节）：**只支持 zipformer transducer 三件套**
（`encoder-*.onnx` / `decoder-*.onnx` / `joiner-*.onnx` / `tokens.txt`）——zh-14M / bilingual-zh-en /
multi-zh-hans-int8 全部是 transducer 带 joiner。**绝不按"有无 joiner / 文件名"自动猜测 paraformer**：
sherpa-onnx C++ 层在模型与加载器不匹配时 LOG(FATAL) 直接 abort（Python 无法捕获），曾致 backend
整个进程猝死（exit 255，见台账 39 节）——故文件不全一律 Python 层报错，由调用方降级 faster-whisper。

模型：不随 pip 安装、不进 Docker 镜像（见 .dockerignore），手动下载到 backend/models/sherpa-asr，
compose 以 bind mount 挂入 /app/models（见 04 §8 / 台账 38 节）。懒加载：首次 WebSocket 用到才建
识别器，模型缺失/加载失败抛 RuntimeError，由调用方降级到 faster-whisper。
"""
from __future__ import annotations

import asyncio
import glob
import logging
import os
import threading
from pathlib import Path

from app.config import XIAOYI_STREAM_ASR_DIR

logger = logging.getLogger("xiaoyi")

# 采样率固定 16k（vad-web / float32ToWavBlob 已统一 16k 单声道）
SAMPLE_RATE = 16000
# 尾静音补零：input_finished 前补一段尾部静音让解码器 flush 出尾部字（zipformer 官方例程做法）
_TAIL_SILENCE_SECONDS = 0.4


def _default_model_dir() -> Path:
    """默认模型目录：backend/models/sherpa-asr（本文件 app/core/ 上溯两级 = backend/）。"""
    return Path(__file__).resolve().parents[2] / "models" / "sherpa-asr"


def _find_model_dir() -> Path | None:
    """解析模型目录：env 显式指定优先，否则默认目录；目录存在且含 tokens.txt 才返回。"""
    for d in (XIAOYI_STREAM_ASR_DIR, _default_model_dir()):
        if not d:
            continue
        p = Path(d)
        if p.is_dir() and (p / "tokens.txt").is_file():
            return p
    return None


# 模型文件探测 glob（zipformer transducer 三件套）。兼容两种命名：
# - release 包原样：encoder-epoch-99-avg-1.onnx / decoder-... / joiner-...（zh-14M 等）
# - wasm 教程式改名：encoder.onnx / decoder.onnx / joiner.onnx
_ENCODER_GLOBS = ("encoder-*.onnx", "encoder.onnx")
_DECODER_GLOBS = ("decoder-*.onnx", "decoder.onnx")
_JOINER_GLOBS = ("joiner-*.onnx", "joiner.onnx")


def _model_files(d: Path) -> tuple[str, str, str] | None:
    """取 transducer 三件套路径；任一缺失返回 None（缺 joiner 极可能是 tar 下载不完整）。"""
    enc = sorted(
        [p for g in _ENCODER_GLOBS for p in glob.glob(str(d / g))]
    )
    dec = sorted(
        [p for g in _DECODER_GLOBS for p in glob.glob(str(d / g))]
    )
    joiner = sorted(
        [p for g in _JOINER_GLOBS for p in glob.glob(str(d / g))]
    )
    if not (enc and dec and joiner):
        return None
    return enc[0], dec[0], joiner[0]


def available() -> bool:
    """模型目录就绪（tokens + encoder/decoder/joiner 三件套齐全）即视为可用；识别器本身懒加载。"""
    d = _find_model_dir()
    if not d:
        return False
    return _model_files(d) is not None


class _LazyRecognizer:
    """单例识别器：首次 get() 时加载。加载失败缓存异常，后续 get() 直接重抛（不反复尝试）。

    识别器共享同一把线程锁：sherpa-onnx 的 accept/decode 非线程安全，多路 WebSocket 并发
    时必须串行化（在线识别单实例足够——桌面助手同一时刻只有一路人声）。
    """

    def __init__(self):
        self._recognizer = None
        self._error: Exception | None = None
        self._lock = threading.Lock()

    def get(self):
        if self._recognizer is not None:
            return self._recognizer
        with self._lock:
            if self._recognizer is not None:
                return self._recognizer
            if self._error is not None:
                raise self._error
            try:
                self._recognizer = self._build()
                return self._recognizer
            except Exception as e:  # noqa: BLE001 —— 缓存并重抛，供调用方降级
                self._error = RuntimeError(f"流式识别模型加载失败：{e}")
                raise self._error from e

    @staticmethod
    def _build():
        import sherpa_onnx  # 延迟导入：模型未下载时 backend 其余功能不依赖此包

        d = _find_model_dir()
        if not d:
            raise RuntimeError(
                "流式识别模型未下载：请把 sherpa-onnx 模型文件放到 backend/models/sherpa-asr/"
                "（含 encoder-*.onnx / decoder-*.onnx / joiner-*.onnx / tokens.txt），"
                "见 04 §8 / 台账 38 节"
            )
        files = _model_files(d)
        if files is None:
            # 三件套不全（最常见：tar.bz2 下载被截断，缺排在包尾的 joiner）。必须在此 Python 层
            # 报错——若硬着头皮喂给 from_transducer/from_paraformer，sherpa-onnx C++ 层会因
            # 模型与加载器不匹配 LOG(FATAL) abort，Python 无法捕获、整个 backend 进程猝死
            #（exit 255，台账 39 节事故）。
            raise RuntimeError(
                "流式识别模型不完整（缺 joiner 或 encoder/decoder）：多半是下载被截断。"
                "请删除 backend/models/sherpa-asr/ 与 tar.bz2 后重新完整下载解压"
                "（sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23 完整约 70.6MB），"
                "确认目录内含 joiner-*.onnx 再重启。见 04 §8 / 台账 39 节"
            )
        tokens = str(d / "tokens.txt")
        enc, dec, joiner = files
        logger.info("stream ASR: load transducer from %s (encoder=%s, joiner=%s)",
                    d, Path(enc).name, Path(joiner).name)
        # zipformer transducer 族：encoder/decoder/joiner 三件套（zh-14M / bilingual-zh-en /
        # multi-zh-hans-int8 全为 transducer）。不设 paraformer 猜测分支——见模块 docstring。
        return sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=tokens,
            encoder=enc,
            decoder=dec,
            joiner=joiner,
            num_threads=2,
            decoding_method="greedy_search",
        )


_recognizer = _LazyRecognizer()
_io_lock = threading.Lock()  # accept/decode 串行锁（识别器非线程安全）


def _create_stream():
    return _recognizer.get().create_stream()


def _feed(stream, samples) -> str:
    """喂一帧/一段 16k float32 样本，跑可跑的解码步，返回当前 partial 文本。

    samples：Float32Array（numpy float32 一维），值域 [-1, 1]。
    """
    with _io_lock:
        stream.accept_waveform(SAMPLE_RATE, samples)
        rec = _recognizer.get()
        while rec.is_ready(stream):
            rec.decode_stream(stream)
        return rec.get_result(stream)


def _finish(stream) -> str:
    """语音段结束：补尾部静音 + input_finished，解码到尽，返回 final 文本。"""
    import numpy as np

    with _io_lock:
        tail = np.zeros(int(_TAIL_SILENCE_SECONDS * SAMPLE_RATE), dtype=np.float32)
        stream.accept_waveform(SAMPLE_RATE, tail)
        stream.input_finished()
        rec = _recognizer.get()
        while rec.is_ready(stream):
            rec.decode_stream(stream)
        return rec.get_result(stream)


async def new_stream():
    """异步入口：建流。模型未下载/加载失败在此抛 RuntimeError（调用方降级 whisper）。"""
    return await asyncio.to_thread(_create_stream)


async def feed(stream, samples) -> str:
    """异步入口：喂样本，返回 partial 文本（识别器共享 + 线程锁，防多路并发互踩）。"""
    return await asyncio.to_thread(_feed, stream, samples)


async def finish(stream) -> str:
    """异步入口：语音段结束收尾，返回 final 文本。"""
    return await asyncio.to_thread(_finish, stream)


def reset(stream) -> None:
    """丢弃当前流会话（cancel / VAD misfire / WS 断开时调用，避免状态残留）。"""
    try:
        with _io_lock:
            _recognizer.get().reset(stream)
    except Exception:
        logger.debug("stream ASR reset skipped (no recognizer / model missing)", exc_info=True)

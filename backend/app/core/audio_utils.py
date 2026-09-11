"""共享音频工具（04 §8.2）：convert_to_wav 被语音接口与飞书语音消息共用。

依赖系统级 ffmpeg（06 后端 Dockerfile 已安装；Windows 需加入 PATH）。

2026-08-16 起：浏览器录音已在前端解码为 16kHz 单声道 16-bit PCM WAV 上传
（见 frontend/src/utils/audio.js），convert_to_wav 对已是该格式的 WAV 直接透传、
不再调 ffmpeg，彻底绕开 ffmpeg 7.x 解析 Chrome MediaRecorder webm 的
AVERROR_EOF(187) 问题（见当天台账）。
"""
import logging
import os
import struct
import subprocess

logger = logging.getLogger("xiaoyi")


def _is_16k_mono_pcm_wav(path: str) -> bool:
    """探测是否为 16kHz 单声道 16-bit PCM WAV（前端 blobToWav16k 产物），是则无需转码。"""
    try:
        with open(path, "rb") as f:
            if f.read(4) != b"RIFF":
                return False
            f.read(8)  # size + "WAVE"
            while True:
                header = f.read(8)
                if len(header) < 8:
                    return False
                chunk_id, size = header[:4], struct.unpack("<I", header[4:8])[0]
                if chunk_id == b"fmt ":
                    data = f.read(min(size, 16))
                    if len(data) < 16:
                        return False
                    fmt, channels, rate, _, _, bits = struct.unpack("<HHIIHH", data[:16])
                    return fmt == 1 and channels == 1 and rate == 16000 and bits == 16
                if size % 2:
                    size += 1
                f.seek(size, os.SEEK_CUR)
    except OSError:
        return False
    return False


def convert_to_wav(src_path: str, dst_path: str | None = None) -> str:
    """把任意浏览器/飞书音频格式转成 16kHz 单声道 wav（faster-whisper 需要）。

    输入已是 16kHz 单声道 16-bit PCM WAV（前端解码产物）时直接返回原路径，不调 ffmpeg。
    其余格式输出到独立路径 *_16k.wav（输入已是 .wav 时 ffmpeg 会拒绝同路径覆写）。
    失败时记录 ffmpeg stderr 后抛出，不再吞掉真实报错。
    """
    if _is_16k_mono_pcm_wav(src_path):
        return src_path
    dst_path = dst_path or os.path.splitext(src_path)[0] + "_16k.wav"
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", src_path, "-ar", "16000", "-ac", "1", dst_path],
            capture_output=True,
            timeout=60,   # 畸形/损坏音频可能让 ffmpeg 永久挂起，须限时
        )
    except subprocess.TimeoutExpired:
        logger.error("ffmpeg convert timed out: %s", src_path)
        if os.path.exists(dst_path):
            try:
                os.unlink(dst_path)
            except OSError:
                pass
        raise
    if result.returncode != 0:
        logger.error(
            "ffmpeg convert failed: %s",
            result.stderr.decode(errors="replace"),
        )
        raise subprocess.CalledProcessError(
            result.returncode, result.args, output=result.stdout, stderr=result.stderr
        )
    return dst_path

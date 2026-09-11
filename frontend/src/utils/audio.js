// 浏览器音频工具：把 MediaRecorder 产出的 webm/opus 解码并重采样为
// 16kHz 单声道 16-bit PCM WAV，供后端 /api/voice/transcribe 直接使用。
//
// 背景（2026-08-16 台账）：后端镜像重建后 ffmpeg 7.x 解析 Chrome MediaRecorder
// 的非 seekable webm 会报 AVERROR_EOF(187)（"File ended prematurely"），转写全线 500。
// 前端用 Web Audio API 解码自己产出的 webm 最可靠，解码后直接上传 WAV，
// 后端 convert_to_wav 检测到 16kHz 单声道 WAV 即透传，彻底绕开该 ffmpeg 路径。

const WAV_HEADER_BYTES = 44;

// 共享 AudioContext 单例：每段录音新建 AudioContext 有初始化开销（几十~数百 ms），
// 在"段转写→回复"链路上是纯延迟。decodeAudioData/OfflineAudioContext 不依赖主 ctx 状态
//（即使 suspended 也能解码），页面生命周期内复用同一实例即可，也避免并发 ctx 数量超限。
let sharedCtx = null;
function getSharedCtx() {
  if (!sharedCtx && typeof AudioContext !== 'undefined') {
    sharedCtx = new AudioContext();
  }
  return sharedCtx;
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// 把 AudioBuffer 编码为 16-bit PCM WAV（mono，随 AudioBuffer 声道数）
function encodeWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const frames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;

  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s = Math.max(-1, Math.min(1, audioBuffer.getChannelData(c)[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

/**
 * 把任意音频 blob 解码并重采样为 16kHz 单声道 WAV。
 * @param {Blob} blob MediaRecorder 产出的 webm/ogg 等音频
 * @returns {Promise<Blob|null>} audio/wav blob；空输入或解码失败返回 null（调用方静默跳过）
 */
export async function blobToWav16k(blob) {
  if (!blob || blob.size === 0) return null;
  try {
    const ctx = getSharedCtx();
    if (!ctx) return null;
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    if (!audioBuffer || audioBuffer.length === 0) return null;

    // 重采样到 16kHz 单声道：多声道先混为单声道，再经 OfflineAudioContext 重采样
    const monoBuffer = ctx.createBuffer(1, audioBuffer.length, audioBuffer.sampleRate);
    const monoData = monoBuffer.getChannelData(0);
    const numCh = audioBuffer.numberOfChannels;
    for (let i = 0; i < audioBuffer.length; i++) {
      let sum = 0;
      for (let c = 0; c < numCh; c++) sum += audioBuffer.getChannelData(c)[i];
      monoData[i] = sum / numCh;
    }

    const outFrames = Math.max(1, Math.ceil(monoBuffer.length * 16000 / monoBuffer.sampleRate));
    const offline = new OfflineAudioContext(1, outFrames, 16000);
    const source = offline.createBufferSource();
    source.buffer = monoBuffer;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();

    return new Blob([encodeWav(rendered)], { type: 'audio/wav' });
  } catch (e) {
    console.warn('blobToWav16k failed:', e);
    return null;
  }
}

/**
 * 把 16kHz 单声道 Float32Array（采样值 -1~1）直接编码为 16-bit PCM WAV Blob。
 * 供 Silero VAD（@ricky0123/vad-web）onSpeechEnd 给出的段音频直接上传转写——
 * 与 blobToWav16k 一样产出 16k mono WAV，后端对 16k mono WAV 透传，绕开 ffmpeg
 * 解析 webm 的路径（见文件头背景说明）。空输入返回 null（调用方静默跳过）。
 * @param {Float32Array} samples 16kHz 单声道采样
 * @param {number} [sampleRate=16000]
 * @returns {Blob|null}
 */
export function float32ToWavBlob(samples, sampleRate = 16000) {
  if (!samples || samples.length === 0) return null;
  const numFrames = samples.length;
  const bytesPerSample = 2;
  const dataSize = numFrames * bytesPerSample;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < numFrames; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += bytesPerSample;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

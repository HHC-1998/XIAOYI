import { api, getToken } from './client';

export const voiceApi = {
  // 上传音频转文字（ASR），需认证
  // 2026-08-16 起浏览器侧统一先解码为 16kHz 单声道 WAV 再上传（见 utils/audio.js），
  // 后端对 16kHz mono WAV 直接透传不再走 ffmpeg
  transcribe: (blob) => {
    const form = new FormData();
    form.append('file', blob, 'voice.wav');
    return api.post('/api/voice/transcribe', form).then((r) => r.data.text);
  },
  // 文字合成语音（TTS）：接口返回音频文件流，这里以 blob 接收并生成可播放 URL
  tts: async (text) => {
    const res = await api.post('/api/voice/tts', { text }, { responseType: 'blob' });
    return URL.createObjectURL(res.data);   // 调用方播放后须 revokeObjectURL
  },
};

// ---- 流式 ASR WebSocket（2026-09-03，04 §8 / 台账 38 节："边听边出字"） ----
// 桌面助手专用：vad-web 人声帧（16k Float32Array）实时推流 → 后端 sherpa-onnx 在线识别 →
// partial/final 逐字回推。返回句柄，由调用方按 onSpeechStart/onFrameProcessed/onSpeechEnd 驱动。
// 服务器不可用 / 模型未下载时握手失败或收到 error 帧——调用方据 onError 回退一次性转写。
export function openStreamAsr() {
  const token = getToken();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/voice/asr-stream?token=${encodeURIComponent(token || '')}`);
  const handle = {
    ready: false,          // 收到 ready 后才允许 start/send（避免 model 未就绪丢帧）
    onReady: null,         // () => void
    onPartial: null,       // (text) => void —— partial 仅上屏展示，勿入合并缓冲
    onFinal: null,         // (text) => void —— final 进合并缓冲（与 processVoice 同一路径）
    onError: null,         // (detail) => void —— 模型缺失/网络断，回退 whisper
    onClose: null,         // () => void
  };
  ws.onopen = () => {};
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'ready') { handle.ready = true; handle.onReady?.(); }
    else if (msg.type === 'partial') handle.onPartial?.(msg.text || '');
    else if (msg.type === 'final') handle.onFinal?.(msg.text || '');
    else if (msg.type === 'error') handle.onError?.(msg.detail || '识别不可用');
  };
  ws.onclose = () => { handle.ready = false; handle.onClose?.(); };
  ws.onerror = () => { handle.ready = false; handle.onError?.('流式识别连接失败'); };
  const sendJson = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
  return {
    handle,
    start: () => sendJson({ type: 'speech_start' }),
    end: () => sendJson({ type: 'speech_end' }),
    cancel: () => sendJson({ type: 'cancel' }),
    // 送人声帧：Float32Array（16k mono）→ 原样 ArrayBuffer（后端 np.frombuffer 直解）
    sendAudio: (f32) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength));
      return true;
    },
    close: () => { try { ws.close(); } catch { /* noop */ } },
  };
}

import { getToken } from './client';

// 流式对话：POST /api/chat/stream（multipart/form-data，files[] 支持多类型文件上传，12 §2）
// SSE 帧 {session_id} / {delta, thinking} / {media_reply, code} / {error, code} / [DONE]
// 返回 AbortController，供调用方中止（切换会话/打断/卸载）。
// 回调：onSession(实际 session_id，首帧)、onDelta(content 增量)、onThinking(思考过程增量)、
//       onMediaReply(聊天式媒体错误回复，如"模型不支持识别图片")、
//       onError(msg, code)、onDone(正常收尾)。
export function streamChat({ message, sessionId, source = 'web', files, onSession, onDelta, onThinking, onMediaReply, onError, onDone }) {
  const controller = new AbortController();
  (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      // multipart：message/session_id/source 走 Form，文件走 files[]（不手动设 Content-Type）
      // source：web（聊天页）/ desktop（桌面助手）——后端按 source 分流思考深度
      //（desktop=low 浅度思考，其余=high 深度思考）并落库 Message.source（见 AGENTS.md 思考流约定）
      const fd = new FormData();
      fd.append('message', message);
      if (sessionId) fd.append('session_id', sessionId);
      fd.append('source', source);
      if (files && files.length) {
        files.forEach((f, i) => fd.append('files', f, f.name || `file_${i}`));
      }
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',   // SSE 契约，见 01 §5.5
          Authorization: `Bearer ${getToken()}`,
        },
        body: fd,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`chat stream failed: ${res.status}`);
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              buffer = '';
              onDone?.();
              return;
            }
            try {
              const parsed = JSON.parse(payload);
              if (parsed.error) {
                // 错误帧后取消读取，释放连接（否则 reader 残留、连接不关闭）
                onError?.(parsed.error, parsed.code);
                try { await reader.cancel(); } catch { /* noop */ }
                return;
              }
              if (parsed.session_id) onSession?.(parsed.session_id);
              if (parsed.media_reply) {
                // 媒体类错误以聊天式回复呈现（12 §4），交给调用方按正常回复渲染
                onMediaReply?.(parsed.media_reply, parsed.code);
                continue;
              }
              if (parsed.delta) onDelta?.(parsed.delta);
              if (parsed.thinking) onThinking?.(parsed.thinking);
            } catch {
              /* 忽略无法解析的帧 */
            }
          }
        }
      }
      onDone?.();
    } catch (e) {
      if (e.name === 'AbortError') return;
      // 网络层失败（fetch 中断 / 服务未启动等），交给调用方展示友好文案
      onError?.(e.message, 'network_error');
    }
  })();
  return controller;
}

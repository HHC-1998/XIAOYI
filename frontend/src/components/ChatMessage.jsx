import { Markdown } from './Markdown';

// 解析后端返回的 attachments JSON（[{name,kind,size}]）或前端待发文件（{name,size}）
function parseAttachments(message) {
  if (Array.isArray(message?.attachments) && message.attachments.length) {
    return message.attachments;
  }
  if (typeof message?.attachments === 'string' && message.attachments) {
    try {
      return JSON.parse(message.attachments);
    } catch {
      return [];
    }
  }
  return [];
}

function formatSize(n) {
  if (!n) return '';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

export function ChatMessage({ message, onRetry, streaming = false }) {
  const isUser = message.role === 'user';
  const attachments = parseAttachments(message);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3.5 animate-pop-in`}>
      <div
        className={`max-w-[76%] rounded-bubble px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? 'bg-gradient-to-r from-nebula-500 to-blush-400 text-white rounded-br-md shadow-glow'
            : 'glass text-stardust-100 rounded-bl-md'
        }`}
      >
        {/* 用户消息附件：图片预览卡片（12 §3） */}
        {isUser && attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((a, i) => {
              // 前端待发文件可能只有 {name,size}（尚未落库）；已落库附件带 kind/name
              const kind = a.kind || (typeof a.name === 'string' && /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name) ? 'image' : 'file');
              const isImage = kind === 'image';
              return (
                <div
                  key={`${a.name || 'file'}_${i}`}
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs ${
                    isUser ? 'bg-white/20 text-white' : 'bg-white/10 text-stardust-300'
                  }`}
                >
                  {isImage ? (
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="5" width="18" height="14" rx="3" />
                      <circle cx="8.5" cy="10" r="1.6" />
                      <path d="M21 15.5l-4.5-4.5L7 20.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M4 3a2 2 0 012-2h4.586A2 2 0 0112 1.586L16.414 6A2 2 0 0117 7.414V17a2 2 0 01-2 2H6a2 2 0 01-2-2V3z" />
                    </svg>
                  )}
                  <span className="max-w-[10rem] truncate">{a.name}</span>
                  {a.size && <span className="opacity-60">{formatSize(a.size)}</span>}
                </div>
              );
            })}
          </div>
        )}
        {isUser ? (
          message.content
        ) : message.content ? (
          <Markdown>{message.content}</Markdown>
        ) : streaming ? (
          // "思考中"占位：三点星光呼吸（替代旧灰点）
          <div className="flex items-center gap-1.5 py-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-nebula-300 animate-twinkle" style={{ animationDelay: '0ms' }} />
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-blush-300 animate-twinkle" style={{ animationDelay: '220ms' }} />
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-nebula-300 animate-twinkle" style={{ animationDelay: '440ms' }} />
            <span className="ml-1.5 text-xs text-stardust-500 animate-breathe">思考中…</span>
          </div>
        ) : null}
        {message.interrupted && (
          <div className="mt-1 text-xs text-stardust-500">（已打断）</div>
        )}
        {message.error && (
          <div className="mt-1 text-sm text-blush-300">
            出错：{message.error}
            <button onClick={onRetry} className="ml-2 underline">重试</button>
          </div>
        )}
      </div>
    </div>
  );
}

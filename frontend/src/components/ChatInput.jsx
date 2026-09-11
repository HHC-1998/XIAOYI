import { useState, useEffect, useRef } from 'react';
import { VoiceRecorder } from './VoiceRecorder';

// 前端预检（12 §2 与后端一致）：单文件 ≤10MB，一次 ≤5 个
// Q 版改版（2026-09-03 起）：附件收窄为仅图片——上传对象只服务"发图给小亦看"，
// 文档/压缩包等已不再需要（12 §2 附件类型同步收窄）。
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 5;
const ACCEPT = 'image/*';

function formatSize(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

export function ChatInput({ onSend }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);             // 待发送附件 [{file, name, size, preview}]
  const [listening, setListening] = useState(false);  // 语音输入进行中
  const [micError, setMicError] = useState('');       // 语音/麦克风错误提示（3 秒自动消失）
  const [dragActive, setDragActive] = useState(false); // 拖拽悬停高亮
  const [uploadError, setUploadError] = useState(''); // 图片预检错误（超限/超量/非图片）
  const micErrorTimerRef = useRef(null);
  const fileInputRef = useRef(null);
  const voiceRecorderRef = useRef(null);
  const voiceBaseRef = useRef('');  // 语音录音开始前输入框已有文本（追加模式基准）
  const sendingRef = useRef(false);   // 发送锁：防双击/重复点击重复提交

  useEffect(() => {
    return () => clearTimeout(micErrorTimerRef.current);
  }, []);

  const showMicError = (msg) => {
    setMicError(msg);
    clearTimeout(micErrorTimerRef.current);
    micErrorTimerRef.current = setTimeout(() => setMicError(''), 3000);
  };

  const addFiles = (list) => {
    const incoming = Array.from(list);
    if (!incoming.length) return;
    setUploadError('');
    // 收窄为仅图片：非 image/* 直接拦截并提示（拖拽文件同理）
    const nonImage = incoming.find((f) => !f.type.startsWith('image/'));
    if (nonImage) {
      setUploadError(`「${nonImage.name}」不是图片，小亦现在只看图片哦`);
    }
    const imgs = incoming.filter((f) => f.type.startsWith('image/'));
    const oversize = imgs.filter((f) => f.size > MAX_FILE_SIZE);
    if (oversize.length) {
      setUploadError(`「${oversize[0].name}」超过 10MB 限制`);
    }
    const ok = imgs.filter((f) => f.size <= MAX_FILE_SIZE);
    if (files.length + ok.length > MAX_FILES) {
      setUploadError(`一次最多发送 ${MAX_FILES} 张图片`);
      return;
    }
    if (!ok.length) return;
    setFiles((prev) => [
      ...prev,
      ...ok.map((f) => ({
        file: f,
        name: f.name,
        size: f.size,
        preview: URL.createObjectURL(f),  // 图片缩略图（发送/移除时 revoke）
      })),
    ]);
  };

  const removeFile = (idx) => {
    setFiles((prev) => {
      const target = prev[idx];
      if (target?.preview) URL.revokeObjectURL(target.preview);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleSend = async () => {
    // 发送锁：上一次发送完成前忽略重复点击（Enter 双击 / 快速连点发送按钮）
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      let content = text.trim();
      // 录音中点击发送：先停止录音并拿最终语音文本再发送（一次点击 = 关麦 + 发送，
      // 避免 pointerdown 自动停止与 click 发送之间的文本刷新异步时序导致点两次）
      if (listening && voiceRecorderRef.current?.stopAndGetText) {
        const voiceText = await voiceRecorderRef.current.stopAndGetText();
        // 追加模式（2026-08-24）：语音转写是"输入框已有内容之外"的新文本，
        // 完整发送内容 = 录音前已有文本 + 本次语音转写全文（不可用 text state——
        // await 期间 React setState 尚未提交，读到的 text 是旧值）
        const full = `${voiceBaseRef.current}${voiceText}`.trim();
        content = full || content;
      }
      if (!content && files.length === 0) return;
      await onSend(content, files.map((f) => f.file));
      // 发送成功后释放缩略图 objectURL
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      setText('');
      setFiles([]);
      // 语音文本已发送：通知 VoiceRecorder 阻断迟到的 emitText（onend/onstop 延迟回调
      // 会把语音文字写回输入框，导致"发送了但输入框文字还在"，需手动删除，2026-08-23 修）
      voiceRecorderRef.current?.markTextSent?.();
    } finally {
      sendingRef.current = false;
    }
  };

  // 录音中即使文本暂空也允许点发送（"停止并发送当前语音"；识别为空则不发送）
  const canSend = listening || !!text.trim() || files.length > 0;

  return (
    <div className="glass rounded-[1.8rem] px-3 py-2.5">
      {micError && (
        <div className="px-3 pt-1 text-xs text-red-300">{micError}</div>
      )}
      {uploadError && (
        <div className="px-3 pt-1 text-xs text-blush-300">{uploadError}</div>
      )}
      {/* 已选图片缩略图：小图预览 + 可删除；与文字输入并存（12 §2） */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2 pt-2">
          {files.map((f, i) => (
            <div key={`${f.name}_${i}`} className="relative group">
              <img
                src={f.preview}
                alt={f.name}
                className="w-16 h-16 rounded-xl object-cover ring-1 ring-white/[0.15]"
              />
              <span className="absolute bottom-0 inset-x-0 px-1 text-[10px] text-white bg-night-950/60 rounded-b-xl truncate text-center">
                {formatSize(f.size)}
              </span>
              <button
                onClick={() => removeFile(i)}
                title="移除图片"
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-night-900 border border-white/20 text-stardust-300 text-xs leading-none hover:text-red-300 flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          addFiles(e.dataTransfer.files);
        }}
        className={`flex items-center gap-2 px-1 transition ${
          dragActive ? 'ring-2 ring-nebula-400/60 rounded-2xl' : ''
        }`}
      >
        <VoiceRecorder
          ref={voiceRecorderRef}
          // 追加模式（2026-08-24）：录音开始记录输入框已有文本作基准，转写结果拼在其后，
          // 支持"手动输入 + 多次语音累加"；发送后 setText('') 全清
          onRecordingChange={(v) => {
            setListening(v);
            if (v) voiceBaseRef.current = text;
          }}
          onInterim={(t) => setText(voiceBaseRef.current + t)}
          onError={showMicError}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          title="上传图片（可拖拽到输入框）"
          className="w-10 h-10 shrink-0 rounded-full border border-white/[0.15] bg-white/[0.08] text-stardust-300 hover:text-blush-300 hover:border-blush-400/40 hover:bg-white/[0.15] flex items-center justify-center transition"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="5" width="18" height="14" rx="3" />
            <circle cx="8.5" cy="10" r="1.6" />
            <path d="M21 15.5l-4.5-4.5L7 20.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <input
          className={`flex-1 min-w-0 rounded-full bg-white/[0.08] border border-transparent px-4 py-2.5 text-sm text-stardust-100 placeholder-stardust-500 outline-none transition focus:bg-white/[0.12] ${
            listening
              ? 'ring-2 ring-red-400/70'
              : 'focus:ring-2 focus:ring-nebula-400/40'
          }`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // IME 组合态（中文输入法选词中）按 Enter 不应发送（e.nativeEvent.isComposing 是标准属性）
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) handleSend();
          }}
          placeholder={
            listening
              ? '正在聆听，说出你想说的…'
              : '想和小亦说点什么？'
          }
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          title={canSend ? '发送' : '先输入点什么吧'}
          className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center transition ${
            canSend
              ? 'bg-gradient-to-r from-nebula-500 to-blush-400 text-white shadow-glow hover:brightness-110 active:scale-95'
              : 'bg-white/[0.08] text-stardust-500 cursor-not-allowed'
          }`}
        >
          <svg className="w-5 h-5 translate-x-[-1px]" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3.4 20.6L22 12 3.4 3.4l3.3 8.1L3.4 20.6z" opacity="0.9" />
            <path d="M6.7 11.5H22" opacity="0.55" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

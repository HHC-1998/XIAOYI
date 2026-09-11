import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { voiceApi } from '../api/voice';
import { blobToWav16k } from '../utils/audio';

// 聊天页实时语音输入（04 §6 / 2026-08-15 起）：
// - 主路径：浏览器原生 Web Speech API（webkitSpeechRecognition / SpeechRecognition），
//   interimResults=true 边说边逐字出字，实时回调 onInterim(全文)；
// - 降级路径：Web Speech 不可用/网络不可达/start 被拒时，退回 MediaRecorder 录音 +
//   后端 /api/voice/transcribe，并按 VAD（音量检测）分段"边录边出字"：
//   检测到声音开始录，静音约 1.2s 自动提交一段转写并上屏，继续录下一段；
// - 自动关闭：录音中点击输入框/页面别处/切换路由（组件卸载）自动 stop，保留已识别文字。

const SILENCE_MS = 1200;      // 降级路径：静音超过此时长视为一句结束，提交转写

export const VoiceRecorder = forwardRef(function VoiceRecorder(
  { onInterim, onRecordingChange, onError },
  ref,
) {
  const [recording, setRecording] = useState(false);
  const supportsSpeech = typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  const mediaRef = useRef(null);        // MediaRecorder（降级路径当前段）
  const streamRef = useRef(null);       // MediaStream（降级路径）
  const chunksRef = useRef([]);         // 降级路径当前段音频分片
  const recognitionRef = useRef(null);  // SpeechRecognition 实例（主路径）
  const segmentTimerRef = useRef(null); // 降级路径静音结束定时器
  const startGenRef = useRef(0);        // 麦克风启动代际：防异步 start 覆盖 stop/卸载后泄漏流
  const aliveRef = useRef(true);        // 组件存活标志：卸载后 onstop 转写回调不再刷新输入框
  const modeRef = useRef('web');        // 'web' 主路径 / 'media' 降级路径
  const finalRef = useRef('');          // 已确认的最终文本
  const lastInterimRef = useRef('');    // 最近一次完整文本（final + interim，Web Speech 末句保留用）
  const btnRef = useRef(null);          // 麦克风按钮 DOM，用于判断点击是否落在按钮上
  const audioCtxRef = useRef(null);     // AudioContext（降级路径 VAD）
  const analyserRef = useRef(null);     // AnalyserNode（降级路径 VAD）
  const rafIdRef = useRef(null);        // VAD requestAnimationFrame id
  const lastSoundRef = useRef(0);       // 最近一次检测到声音的时间（VAD 静音计时）
  const gestureResumeRef = useRef(null); // AudioContext 手势恢复监听（降级路径 suspended 兜底）
  const webSpeechFailedRef = useRef(false); // Web Speech 曾失败（network 等）：本会话后续直接走本地识别
  // 「一次点击关麦并发送」（2026-08-16）：发送按钮在录音中点击时，先停止录音并
  // 拿最终文本再发送。以下 ref 协调 stop 与异步文本确认（onend / onstop→转写）的时序。
  const stopInFlightRef = useRef(false); // 停止流程进行中（第二次 stop 不重复 flush）
  const stopPromiseRef = useRef(null);   // stopAndGetText 返回的 Promise（幂等复用）
  const pendingResolveRef = useRef(null); // 待外部 await 的 resolve（拿到最终文本后触发）
  const sentRef = useRef(false);          // 本次语音文本已发送：阻断延迟 emitText 把文字写回输入框
  //                                  （2026-08-23 修"语音发送后输入框文字不消失"，见当天台账八）

  // 展示用文本 = 已确认最终文本；Web Speech 路径下未确认的末句 interim 也保留
  //（发送瞬间 onend 尚未把 interim 转成 final，若不保留末句会丢失"最后一句话"）
  const currentText = () => finalRef.current || lastInterimRef.current;

  const emitText = () => {
    // 文本已发送：onend/onstop 延迟回调不再把语音文字写回输入框（发送后已 setText('')，
    // 迟到的 emitText 会把文字"复活"回输入框，需手动删除，2026-08-23 修）
    if (sentRef.current) return;
    onInterim?.(currentText());
  };

  // 标记本次语音文本已发送（ChatInput.handleSend 发送成功后调用）：后续 emitText 不再刷新输入框
  const markTextSent = () => {
    sentRef.current = true;
  };

  // 面向用户的可读错误提示（由 ChatInput 展示在输入框下方，3 秒自动消失）
  const notifyError = (msg) => onError?.(msg);

  const setRecordingState = (v) => {
    setRecording(v);
    onRecordingChange?.(v);
  };

  // 停止后文本已确认（onend / onstop→转写完成）时统一收尾：
  // 刷新输入框 + 若有外部 await（发送按钮）则 resolve 最终文本。
  // VAD 自动分段触发的 onstop（无外部等待者）只 emitText 不 resolve。
  const flushTextAndResolve = () => {
    stopInFlightRef.current = false;
    emitText();
    if (pendingResolveRef.current) {
      pendingResolveRef.current(currentText());
      pendingResolveRef.current = null;
      stopPromiseRef.current = null;
    }
  };

  // 停止录音并 resolve 最终文本（聊天页发送按钮录音中点击时调用）：
  // - pointerdown 自动停止（stop 已在途中）时只注册等待者，文本确认后由 onend/onstop 收尾；
  // - 无停止流程时才主动 stop()（如发送前录音已自然结束、只剩已确认文本）。
  // 幂等复用同一 Promise，避免与 pointerdown 自动 stop() 重复创建。
  const stopAndGetText = () => {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    stopPromiseRef.current = new Promise((resolve) => {
      pendingResolveRef.current = resolve;
      // 兜底超时：转写/onend 异常时不让发送永久挂起
      setTimeout(() => {
        if (pendingResolveRef.current) {
          pendingResolveRef.current(currentText());
          pendingResolveRef.current = null;
          stopPromiseRef.current = null;
        }
      }, 8000);
    });
    if (!stopInFlightRef.current) stop();
    return stopPromiseRef.current;
  };

  // 停止 VAD 循环（stop / 卸载共用）
  const stopVAD = () => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    clearTimeout(segmentTimerRef.current);
  };

  // ---- 降级路径：MediaRecorder + VAD 分段"边录边出字" ----
  // 每段录音 onstop 时转写并上屏；检测到下一段声音自动开启新段。
  const beginSegment = () => {
    if (!streamRef.current || !aliveRef.current) return;
    if (mediaRef.current && mediaRef.current.state !== 'inactive') return; // 已在录
    chunksRef.current = [];
    const recorder = new MediaRecorder(streamRef.current);
    recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
    recorder.onstop = async () => {
      // 提交当前段：转写 → 追加到最终文本 → 上屏（组件已卸载则跳过）
      // 先前端解码为 16kHz 单声道 WAV 再上传，绕开 ffmpeg 7.x 解析 Chrome webm 报 EOF
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      chunksRef.current = [];
      if (blob.size > 0) {
        try {
          const wav = await blobToWav16k(blob);
          if (wav) {
            const text = await voiceApi.transcribe(wav);
            if (text && aliveRef.current) {
              finalRef.current += text;
              emitText();
            }
          }
        } catch (e) {
          console.error('transcribe failed:', e);
        }
      }
      mediaRef.current = null;
      // 统一收尾：发送按钮 await 的文本在此 resolve（VAD 自动分段时无外部等待者，只 emitText）
      if (aliveRef.current) flushTextAndResolve();
      // 仍在录音态（未手动停止/未卸载）→ 等待 VAD 检测到下一段声音再开启新段
    };
    recorder.start();
    mediaRef.current = recorder;
  };

  // VAD 循环：有声音 → 开始录音；静音超过 SILENCE_MS → 停止当前段触发转写
  // 2026-08-15 起用时间域 RMS + 自适应噪声底（替代频域平均）：
  //   - 旧实现 new Uint8Array(analyser.fftSize) + getByteFrequencyData 只填前
  //     frequencyBinCount=fftSize/2 个元素，后一半恒 0 → 音量平均被稀释一半，
  //     阈值 30 实际等效 60，人声很难触发（与桌面助手"监听中但不响应"同源根因）。
  //   - getFloatTimeDomainData 填满整个数组，RMS 能量更准更灵敏。
  // 2026-08-16 起与桌面助手同步（见当天台账）：噪声底 EMA + clamp（非语音帧才校准），
  // 开录/停录分离迟滞阈值 onTh/offTh，消除阈值附近抖动导致的碎片段。
  const vadLoop = () => {
    if (!aliveRef.current) return;
    const analyser = analyserRef.current;
    const timeData = new Float32Array(analyser.fftSize);
    let noiseFloor = 0.01;

    const rms = () => {
      analyser.getFloatTimeDomainData(timeData);
      let sum = 0;
      for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
      return Math.sqrt(sum / timeData.length);
    };

    const tick = () => {
      // 兜底恢复：某些浏览器手势丢失后 AudioContext 会被再次挂起，VAD 前先 resume（与桌面助手同参数）
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        try { audioCtxRef.current.resume(); } catch (e) { /* noop */ }
      }
      const level = rms();
      const now = performance.now();
      const recording = mediaRef.current && mediaRef.current.state === 'recording';
      const onTh = Math.min(0.06, Math.max(0.02, noiseFloor * 3));
      const offTh = onTh * 0.7;
      // 噪声校准（EMA + clamp）：空闲非语音帧快跟随环境；录音中静音帧慢校准防锁高
      if (!recording && level < onTh) {
        noiseFloor = Math.min(0.03, Math.max(0.005, noiseFloor * 0.95 + level * 0.05));
      } else if (recording && level < offTh) {
        noiseFloor = Math.min(0.03, Math.max(0.005, noiseFloor * 0.97 + level * 0.03));
      }
      if (level > onTh) {
        lastSoundRef.current = now;
        beginSegment();   // 有声音且未在录 → 开启一段
        clearTimeout(segmentTimerRef.current);
      } else if (recording && level < offTh) {
        // 静音计时：低于 offTh 持续 SILENCE_MS 没声音 → 结束当前句。
        // offTh 停录迟滞：offTh~onTh 中间区段保持录音，与桌面助手同参数（2026-08-16 晚修正）
        clearTimeout(segmentTimerRef.current);
        segmentTimerRef.current = setTimeout(() => {
          if (mediaRef.current && mediaRef.current.state !== 'inactive') {
            try { mediaRef.current.stop(); } catch (e) { /* noop */ }
          }
        }, SILENCE_MS);
      }
      if (aliveRef.current) {
        rafIdRef.current = requestAnimationFrame(tick);
      }
    };
    tick();
  };

  const startMediaRecorder = async () => {
    const gen = ++startGenRef.current;   // 记录本代启动，stop/卸载后本代失效
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      // await 挂起期间可能已被 stop：忽略过期错误
      if (gen !== startGenRef.current || !aliveRef.current) return;
      const name = e?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        notifyError('麦克风权限被拒，请点击地址栏左侧的锁图标允许使用麦克风');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        notifyError('未检测到麦克风设备，请检查是否已插入/开启');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        notifyError('麦克风被其他应用占用，请关闭占用程序后重试');
      } else {
        notifyError(`麦克风启动失败：${e?.message || name || '未知错误'}`);
      }
      setRecordingState(false);
      return;
    }
    // 异步期间被 stop/卸载：立即释放流，防止 start 覆盖 stop 状态并泄漏麦克风
    if (gen !== startGenRef.current || !aliveRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;
    modeRef.current = 'media';
    // 初始化 VAD（AudioContext + AnalyserNode）
    try {
      audioCtxRef.current = new AudioContext();
      // getUserMedia 权限弹窗可能耗尽浏览器 5s "用户激活"窗口，ctx 保持 suspended →
      // AnalyserNode 无数据、VAD 音量恒 0（"监听中但不响应"根因，与桌面助手同源，
      // 见 AGENTS.md 桌面助手约定·AudioContext 用户激活兜底）。启动即 resume，
      // 仍不 running 则注册一次性手势监听，用户点击页面时 resume 并自移除（2026-08-23）。
      if (audioCtxRef.current.state === 'suspended') {
        try { await audioCtxRef.current.resume(); } catch (e) { /* noop */ }
      }
      if (audioCtxRef.current.state !== 'running') {
        const resumeOnGesture = () => {
          try { audioCtxRef.current?.resume(); } catch (e) { /* noop */ }
          document.removeEventListener('pointerdown', resumeOnGesture);
          document.removeEventListener('keydown', resumeOnGesture);
          gestureResumeRef.current = null;
        };
        gestureResumeRef.current = resumeOnGesture;
        document.addEventListener('pointerdown', resumeOnGesture);
        document.addEventListener('keydown', resumeOnGesture);
      }
      const source = audioCtxRef.current.createMediaStreamSource(stream);
      const analyser = audioCtxRef.current.createAnalyser();
      analyser.fftSize = 1024;                 // 时间域 RMS 用 1024 点足够
      analyser.smoothingTimeConstant = 0.3;    // 降低平滑，响应更快
      source.connect(analyser);
      analyserRef.current = analyser;
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      notifyError(`音频初始化失败：${e?.message || '未知错误'}`);
      setRecordingState(false);
      return;
    }
    setRecordingState(true);
    vadLoop();
  };

  // ---- 主路径：Web Speech API（边说边出字；网络不可用时自动降级 MediaRecorder） ----
  const startSpeechRecognition = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'zh-CN';
    finalRef.current = '';

    rec.onresult = (event) => {
      // 语音文本已发送（markTextSent）：迟到的识别结果不再写回输入框。
      // 此前 onresult 直接 onInterim 绕过 emitText 的 sentRef 拦截，
      // 追加模式下发送后文本被清空、迟到结果会把文字"复活"回输入框（2026-08-24）
      if (sentRef.current) return;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalRef.current += transcript;
        } else {
          interim += transcript;
        }
      }
      // 实时把"最终文本 + 实时片段"整串刷新到输入框（并记录完整文本，
      // 供 stopAndGetText 在 onend 尚未落定 final 时保留末句）
      const full = finalRef.current + interim;
      lastInterimRef.current = full;
      onInterim?.(full);
    };

    // 切换到 MediaRecorder 降级路径（Web Speech 不可用/网络中断/start 被拒共用）
    const fallbackToMedia = () => {
      modeRef.current = 'media';
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch (e) { /* noop */ }
        recognitionRef.current = null;
      }
      startMediaRecorder();
    };

    rec.onerror = (event) => {
      const err = event?.error || '';
      // Chrome 语音识别依赖 Google 服务，网络不可达时自动降级本地/后端转写，不中断体验。
      // 记住失败：本会话后续点击直达本地识别，不再反复试 Web Speech（2026-08-23）。
      if (err === 'network' || err === 'service-not-allowed' || err === 'audio-capture') {
        if (!webSpeechFailedRef.current) {
          webSpeechFailedRef.current = true;
          notifyError('已自动切换本地识别模式');
        }
        fallbackToMedia();
        return;
      }
      if (err === 'not-allowed') {
        notifyError('麦克风权限被拒，请点击地址栏左侧的锁图标允许使用麦克风');
      } else if (err !== 'no-speech' && err !== 'aborted') {
        notifyError('语音识别失败，请重试');
      }
      setRecordingState(false);
      flushTextAndResolve();
    };

    rec.onend = () => {
      // 已降级 MediaRecorder 时忽略 web speech 的结束事件（避免误退出录音态）
      if (modeRef.current === 'media') return;
      // 识别自然结束（或 stop 触发）：刷新最终文本并退出录音态；
      // 发送按钮 await 的文本在此 resolve（stop() 已置 stopInFlight，收尾由这里统一完成）
      setRecordingState(false);
      flushTextAndResolve();
    };

    try {
      rec.start();
    } catch (e) {
      // 连续 start 会被浏览器拒绝：降级 MediaRecorder + 后端转写，保证语音输入仍可用
      fallbackToMedia();
      return;
    }
    recognitionRef.current = rec;
    modeRef.current = 'web';
    setRecordingState(true);
  };

  const stop = () => {
    startGenRef.current++;       // 令在途 startMediaRecorder 失效
    stopInFlightRef.current = true;   // 标记停止流程中：文本确认后由 onend/onstop 统一收尾（防重复 flush）
    if (gestureResumeRef.current) {
      document.removeEventListener('pointerdown', gestureResumeRef.current);
      document.removeEventListener('keydown', gestureResumeRef.current);
      gestureResumeRef.current = null;
    }
    stopVAD();
    const hadRecognition = !!recognitionRef.current;
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch (e) { /* already stopped */ }
      recognitionRef.current = null;
    }
    const hadRecording = !!(mediaRef.current && mediaRef.current.state !== 'inactive');
    if (mediaRef.current && mediaRef.current.state !== 'inactive') {
      // 停止当前段 → onstop 会转写剩余音频并 flushTextAndResolve
      // （aliveRef 仍为 true；streamRef 随后置空 + VAD 已停，onstop 不会开新段）
      try { mediaRef.current.stop(); } catch (e) { /* noop */ }
    }
    // 停止 MediaStream 所有 tracks，释放麦克风占用（降级路径）
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    modeRef.current = 'web';
    setRecordingState(false);
    // 没有进行中的识别/录音（文本已确认）→ 立即收尾；
    // 有的话由 onend / onstop 转写完成后统一 flush（避免文本丢失或 resolve 过早）
    if (!hadRecognition && !hadRecording) {
      flushTextAndResolve();
    } else {
      emitText();   // 停止后兜底刷新当前文本（最终确认后续由 onend/onstop 补齐）
    }
  };

  // 自动关闭：录音中点击页面任意处（除麦克风按钮外）即停止；组件卸载自动清理
  useEffect(() => {
    if (!recording) return;
    const onPointerDown = (e) => {
      if (btnRef.current && btnRef.current.contains(e.target)) return;
      stop();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  // 组件卸载（切换路由离开聊天页）：释放识别器/麦克风/VAD/分段定时器
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;   // 令在途 onstop 转写回调/onInterim 不再执行
      startGenRef.current++;      // 令在途 startMediaRecorder 失效
      if (gestureResumeRef.current) {
        document.removeEventListener('pointerdown', gestureResumeRef.current);
        document.removeEventListener('keydown', gestureResumeRef.current);
        gestureResumeRef.current = null;
      }
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch (e) { /* noop */ }
        recognitionRef.current = null;
      }
      stopVAD();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (mediaRef.current) {
        try { mediaRef.current.stop(); } catch (e) { /* noop */ }
        mediaRef.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
      analyserRef.current = null;
    };
  }, []);

  const start = () => {
    aliveRef.current = true;
    // 新一轮语音输入开始：重置"已发送"标志，允许 emitText 刷新输入框
    sentRef.current = false;
    // 重置已确认文本缓存（2026-08-24 修）：降级路径（MediaRecorder 本地识别）此前只在
    // Web Speech 的 onresult/onend 里重置 finalRef，startMediaRecorder 路径 start() 时不重置，
    // 上一轮录音的 finalRef 残留会导致本轮 currentText() 返回旧文字（语音输入"翻旧账"）
    finalRef.current = '';
    lastInterimRef.current = '';
    // Web Speech 曾失败（network 等，Google 服务国内不可达）→ 本会话后续直接走本地识别
    if (supportsSpeech && !webSpeechFailedRef.current) {
      startSpeechRecognition();
    } else {
      startMediaRecorder();
    }
  };

  // 对外暴露 stopAndGetText（聊天页发送按钮录音中点击：先停止录音并拿最终文本再发送）
  // 与 markTextSent（发送成功后标记，阻断延迟 emitText 写回输入框）
  useImperativeHandle(ref, () => ({ stopAndGetText, markTextSent }));

  return (
    <button
      ref={btnRef}
      onClick={recording ? stop : start}
      className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center border transition ${
        recording
          ? 'bg-red-500/90 border-red-400 text-white ring-4 ring-red-400/25 animate-pulse'
          : 'border-white/[0.15] bg-white/[0.08] text-stardust-300 hover:text-blush-300 hover:border-blush-400/40 hover:bg-white/[0.15]'
      }`}
      title={recording ? '停止（点击别处也会自动停止）' : '语音输入'}
    >
      {recording ? (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      ) : (
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
      )}
    </button>
  );
});

import { useEffect, useRef, useState } from 'react';
import { voiceApi, openStreamAsr } from '../api/voice';
import { sessionsApi } from '../api/sessions';
import { streamChat } from '../api/chat';
import { visionApi } from '../api/vision';
import { useModelStatus } from '../hooks/useModelStatus';
import { useAuth } from '../hooks/useAuth';
import VirtualAvatar from '../components/VirtualAvatar';
import { stripMarkdown } from '../utils/text';
import { MicVAD } from '@ricky0123/vad-web';
import { float32ToWavBlob } from '../utils/audio';

// 桌面助手固定会话键（08：全部问答归档到同一会话，避免碎片化）。
// 按用户隔离：key=desktop_session_id_{user.id}，切换账号不串号（对齐聊天页 chat_active_session_{user.id}）。
const desktopSessionKey = (userId) => `desktop_session_id_${userId}`;

// ---- Silero VAD（@ricky0123/vad-web v5，浏览器本地 ONNX 推理）----
// 替代旧的振幅阈值 + MediaRecorder 链路（2026-09-03，见 08 §3 / 04 §8）：
// 判断"是不是人声"而非"音量够不够大"——汽车/空调/旁人说话等噪声不再误触发录音、
// 监听永不因"噪声不停"而死锁。模型/工作线程/wasm 由 npm postinstall 拷贝到 public/vad2，
// 纯本地加载，无任何外网依赖。
const VAD_BASE_PATH = '/vad2/';        // v2：目录带版本号，换版本即绕开浏览器旧缓存（2026-09-03）
const VAD_ORT_PATH = '/vad2/ort/';     // onnxruntime-web 的 *.wasm + *.mjs
// Silero 判定参数（初值保守防误报；实测后回填：噪声仍误触发 → 上调 positive，
// 说话不识别/段切碎 → 下调 positive、上调 redemption）：
const VAD_POSITIVE_THRESHOLD = 0.6;   // 语音概率超过此值才计为语音帧（默认 0.3 过灵敏）
const VAD_NEGATIVE_THRESHOLD = 0.35;  // 概率低于此值计为非语音帧（须 < positive）
const VAD_REDEMPTION_MS = 400;        // 语尾停顿多久判定"说完了"（默认 1400 太长，拖慢收尾）
const VAD_PRE_SPEECH_PAD_MS = 300;    // 段前回补时长（不丢用户开口）
const VAD_MIN_SPEECH_MS = 300;        // 段短于此值丢弃（对齐原 MIN_VOICE_MS，防噪声段误转写）
const VAD_SPEAK_WARMUP_MS = 300;      // TTS 每句起播预热期：忽略期内人声判定（回声兜底）
const LAST_INTERRUPT_MS = 500;        // 打断防抖：距上次打断不足此值不再次打断（防 TTS 尾音回声连环自打断）
// 合并窗口：用户停止说话后，把之前累积的所有句子作为一轮统一发送（避免一句话拆多个回复）
// 2026-09-03 由 2.5s→1.8s→1.2s→0.4s→0.8s→1.0s：0.4s 实测会把长句中间的正常停顿误判成"说完了"
// 导致一句被拆成多段回复；0.8s 仍偏敏感（用户换气/想词常超 0.8s）。VAD 段切碎不丢字——
// 段转写只是追加进缓冲并重挂窗口，真正影响"拆不拆轮"的只有此窗口。回 1.0s：正常意群停顿
// 与换气都在窗口内，只有真正停聊才 flush（停顿超 1s 后接话 = 打断重答，两句连续发，见 sendTurn）
const MERGE_WINDOW_MS = 1000;
// 合并缓冲长度上限：超过立即 flush，防无限累积
const MAX_PENDING_LEN = 500;

// 句级 TTS 合成防碎片下限（2026-09-03）：普通**完整句**（句号/叹号结尾）已由 onDelta 立即入队合成
//（2026-09-03 首响提速，台账 37 节：等攒字会让小亦的短口癖句如"唔……我懂了！"拖晚出声）；
// 此阈值只兜底**无句号结尾的半截碎片**（流尚未吐完标点/清洗后偶发）与学长锁定中的累积——
// 太短的碎片会让 edge-tts 失去上下文（中文多音字如"学长"读 zhǎng 消歧失败 → 稳定读错），
// 攒到该长度才整段入队合成；流结束时残留不足长度的也照常补入，不丢句。
const MIN_TTS_CHARS = 18;   // 约一个完整意群/半句的长度，可调

// 句边界：最后一个完整句子结束的字符索引（。！？!?\n 等分隔），无完整句返回 -1。
// 用于句级 TTS：回复流式到达时按句切分，完整句子尽早入队播放（首句提前合成，不等整段流完）。
// 注意：… 故意不算边界——省略号是句中停顿而非句末，切断会导致逐段合成停顿（2026-09-03）
const lastSentenceBoundary = (text) => {
  let last = -1;
  for (let i = 0; i < text.length; i++) {
    if ('。！？!?\n'.includes(text[i])) last = i + 1;
  }
  return last;
};

// 高危多音字词表（2026-09-03）：这些词在短句里 edge-tts 可能消歧失败读错（如"学长"读成 cháng）。
// 处理方式是"上下文哨兵"而非改字（2026-09-03 改）：含这些词的句子不按标点常规入队，
// 进入 riskHeldRef 锁定态吞并后续内容，直到凑成一个完整句号结尾的语义段才送合成，
// 让引擎拿到完整上下文自己读对（称呼/文字一律原样，不做任何替换）。
// 取舍：含高危词的句子宁可多等 0.5~1s 也要读对（用户 2026-09-03 确认）。
const TTS_RISK_WORDS = ['学长'];
const hasTtsRiskWord = (text) => TTS_RISK_WORDS.some((w) => text.includes(w));

// ---- 流式 ASR（sherpa-onnx，04 §8 / 台账 38 节，"边听边出字"）----
// 流式识别器无热词功能，小亦名字的同音/形近变体（小艺/小依/小E/XIAOYI…）在提交进合并缓冲前
// 统一修正回「小亦」——修正只作用于提交层（final/whisper 共用路径），partial 上屏保持原样
//（用户正在看自己说的话，不改字；正式进模型前才归一，防模型跟着念错名）。
const ASR_NAME_FIXES = [
  [/小艺/g, '小亦'], [/小依/g, '小亦'], [/小亿/g, '小亦'], [/小E/gi, '小亦'],
  [/小一/g, '小亦'], [/XiaoYi/gi, '小亦'], [/XIAOYI/gi, '小亦'],
];
const fixAsrNames = (text) => {
  let out = text || '';
  for (const [re, to] of ASR_NAME_FIXES) out = out.replace(re, to);
  return out;
};
// 帧滚动缓冲：onFrameProcessed 持续保留最近 N 帧（vad-web 每帧 512 样本 ≈32ms@16k），
// speech_start 时先补发给后端（镜像 vad-web 的 preSpeechPad 回补语义，防丢首字/首音节）。
const PRE_SPEECH_RING_FRAMES = 10;   // ≈320ms 人声前缓冲（对齐 VAD_PRE_SPEECH_PAD_MS=300）

// 错误码 → 友好文案（桌面助手）：后端错误帧通常已是中文友好句，这里只映射特殊码
const friendlyError = (raw, code) => {
  if (code === 'chat_model_not_configured') return '您还没有配置对话模型，请到设置页配置';
  if (code === 'network_error') return '网络异常，请确认后端服务已启动';
  return raw || '未知错误，请重试';
};

let turnSeq = 0; // 转录面板消息 id（本地递增，无需持久化）

export default function DesktopAssistant() {
  const [isListening, setIsListening] = useState(false);
  const [status, setStatus] = useState('等待中...');
  const [volume, setVolume] = useState(0);          // 实时音量（VAD level 节流渲染音量条，0~100）
  const [micError, setMicError] = useState('');     // 麦克风启动失败原因（权限被拒/无设备/被占用）
  const [turns, setTurns] = useState([]);        // 内部流转态：每轮 user/assistant 消息（打断固定/重播语义仍用；
                                              // 2026-09-03 起渲染层改为底部三态玻璃卡，不再 map 历史，见渲染块）
  const [streamingId, setStreamingId] = useState(null); // 正在流式输出的 assistant turn id
  const [liveUserText, setLiveUserText] = useState('');       // 三态卡·态1：用户正在说的话（转写逐段实时上屏）
  const [liveAssistantText, setLiveAssistantText] = useState(''); // 三态卡·态3：小亦正在输出的内容（流式 delta 驱动）
  const [asrPartial, setAsrPartial] = useState(false);        // 态1是否"识别中"（流式 partial 上屏，尾光标闪烁暗示；
                                                              // final/取消后转实，见 08 §4）
  const [lastReply, setLastReply] = useState('');       // 最近一条回复纯文本（显示/启用「重播上一条」按钮）
  const [avatarState, setAvatarState] = useState('idle'); // 虚拟形象状态：idle/listening/thinking/speaking
  const [visionEnabled, setVisionEnabled] = useState(false); // 视觉模式（12 §5）：开启才允许摄像头轮询
  const { chat_configured: chatConfigured } = useModelStatus();
  const { user } = useAuth();
  // onstop → processVoice 是首次渲染建立的闭包，须用 ref 读取最新配置状态
  const chatConfiguredRef = useRef(false);
  useEffect(() => { chatConfiguredRef.current = chatConfigured; }, [chatConfigured]);
  // 转录面板自动滚动：turns/流式状态变化时始终跟随最新消息，无需手动翻
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, streamingId]);
  const abortRef = useRef(null);       // 当前对话的 AbortController（打断时中断流式请求）
  const micVadRef = useRef(null);      // Silero MicVAD 实例（启动成功后才赋值；停止时 destroy）
  const contextResumeTimerRef = useRef(null); // AudioContext 兜底 resume 定时器（autoplay 策略挂起时）
  const audioContextRef = useRef(null);
  const sessionIdRef = useRef(null);
  const suppressRef = useRef(false);   // TTS 播放期间屏蔽 VAD，避免把回复识别成输入
  const audioRef = useRef(null);       // 当前播放的回复音频（停止监听/打断时中断）
  const streamRef = useRef(null);      // getUserMedia 的 stream（单独保存，停麦第一时间停 tracks）
  const aliveRef = useRef(true);       // 组件存活标志（卸载后不再播放 TTS，但对话落库不受影响）
  const genRef = useRef(0);            // 对话代际计数器：打断时 +1，令在途 processVoice 过期
  const startGenRef = useRef(0);       // 麦克风启动代际计数器：防异步 start 覆盖 stop/卸载后泄漏流
  const busyRef = useRef(false);       // true=思考中或播放回复中（此时检测到用户语音即打断）
  const suppressStartRef = useRef(0);  // TTS 开始播放时刻（起播预热期内忽略人声判定，回声兜底）
  const lastInterruptAtRef = useRef(0);        // 上次打断时刻（performance.now()，打断防抖）
  const suppressNextSegmentRef = useRef(false); // 丢弃下一段人声（TTS 预热/防抖期内的回声段）
  const pendingTextRef = useRef('');          // 合并缓冲：当前轮累积的语音文本（停顿 MERGE_WINDOW_MS 后统一发送）
  const finalizeTimerRef = useRef(null);      // 合并窗口定时器：用户停止说话 MERGE_WINDOW_MS 后 flush 一轮
  const pendingTranscribeRef = useRef(0);     // 在途转写段计数（flush 守卫：有转写未完成不 flush，
                                              // 防"窗口先到点但文本还没转写出来"把一句拆两半，见 08 §4）
  const activeUserTurnIdRef = useRef(null);   // 当前正在累积的用户消息 turn id（转写逐段实时上屏，flush 时封口）
  const lastReplyRef = useRef('');            // 最近一条回复纯文本（「重播上一条」按钮用，与 lastReply state 同步）
  const transcriptRef = useRef(null);  // 转录面板容器 DOM（自动滚动跟随最新）
  const avatarRef = useRef(null);      // 虚拟形象组件引用（bindAudio 口型同步 / setMuted）
  const gestureResumeRef = useRef(null); // AudioContext 用户激活兜底的一次性监听器（stop/卸载时移除）
  const thinkingPendingRef = useRef(''); // 思考打字机：待显示的剩余思考内容
  const thinkingTimerRef = useRef(null); // 思考打字机：逐字 reveal 定时器（interrupt/卸载时清理）
  const pageFocusedRef = useRef(true);        // 页面聚焦标志：blur 时置 false，抑制 TTS 出声（文字照常落库）
  const visionEnabledRef = useRef(false);     // 视觉模式开关 ref（processVoice 等闭包读取最新值）
  const cameraVideoRef = useRef(null);        // 摄像头实时画面 <video>（视觉模式背景，12 §5）
  const cameraStreamRef = useRef(null);       // 摄像头 video track 流（与麦克风流分离，独立启停）
  const visionPollRef = useRef(null);         // 轮询定时器 id（视觉模式开启时按间隔截帧上传）
  const visionBusyRef = useRef(false);        // 轮询上传防并发：上一张未完成则跳过本次
  const speechQueueRef = useRef([]);          // 句级 TTS 待播句子队列（首句提前合成播放，边流式边出声）
  const speechCursorRef = useRef(0);          // 已入队 TTS 的 assistantText 字符位置
  const speechPlayingRef = useRef(false);     // 句级 TTS 是否正在播放（串行逐句播放）
  const pendingSpeechRef = useRef('');        // 未达 MIN_TTS_CHARS 的短句暂存（攒够再入队合成，保上下文消歧）
  const riskHeldRef = useRef(false);          // 高危多音词"上下文锁定"态（2026-09-03）：命中 TTS_RISK_WORDS 后为 true，
                                              // 吞并后续 delta 直到凑成完整句号结尾的整段语义才入队合成（见 onDelta）
  const replyFinishedRef = useRef(false);     // 本轮流式是否已结束（finish 调用过，用于句队列收尾）
  const lastVolumeSentRef = useRef(0);        // 音量条 setState 节流（避免每帧 setState）
  const assistantTextRef = useRef('');        // 本轮已流式到达的回复文字（打断时固定到面板，不丢失）
  const thinkingTextRef = useRef('');         // 本轮思考全文（已揭晓+待揭晓；打断时固定，不丢弃）
  // ---- 流式 ASR（sherpa-onnx，"边听边出字"，04 §8 / 台账 38 节）----
  const streamAsrRef = useRef(null);          // openStreamAsr 句柄（含 start/end/cancel/sendAudio/close 与 handle.*）
  const streamAsrOkRef = useRef(false);       // 流式 ASR 可用（WS 已 ready 且模型就绪）；false → faster-whisper 兜底
  const inSpeechRef = useRef(false);          // 正在说话（onSpeechStart~onSpeechEnd）：帧转发与 end/cancel 的门控
  const preSpeechRingRef = useRef([]);        // 最近 ~10 帧滚动缓冲（speech_start 补发，防丢首字）
  const partialRef = useRef('');              // 当前段最近一次 partial 文本（cancel/打断/收尾时清同步）
  const streamSegGenRef = useRef(0);          // 本语音段开始时的对话代际（final 回来校验：打断后旧段丢弃）

  // 麦克风启动失败 → 面向用户的原因描述（地址栏锁图标/设备/占用三类）
  const describeMicError = (e) => {
    const name = e?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '麦克风权限被拒，请点击浏览器地址栏左侧的锁图标，允许使用麦克风后重试';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '未检测到麦克风设备，请检查是否已插入/开启';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return '麦克风被其他应用占用，请关闭占用程序后重试';
    }
    return `麦克风启动失败：${e?.message || name || '未知错误'}`;
  };

  // 初始化固定会话：localStorage 复用已有 id，无则创建 source=desktop 会话；
  // 已有会话时顺带把最近消息加载进转录面板（打开页面就能看到之前的对话，而非空白）
  useEffect(() => {
    const sessionKey = desktopSessionKey(user?.id);
    const cached = localStorage.getItem(sessionKey);
    if (cached) {
      sessionIdRef.current = cached;
      sessionsApi
        .get(cached)
        .then((s) => {
          const msgs = (s?.messages || [])
            .slice()
            .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
          if (!msgs.length) return;
          setTurns(msgs.slice(-40).map((m) => ({
            id: `hist_${m.id}`,
            role: m.role,
            content: m.content || '',
            thinking: m.thinking || '',
          })));
        })
        .catch((e) => console.error('load desktop history failed:', e));
      return;
    }
    sessionsApi
      .create('desktop')
      .then((s) => {
        sessionIdRef.current = s.id;
        localStorage.setItem(sessionKey, s.id);
      })
      .catch((e) => console.error('create desktop session failed:', e));
  }, [user?.id]);

  // 纯自动监听：打开页面即开始，切换路由/离开页面（组件卸载）自动停止，无手动按钮
  useEffect(() => {
    aliveRef.current = true;
    startListening();
    return () => {
      aliveRef.current = false;
      // 卸载时中断在途 SSE 流，防卸载后 setState-on-unmounted（2026-08-17 修）
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      stopListening();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 页面失焦自动关闭：切到别的浏览器标签页/最小化/失焦时立即停止监听并释放麦克风；
  // 回到页面且组件仍挂载时自动恢复监听（start/stop 幂等，防重复启动）。
  // blur（点地址栏/其他窗口/开发者工具）不伴随 hidden 切换，须用 focus 事件补齐恢复。
  useEffect(() => {
    const handleVisibility = () => {
      if (!aliveRef.current) return;
      if (document.hidden) {
        pageFocusedRef.current = false;
        stopListening();
      } else {
        pageFocusedRef.current = true;
        startListening();
      }
    };
    const handleBlur = () => {
      pageFocusedRef.current = false;
      if (aliveRef.current) stopListening();
    };
    const handleFocus = () => {
      pageFocusedRef.current = true;
      if (aliveRef.current && !document.hidden) startListening();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startListening = async () => {
    if (streamRef.current) return;   // 幂等：已在监听时不重复启动（blur/focus 交错触发的保护）
    const gen = ++startGenRef.current;   // 记录本次启动代际，stop/卸载后本代际即失效
    if (!navigator.mediaDevices?.getUserMedia) {
      const msg = '当前环境不支持麦克风，请用 localhost 或 HTTPS 访问';
      setStatus(msg);
      setMicError(msg);
      setIsListening(false);
      return;
    }
    let stream;
    try {
      // 开启 AEC/降噪/自动增益：TTS 回复声被麦克风拾回是"自打断/回声转写"的源头，
      // echoCancellation 让浏览器消除自己扬声器的回声（部分设备/浏览器不支持则降级重试）
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (e) {
        if (gen !== startGenRef.current || !aliveRef.current) return;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch (e) {
      // await 挂起期间可能已被 stopListening（blur/切页）或组件卸载：忽略过期错误
      if (gen !== startGenRef.current || !aliveRef.current) return;
      const msg = describeMicError(e);
      setStatus(msg);
      setMicError(msg);
      setIsListening(false);
      return;
    }
    // 异步期间被 stop/卸载：立即释放刚拿到的流，防止 start 覆盖 stop 状态并泄漏麦克风
    if (gen !== startGenRef.current || !aliveRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;
    try {
      audioContextRef.current = new AudioContext();
      // 自动播放策略：无用户手势时 AudioContext 为 suspended，AudioWorklet 不产帧、
      // Silero 永远检测不到人声（"听不到说话"的根因）。启动即 resume；若仍 suspended
      //（首次授权的权限弹窗可能耗尽用户激活窗口），注册一次性点击/按键兜底 + 低频
      // 定时器持续尝试 resume（见 contextResumeTimerRef），直到恢复运行。
      if (audioContextRef.current.state === 'suspended') {
        try { await audioContextRef.current.resume(); } catch (e) { /* noop */ }
      }
      // 首次授权时 getUserMedia 的权限弹窗可能耗尽浏览器"用户激活"窗口（约 5s），
      // resume 会静默失败（context 仍 suspended）。注册一次性点击/按键监听，
      // 用户下次点击页面时 resume 并自移除（再挂起时由下方低频定时器兜底）。
      if (audioContextRef.current.state !== 'running') {
        gestureResumeRef.current = () => {
          try { audioContextRef.current?.resume(); } catch (e) { /* noop */ }
          document.removeEventListener('pointerdown', gestureResumeRef.current);
          document.removeEventListener('keydown', gestureResumeRef.current);
          gestureResumeRef.current = null;
        };
        document.addEventListener('pointerdown', gestureResumeRef.current);
        document.addEventListener('keydown', gestureResumeRef.current);
        // 低频兜底：某些浏览器手势丢失后 context 会再次挂起，此处周期性 resume 直到恢复
        //（Silero 在 AudioWorklet 里判人声，context 挂起则永远听不到——替代旧振幅 VAD 的每帧 resume）
        if (!contextResumeTimerRef.current) {
          contextResumeTimerRef.current = setInterval(() => {
            const ctx = audioContextRef.current;
            if (!ctx) {
              clearInterval(contextResumeTimerRef.current);
              contextResumeTimerRef.current = null;
              return;
            }
            if (ctx.state === 'running') {
              clearInterval(contextResumeTimerRef.current);
              contextResumeTimerRef.current = null;
            } else {
              try { ctx.resume(); } catch (e) { /* noop */ }
            }
          }, 500);
        }
      }

      // 装配 Silero VAD（@ricky0123/vad-web v5，ONNX 本地推理）：
      //   - 模型/工作线程/wasm 全由 public/vad 提供（npm postinstall 拷贝），无外网依赖；
      //   - getStream 喂已拿到的 stream（默认实现会自己再 getUserMedia 一次，多开一路麦克风）；
      //   - MicVAD.new 即拉模型并 start（startOnLoad 默认 true），AudioWorklet 线程判人声，
      //     整段人声在 onSpeechEnd 回调给出，不再需要 MediaRecorder 手动分片。
      const vad = await MicVAD.new({
        getStream: async () => streamRef.current,
        audioContext: audioContextRef.current,
        model: 'v5',
        baseAssetPath: VAD_BASE_PATH,
        onnxWASMBasePath: VAD_ORT_PATH,
        ortConfig: (ort) => {
          ort.env.logLevel = 'error';
          ort.env.wasm.numThreads = 1;   // 单线程推理：部署无需 COOP/COEP 跨源隔离头
        },
        positiveSpeechThreshold: VAD_POSITIVE_THRESHOLD,
        negativeSpeechThreshold: VAD_NEGATIVE_THRESHOLD,
        redemptionMs: VAD_REDEMPTION_MS,
        preSpeechPadMs: VAD_PRE_SPEECH_PAD_MS,
        minSpeechMs: VAD_MIN_SPEECH_MS,
        submitUserSpeechOnPause: true,   // 停录时把未说完尾段交回 onSpeechEnd（对齐旧"末段不丢"）
        ...buildVadHandlers(),
      });
      if (gen !== startGenRef.current || !aliveRef.current) {
        // await 拉模型期间被 stop/卸载：销毁刚建好的 VAD 并释放流，不让其覆盖 stop 状态
        try { await vad.destroy(); } catch (e2) { /* noop */ }
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        return;
      }
      micVadRef.current = vad;
      // 流式 ASR（04 §8，sherpa-onnx "边听边出字"）：VAD 就绪后开 WS（纯本地、无阻塞）。
      // ready 帧确认模型可加载后才置可用（streamAsrOkRef）——期间/失败时语音流程不受影响，
      // onSpeechEnd 自动走 faster-whisper 一次性转写兜底（见 buildVadHandlers）。重复启动
      //（blur/focus 交替）会先 close 旧连接再开新的，不会堆叠。
      try {
        const asrClient = openStreamAsr();
        streamAsrRef.current = asrClient;
        asrClient.handle.onReady = () => {
          if (aliveRef.current && streamAsrRef.current === asrClient) {
            streamAsrOkRef.current = true;
          }
        };
        // partial：边说边出字——仅实时上屏（态1，带闪烁光标），不提交缓冲
        //（流式识别字会回跳改口，只有 final 才是定稿，防污染已合并文本，见 08 §4）
        asrClient.handle.onPartial = (text) => {
          if (!inSpeechRef.current) return;   // 段已收尾后的迟到 partial 忽略（final 已提交）
          partialRef.current = text;
          setAsrPartial(true);
          // 前段已确认未发送的内容 + 当前段 partial 一起上屏（用户看完整句在长成）
          setLiveUserText(pendingTextRef.current
            ? `${pendingTextRef.current}${text}`
            : text);
        };
        asrClient.handle.onFinal = async (raw) => {
          inSpeechRef.current = false;
          setAsrPartial(false);
          const text = fixAsrNames(raw || '').trim();
          // 代际校验：本段识别期间对话已被打断（gen 变化）→ 旧段丢弃防污染新一轮
          //（镜像 whisper 路径 processVoice 的 gen 检查；正常链路段间 gen 不变）
          if (streamSegGenRef.current !== genRef.current || !aliveRef.current) return;
          if (!text) {
            // 空转写（环境声误触发/太模糊）：静默恢复监听，不显示"出错"
            setLiveUserText(pendingTextRef.current || '');
            setStatus('正在监听...');
            return;
          }
          // 视觉触发词（12 §3.2）：说「快看快看」等立即截帧拍照（与 whisper 路径同语义）
          if (visionEnabledRef.current && /快看|快看看|你看|看这个/.test(text)) {
            pendingTextRef.current = '';
            activeUserTurnIdRef.current = null;
            setLiveUserText('');
            setStatus('收到，正在拍照看看...');
            try { await triggerPhotoTalk(text); } catch (e) { console.error('photo talk failed:', e); }
            return;
          }
          commitUserText(text);
        };
        asrClient.handle.onError = (detail) => {
          // 模型未下载 / 后端未重建 / 网络断：静默回退 whisper（语音流程不打断）
          if (streamAsrOkRef.current) console.warn('stream asr error:', detail);
          streamAsrOkRef.current = false;
          if (streamAsrRef.current === asrClient) {
            streamAsrRef.current = null;
            try { asrClient.close(); } catch (e) { /* noop */ }
          }
          // 本段若正在流式识别中途 error：inSpeech 复位，语音照常收尾走 whisper 兜底
          if (inSpeechRef.current) inSpeechRef.current = false;
        };
      } catch (e) {
        console.warn('stream asr open failed:', e);
        streamAsrOkRef.current = false;   // 静默回退一次性转写
      }
    } catch (e) {
      // 初始化失败（AudioContext / VAD 模型加载 / worklet 任一步）：释放流并提示，
      // 由「重新启动监听」按钮恢复，不留静默死状态
      if (gen === startGenRef.current && aliveRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        try { audioContextRef.current?.close(); } catch (e2) { /* noop */ }
        audioContextRef.current = null;
        const msg = `音频初始化失败：${e?.message || '未知错误'}`;
        setStatus(msg);
        setMicError(msg);
        setIsListening(false);
      }
      return;
    }
    setMicError('');
    setIsListening(true);
    setVolume(0);
    setAvatarState('listening');   // 虚拟形象：进入倾听状态
    setStatus('正在监听...');
    // 切页回来：若合并缓冲还有未发送内容，重新挂上合并窗口（不丢已听句子）
    if (pendingTextRef.current && !finalizeTimerRef.current) {
      finalizeTimerRef.current = setTimeout(flushPendingTurn, MERGE_WINDOW_MS);
    }
  };

  // 打断当前思考/回复：用户开口时调用，中断在途流式请求、停止 TTS、令在途 processVoice 过期，转听新语音
  const interrupt = () => {
    genRef.current += 1;              // 令在途 processVoice 过期（已发后端的对话照常落库）
    // 三态卡复位：打断 = 用户已开口，旧的"你说/正在输出"立即退场（新话转写中会重新驱动态1）
    setLiveUserText('');
    setLiveAssistantText('');
    setAsrPartial(false);             // 打断时若有 partial 识别中，作废（新段重新起）
    partialRef.current = '';
    abortRef.current?.abort();        // 中断流式生成（SSE 连接断开）
    abortRef.current = null;
    // 停止思考打字机定时器；把剩余未揭晓的思考并入累积，不丢弃（打断后思路保留在面板）
    if (thinkingTimerRef.current) {
      clearInterval(thinkingTimerRef.current);
      thinkingTimerRef.current = null;
    }
    if (thinkingPendingRef.current) {
      thinkingTextRef.current += thinkingPendingRef.current;
      thinkingPendingRef.current = '';
    }
    busyRef.current = false;
    suppressRef.current = false;      // 恢复 VAD 正常处理（不再屏蔽音量）
    setStreamingId(null);
    setAvatarState('listening');   // 虚拟形象：打断后回到倾听
    if (audioRef.current) {
      audioRef.current.pause();       // 立即停止播放中的回复
      audioRef.current = null;
    }
    clearTimeout(finalizeTimerRef.current);   // 打断后进入新一轮：取消旧的合并窗口
    finalizeTimerRef.current = null;
    // 句级 TTS 播放链终止：清队列 + 复位在播标志（audioRef 已 pause，onended 不会触发）
    speechQueueRef.current = [];
    pendingSpeechRef.current = '';   // 同步清未达阈值的短句暂存，防串到下一轮
    riskHeldRef.current = false;     // 同步解除高危词锁定态（2026-09-03 哨兵）
    speechPlayingRef.current = false;
    // 若合并缓冲还有未发送内容，重新挂合并窗口（防打断后句子永久滞留不发送）
    if (pendingTextRef.current) {
      finalizeTimerRef.current = setTimeout(flushPendingTurn, MERGE_WINDOW_MS);
    }
    suppressStartRef.current = 0;
    // 不在此处开录：Silero 从 onSpeechStart 起已在内部缓冲本段人声，打断只中止回复/思考，
    // 本段语音会在 onSpeechEnd 整段交回 processVoice（不丢开头，替代旧 armed/dropNext 机制）
    // 固定被中断一轮的最终状态：已生成的思考与文字保留并标记「（已打断）」——
    // 此前打断会把未揭晓的思考清空、空白占位 turn 整条删除，用户补话时"第一句回答就没了"。
    // 仅当完全空白（尚未产生任何思考/文字）的占位 turn 才删除（不留空气泡）。
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      if (!last.content && !last.thinking) {
        return prev.slice(0, -1);
      }
      return [...prev.slice(0, -1), {
        ...last,
        content: assistantTextRef.current || last.content,
        thinking: thinkingTextRef.current || last.thinking,
        interrupted: true,
      }];
    });
    setStatus('听到你了，请说...');
  };

  // 用户语音文本提交：追加进合并缓冲并实时上屏（04 §8：whisper 一次性转写与流式 ASR final 共用同一提交路径）。
  // 调用方负责：非空文本、代际/存活校验、触发词分支；本函数只管"追加缓冲 + 上屏 + 超长立即 flush"。
  const commitUserText = (text) => {
    const merged = (pendingTextRef.current + text).trim();
    pendingTextRef.current = merged;
    // 三态卡·态1：识别完成即"你说"实时上屏（即说即看）；partial 期间置为实（转实，去闪烁光标）
    setLiveUserText(merged);
    setAsrPartial(false);
    // 实时上屏：追加到转录面板当前用户消息（边说边上屏，不等合并窗口结束）
    if (activeUserTurnIdRef.current) {
      const uid = activeUserTurnIdRef.current;
      setTurns((prev) => prev.map((t) => (t.id === uid ? { ...t, content: t.content + text } : t)));
    } else {
      const uid = `turn_${++turnSeq}`;
      activeUserTurnIdRef.current = uid;
      setTurns((prev) => [...prev, { id: uid, role: 'user', content: text }]);
    }
    // 状态栏提示已听到的内容（超 50 字截断）
    const shown = merged.length > 50 ? `${merged.slice(0, 50)}…` : merged;
    setStatus(`已听到：${shown}（停顿 ${(MERGE_WINDOW_MS / 1000).toFixed(1)} 秒后自动发送）`);
    // 防无限累积：缓冲过长立即 flush（flush 会清定时器，flush 过则无需补挂）
    if (pendingTextRef.current.length > MAX_PENDING_LEN) flushPendingTurn();
    // 兜底补挂（流式 final 场景）：final 若在窗口空跑后才到（窗口到点 flush 时空缓冲直接返回），
    // 此处补挂保证新提交文本最终一定送出（whisper 路径由 processVoice.finally 兜底，殊途同归）
    if (!finalizeTimerRef.current) scheduleMergeWindow();
  };

  // 开启流式语音段（onSpeechStart 里"本段要识别"的路径调用）：通知后端建流 + 补发帧缓冲 + 置识别态。
  // 本段被丢弃（TTS 预热/防抖回声、busy 打断防抖）时 onSpeechStart 不调用本函数，段帧也不转发。
  const beginStreamSegment = () => {
    if (!streamAsrOkRef.current || inSpeechRef.current) return;
    inSpeechRef.current = true;
    partialRef.current = '';
    streamAsrRef.current?.start();
    // 补发最近 ~10 帧：VAD onSpeechStart 判定滞后于人声起点，滚动缓冲镜像 preSpeechPad
    //（~320ms），让后端从人声真正开头开始解码（防丢首字/首音节，04 §8）
    for (const f of preSpeechRingRef.current) {
      if (!streamAsrRef.current?.sendAudio(f)) break;
    }
    preSpeechRingRef.current = [];
  };

  // ---- Silero VAD 回调（@ricky0123/vad-web）----
  // 取代旧振幅阈值 + MediaRecorder 链路（2026-09-03，08 §3 / 04 §8）：
  //   - onSpeechEnd 给出整段人声（16k 单声道 Float32Array，含 preSpeechPadMs 回补），
  //     直接编码 WAV → processVoice（合并窗口/触发词/转写等下游完全复用）；
  //   - 过短段（噪声/鼠标声）不触发 onSpeechEnd，只触发 onVADMisfire（自动丢弃，
  //     替代旧 armed/dropNext 机制）；
  //   - 打断语义对齐旧三态：busy=思考中 → 打断；suppress=TTS 播放中 → 起播预热期或
  //     距上次打断不足 LAST_INTERRUPT_MS 时不打断且整段丢弃（回声兜底），否则打断；
  //     空闲监听 → 只提示不打断（Silero 自己管理段缓冲，从人声起点起就不丢开头）。
  const buildVadHandlers = () => ({
    onSpeechStart: () => {
      const now = performance.now();
      let shouldDiscard = false;   // 本段回声/防抖误判 → 丢弃（不 begin 流式、onSpeechEnd 时 cancel）
      if (suppressRef.current) {
        // TTS 播放中：起播预热期（回声未消）或打断防抖期内 → 不打断，并丢弃本段（防回声误转写）
        const inWarmup = suppressStartRef.current
          && (now - suppressStartRef.current <= VAD_SPEAK_WARMUP_MS);
        if (inWarmup || now - lastInterruptAtRef.current < LAST_INTERRUPT_MS) {
          suppressNextSegmentRef.current = true;
          shouldDiscard = true;
        } else {
          suppressNextSegmentRef.current = false;
          lastInterruptAtRef.current = now;
          interrupt();
        }
      } else if (busyRef.current) {
        // 思考中（模型还没开口）：用户开口即打断，进入新一轮语音
        lastInterruptAtRef.current = now;
        interrupt();
      } else {
        // 空闲正常监听：用户开口，提示已听到（段缓冲由 Silero 接管，不丢开头）
        setStatus('听到你了，请说...');
      }
      // 本段要识别（未丢弃）→ 流式 ASR 建流 + 帧缓冲补发（边说边出字）；段帧由 onFrameProcessed 转发
      if (!shouldDiscard) beginStreamSegment();
    },
    onSpeechEnd: (audio) => {
      // TTS 预热/打断防抖期内误判的人声段（回声）：整段丢弃——流式若已开启则 cancel（不入缓冲）
      if (suppressNextSegmentRef.current) {
        suppressNextSegmentRef.current = false;
        if (inSpeechRef.current) {
          inSpeechRef.current = false;
          streamAsrRef.current?.cancel();
          partialRef.current = '';
          setAsrPartial(false);
          setLiveUserText(pendingTextRef.current || '');   // 丢弃段不残留 partial，回显已确认内容
        }
        return;
      }
      // 流式 ASR 路径：停转发、end 收 final——final 统一走 commitUserText，不重复进 whisper
      if (inSpeechRef.current && streamAsrOkRef.current) {
        inSpeechRef.current = false;
        streamSegGenRef.current = genRef.current;   // final 回来校验代际（异常打断时旧段丢弃）
        setStatus('识别中...');
        // 首响提速（2026-09-04，台账 41 节）：合并窗口从"停嘴"起算、与后端 final 收尾并行。
        // 旧实现 final 回来才由 commitUserText 兜底补挂（final <300ms 本地 WS 仍白等 final+1s
        // 才发请求，比 whisper 路径固定慢 ~0.5-1s）；此处先行挂窗对齐下方 whisper 兜底分支——
        // final 通常远早于窗口到点到达，commitUserText 有"无窗才补挂"守卫不重置窗口，总延迟
        // 收敛到 1s（自停嘴）。用户续说会由下一段 onSpeechEnd 重置窗口，合成语义不变。
        scheduleMergeWindow();
        streamAsrRef.current?.end();
        return;
      }
      // 兜底路径：流式不可用（WS 未就绪 / 模型未下载 / 本段帧未转发）→ faster-whisper 一次性转写
      setStatus('识别中...');
      try {
        const wav = float32ToWavBlob(audio, 16000);
        if (wav) {
          // 在途转写计数 +1（flush 守卫：转写未完成不 flush，防拆句，见 flushPendingTurn）
          pendingTranscribeRef.current += 1;
          // 首响提速（2026-09-03，台账 37 节）：合并窗口从"停嘴"时刻起算，与 ASR 转写并行——
          // 旧实现窗口在转写完成（0.5~1s 后）才挂，用户停嘴后要白等 转写+窗口 ≈2s 才发请求。
          // 用户续说会不断清旧重挂（见本函数各 speech end），只有真正静默到点才 flush。
          scheduleMergeWindow();
          processVoice(wav);
        }
      } catch (e) {
        console.error('encode vad audio failed:', e);
        setStatus('正在监听...');
      }
    },
    onVADMisfire: () => {
      // 短于人声下限的段（鼠标声/环境瞬态）：Silero 不送 onSpeechEnd——流式若已 begin 须 cancel 丢弃
      if (inSpeechRef.current) {
        inSpeechRef.current = false;
        streamAsrRef.current?.cancel();
        partialRef.current = '';
        setAsrPartial(false);
        setLiveUserText(pendingTextRef.current || '');
      }
    },
    onFrameProcessed: (_prob, frame) => {
      // 流式 ASR 帧转发（04 §8）：说话期间把人声帧推给后端在线识别，边说边出字。
      // 滚动缓冲保留最近 ~10 帧（speech_start 补发用，恒在窗口内，不随说话/静默清空）。
      // 注意：vad-web 的 frame 缓冲可能被复用原地改写——存入 ring 时必须 slice 拷贝，
      // 否则 speech_start 补发时 10 帧早已被后续帧覆盖成同一内容（首字仍丢）。
      const ring = preSpeechRingRef.current;
      ring.push(frame.slice());
      if (ring.length > PRE_SPEECH_RING_FRAMES) ring.shift();
      if (inSpeechRef.current && streamAsrOkRef.current) {
        streamAsrRef.current?.sendAudio(frame);
      }
      // 音量条：帧 RMS（150ms 节流渲染，避免每帧 setState 重渲染组件）
      const now = performance.now();
      if (now - lastVolumeSentRef.current <= 150) return;
      lastVolumeSentRef.current = now;
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      setVolume(Math.min(100, Math.round(Math.sqrt(sum / frame.length) * 250)));
    },
  });

  // 合并窗口到期：把累积的所有句子作为一轮统一发送（用户停顿确认说完，避免一句话拆多个回复）
  const flushPendingTurn = () => {
    if (finalizeTimerRef.current) {
      clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    }
    // 在途转写守卫（2026-09-03 首响提速，台账 37 节）：合并窗口从"停嘴"起算后，慢转写
    //（长段/CPU 忙）可能让窗口比转写先到点——此刻文本还没进缓冲，直接 flush 会把一句话
    // 拆成两半。顺延窗口等转写回来（转写完成补挂逻辑见 processVoice finally）。
    if (pendingTranscribeRef.current > 0) {
      finalizeTimerRef.current = setTimeout(flushPendingTurn, MERGE_WINDOW_MS);
      return;
    }
    // 注意：activeUserTurnIdRef 的封口统一交给 sendTurn 处理（语音/文字两条路径都要封口）
    const text = pendingTextRef.current.trim();
    pendingTextRef.current = '';
    if (!text) return;
    sendTurn(text);
  };

  // 合并窗口挂载 helper（2026-09-03 首响提速）：清掉旧窗（若有）后，从现在起挂一轮
  // MERGE_WINDOW_MS 到点 flush。onSpeechEnd（每段语音结束）与 processVoice 兜底处调用——
  // 窗口从"这次停嘴/这次转写回来"起算；用户续说会再次调用不断顺延，只有真正静默到点才 flush。
  const scheduleMergeWindow = () => {
    if (finalizeTimerRef.current) {
      clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    }
    finalizeTimerRef.current = setTimeout(flushPendingTurn, MERGE_WINDOW_MS);
  };

  // 播放回复（TTS）：先 stripMarkdown 清洗 markdown 符号，再请求合成并播放。
  // 播放期间 suppressRef=true 屏蔽 VAD（回复回声不触发打断，用户开口才是突发能量）；
  // 静音开关打开时跳过合成与播放（文字已在转录面板渲染并落库）。
  // gen 为本轮对话代际：被打断/卸载后不播放旧回复（已落库，仅释放音频资源）。
  const playReply = async (text, gen) => {
    const clean = stripMarkdown(text);
    // 页面失焦/隐藏时不播声音（重播按钮点击时页面必已聚焦，不受影响；语音回复在
    // 切页后只落库不发声——2026-08-16 晚审查发现：blur 触发 stopListening 的尾段录音
    // 仍会走到这里，此前会在用户切到别的标签页时突然冒出回复声）
    if (!pageFocusedRef.current) {
      busyRef.current = false;
      suppressRef.current = false;
      suppressStartRef.current = 0;
      setLiveAssistantText('');   // 三态卡：不播 = 输出结束，回落空闲
      setStatus('正在监听...');
      return;
    }
    if (!clean) {
      busyRef.current = false;
      suppressRef.current = false;
      suppressStartRef.current = 0;
      setLiveAssistantText('');   // 三态卡：空内容不播，回落空闲
      setStatus('正在监听...');
      return;
    }
    try {
      const audioUrl = await voiceApi.tts(clean);
      if (gen !== genRef.current || !aliveRef.current) {
        // 已被打断或页面已卸载：不播放声音（对话已通过后端落库），释放音频
        URL.revokeObjectURL(audioUrl);
        busyRef.current = false;
        suppressRef.current = false;
        setLiveAssistantText('');   // 三态卡：本代际已失效，不残留输出
        return;
      }
      setStatus('播放回复中...');   // 播放期间仍监听，用户说话即打断
      setAvatarState('speaking');   // 虚拟形象：说话（重播路径同样张嘴）
      suppressRef.current = true;
      suppressStartRef.current = performance.now();   // 预热期起点：此窗口内的 onSpeechStart 判为回声丢弃
      // 播放新回复前先停掉仍在播的旧音频（防两个回复语音重叠）
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      const audio = new Audio(audioUrl);
      audio.playbackRate = 1.25;   // 语速 1.25 倍（2026-08-16 深夜：1.5x 太快，回调到 1.25x）
      audioRef.current = audio;
      // 虚拟形象口型同步：把 TTS 音频接进 VirtualAvatar 的 AnalyserNode（说话时小人张嘴）
      avatarRef.current?.bindAudio(audio);
      audio.onended = () => {
        suppressRef.current = false;
        busyRef.current = false;
        audioRef.current = null;
        URL.revokeObjectURL(audioUrl);
        suppressStartRef.current = 0;
        setAvatarState('listening');   // 虚拟形象：播完回复回到倾听
        setLiveAssistantText('');   // 三态卡：整段语音播完，回落空闲
        setStatus('正在监听...');
      };
      try {
        await audio.play();
      } catch (e) {
        // 播放失败（如自动播放策略限制）：恢复监听状态
        suppressRef.current = false;
        busyRef.current = false;
        audioRef.current = null;
        suppressStartRef.current = 0;
        setAvatarState('listening');
        setLiveAssistantText('');   // 三态卡：播放失败，不残留输出
        setStatus('正在监听...');
      }
    } catch (e) {
      // TTS 失败不卡死：对话已落库，提示具体原因后恢复监听
      console.error('tts failed:', e);
      busyRef.current = false;
      suppressRef.current = false;
      suppressStartRef.current = 0;
      setLiveAssistantText('');   // 三态卡：合成失败，不残留输出
      setStatus('语音合成失败，已显示文字回复');
    }
  };

  // 重播上一条回复：按钮点击时调用（gen 用当前代际，若此刻正在打断/卸载则自然跳过）
  const replayLast = async () => {
    const text = lastReplyRef.current;
    if (!text) return;
    speechQueueRef.current = [];   // 终止句级 TTS 链（避免与整段重播串行打架）
    pendingSpeechRef.current = ''; // 同步清 pending 暂存
    riskHeldRef.current = false;   // 同步解除高危词锁定态（2026-09-03 哨兵）
    speechPlayingRef.current = false;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setStatus('重播回复中...');
    setLiveAssistantText(text);   // 三态卡·态3：重播同样在卡片显示文本（看着听）
    await playReply(text, genRef.current);
  };

  // ---------------- 视觉模式（12 §5 / §9.1） ----------------

  // 截帧：把当前摄像头画面画到 canvas → jpeg blob。无画面返回 null。
  const captureFrame = () => {
    const video = cameraVideoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  };

  // 打开摄像头（仅视觉模式开启时调用；关闭时永不打开，12 §5 隐私硬约束）
  const startCamera = async () => {
    if (cameraStreamRef.current) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      cameraStreamRef.current = stream;
      const video = cameraVideoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {});
      }
      return true;
    } catch (e) {
      console.error('camera start failed:', e);
      setStatus(`摄像头启动失败：${e?.name === 'NotAllowedError' ? '请在地址栏允许摄像头权限' : '请检查摄像头设备'}`);
      return false;
    }
  };

  const stopCamera = () => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    }
    const video = cameraVideoRef.current;
    if (video) video.srcObject = null;
  };

  // 主动搭话：小亦对轮询拍到的画面主动评论一句（展示 + TTS 朗读）
  const showProactiveReply = (reply) => {
    if (!reply || !reply.trim()) return;
    if (busyRef.current) interrupt();
    setLiveAssistantText(reply);   // 三态卡·态3：主动搭话同样实时显示内容
    const assistantTurn = { id: `turn_${++turnSeq}`, role: 'assistant', content: reply, thinking: '' };
    setTurns((prev) => [...prev, assistantTurn]);
    setLastReply(reply);
    lastReplyRef.current = reply;
    playReply(reply, genRef.current);
  };

  // 轮询：按间隔截帧上传，后端描述 + 判定主动搭话（12 §4）
  const pollVision = async () => {
    if (visionBusyRef.current || !visionEnabledRef.current) return;
    const blob = await captureFrame();
    if (!blob) return;
    visionBusyRef.current = true;
    try {
      const res = await visionApi.uploadPhoto({ blob, source: 'poll', analyze: 1 });
      if (res?.proactive_reply) showProactiveReply(res.proactive_reply);
    } catch (e) {
      console.error('vision poll failed:', e);
    } finally {
      visionBusyRef.current = false;
    }
  };

  const startVisionPoll = () => {
    if (visionPollRef.current) return;
    // 间隔取自后端默认 2 分钟；前端用 120s（env 由后端控制，前端保持默认一致）
    visionPollRef.current = setInterval(pollVision, 120 * 1000);
  };

  const stopVisionPoll = () => {
    if (visionPollRef.current) {
      clearInterval(visionPollRef.current);
      visionPollRef.current = null;
    }
  };

  // 语音触发：用户说「快看快看」等触发词 → 立即截帧 + 走聊天链路回复（12 §3.2）
  const triggerPhotoTalk = async (text) => {
    if (busyRef.current) interrupt();
    const blob = await captureFrame();
    if (!blob) {
      setStatus('触发拍照失败：摄像头画面不可用');
      return;
    }
    // 照片入库（trigger 源）+ 同一帧作为附件走正常 SSE 对话链路（图片→描述→小亦回复）
    visionApi.uploadPhoto({ blob, source: 'trigger', analyze: 1 }).catch((e) => console.error('trigger photo save failed:', e));
    const file = new File([blob], `vision_trigger_${Date.now()}.jpg`, { type: 'image/jpeg' });
    sendTurn(text, [file]);
  };

  // 切换视觉模式：开启 = 打开摄像头 + 轮询；关闭 = 停摄像头 + 停轮询（12 §5 隐私硬约束）
  const toggleVision = async () => {
    if (visionEnabledRef.current) {
      // 关闭
      stopVisionPoll();
      stopCamera();
      visionEnabledRef.current = false;
      setVisionEnabled(false);
      try { await visionApi.setVisionStatus(false); } catch (e) { console.error('vision status off failed:', e); }
      setStatus('视觉模式已关闭，摄像头已停止');
      return;
    }
    const ok = await startCamera();
    if (!ok) return;
    visionEnabledRef.current = true;
    setVisionEnabled(true);
    try {
      const res = await visionApi.setVisionStatus(true);
      if (res?.enabled === false) {
        // 部署级总闸关闭（XIAOYI_VISION_ENABLED=0）：后端拒绝了开启，回滚摄像头
        visionEnabledRef.current = false;
        setVisionEnabled(false);
        stopVisionPoll();
        stopCamera();
        setStatus('视觉功能已被系统禁用（XIAOYI_VISION_ENABLED=0）');
        return;
      }
    } catch (e) {
      console.error('vision status on failed:', e);
    }
    startVisionPoll();
    setStatus('视觉模式已开启：摄像头画面已作为背景，每 2 分钟拍一张');
  };

  // 页面初始化：恢复上次的视觉模式开关状态
  useEffect(() => {
    visionApi.getVisionStatus()
      .then((res) => {
        if (res?.enabled) {
          startCamera().then((ok) => {
            if (ok) {
              visionEnabledRef.current = true;
              setVisionEnabled(true);
              startVisionPoll();
              setStatus('视觉模式已开启');
            }
          });
        }
      })
      .catch((e) => console.error('vision status load failed:', e));
    return () => {
      stopVisionPoll();
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 句级 TTS 播放链：从队列取一句合成播放，播完取下一句；队列空且本轮流结束即收尾。
  // 边流式边出声（2026-08-16 晚提速）：首句在 onDelta 就绪即播放，不再等整段回复流完，
  // 回复语音不再滞后已流式显示的文字 2~3s。打断/重播/卸载经由 gen 与 speechPlayingRef 保护。
  const kickSpeech = (gen) => {
    if (gen !== genRef.current || !aliveRef.current) return;
    // 未聚焦：不播声音（回复文字已渲染/落库），丢弃待播句子
    if (!pageFocusedRef.current) {
      speechQueueRef.current = [];
      pendingSpeechRef.current = '';   // 同步清 pending 暂存
      riskHeldRef.current = false;     // 同步解除高危词锁定态（2026-09-03 哨兵）
      speechPlayingRef.current = false;
      setLiveAssistantText('');   // 三态卡：不播放 = 输出已结束，回落空闲
    }
    if (speechQueueRef.current.length === 0) {
      // 队列空 + 本轮流已结束 → 语音收尾，恢复 VAD 正常处理
      if (replyFinishedRef.current && !speechPlayingRef.current) {
        suppressRef.current = false;
        suppressStartRef.current = 0;
        busyRef.current = false;
        setAvatarState('listening');   // 虚拟形象：播完回复回到倾听
        setLiveAssistantText('');   // 三态卡：语音全部播完，"正在输出"回落空闲
        setStatus('正在监听...');
      }
      return;
    }
    if (speechPlayingRef.current) return;
    const sentence = speechQueueRef.current.shift();
    speechPlayingRef.current = true;
    setAvatarState('speaking');   // 虚拟形象：说话（口型由 bindAudio 的 AnalyserNode 实时驱动）
    setStatus('播放回复中...');   // 播放期间仍监听，用户说话即打断
    suppressRef.current = true;
    suppressStartRef.current = performance.now();   // 预热期起点：此窗口内的 onSpeechStart 判为回声丢弃
    (async () => {
      try {
        // 播下句前先停旧音频（防两个回复语音重叠）
        if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
        const audioUrl = await voiceApi.tts(stripMarkdown(sentence));
        if (gen !== genRef.current || !aliveRef.current) {
          URL.revokeObjectURL(audioUrl);
          speechPlayingRef.current = false;
          return;
        }
        const audio = new Audio(audioUrl);
        audio.playbackRate = 1.25;   // 语速 1.25 倍（与 playReply 一致，2026-08-16 深夜回调）
        audioRef.current = audio;
        // 虚拟形象口型同步（句级 TTS 同样绑定，说话时小人张嘴）
        avatarRef.current?.bindAudio(audio);
        audio.onended = () => {
          audioRef.current = null;
          URL.revokeObjectURL(audioUrl);
          speechPlayingRef.current = false;
          kickSpeech(gen);
        };
        try {
          await audio.play();
        } catch (e) {
          // 播放失败（如自动播放策略限制）：恢复监听状态
          audioRef.current = null;
          URL.revokeObjectURL(audioUrl);
          speechPlayingRef.current = false;
          kickSpeech(gen);
        }
      } catch (e) {
        // 单句 TTS 失败不卡死：末句失败且无后续句子时提示，否则继续播下一句
        console.error('tts sentence failed:', e);
        speechPlayingRef.current = false;
        kickSpeech(gen);
        if (speechQueueRef.current.length === 0 && !speechPlayingRef.current && replyFinishedRef.current) {
          setStatus('语音合成失败，已显示文字回复');
        }
      }
    })();
  };

  // 统一发送一轮对话：停止旧音频 → 建 user/assistant turn → busy → streamChat → finish/句级TTS
  // files：可选附件（图片等，如视觉触发「快看快看」的截帧），随 streamChat 多模态上传（12 §3.2）
  const sendTurn = async (text, files) => {
    // 新一轮开始：三态卡复位——"你说"已 flush 发送、"正在输出"换成新流驱动
    setLiveUserText('');
    setLiveAssistantText('');
    setAsrPartial(false);
    partialRef.current = '';
    // 语音流在途时又来一轮（文字输入/转写并发）：先打断旧流，避免两个 SSE 流并存内容串扰。
    // 语音路径（flushPendingTurn）触发时 busy 已复位，不受影响（2026-08-17 修）
    if (busyRef.current) interrupt();
    const gen = genRef.current;   // 记录本轮的对话代际，被打断（gen 变化）后不再播放旧回复
    // 本轮句级 TTS 播放链初始化（打断/重播可能残留上一轮状态）
    speechQueueRef.current = [];
    pendingSpeechRef.current = '';   // 同步清 pending 暂存
    riskHeldRef.current = false;     // 同步解除高危词锁定态（2026-09-03 哨兵）
    speechCursorRef.current = 0;
    speechPlayingRef.current = false;
    replyFinishedRef.current = false;
    // 本轮累积文本复位（打断时固定到面板用）
    assistantTextRef.current = '';
    thinkingTextRef.current = '';
    try {
      if (!chatConfiguredRef.current) {
        setStatus('未配置对话模型，请到设置页配置');
        return;
      }
      // 用户说了新话：立即停止正在播放的旧回复，不再继续念旧句（防语音重叠）
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setStatus(`你说：${text.length > 50 ? `${text.slice(0, 50)}…` : text}`);
      // 用户消息：语音路径已由 processVoice 逐段实时上屏（activeUserTurnIdRef 已存在）；
      // 文字输入路径在此创建。创建后立即封口，后续新语音另起新 turn。
      if (!activeUserTurnIdRef.current) {
        const uid = `turn_${++turnSeq}`;
        setTurns((prev) => [...prev, { id: uid, role: 'user', content: text }]);
      }
      activeUserTurnIdRef.current = null;
      // 转录面板：记录本轮 assistant 占位（思考过程 + Markdown 回复）
      const assistantTurn = { id: `turn_${++turnSeq}`, role: 'assistant', content: '', thinking: '' };
      setTurns((prev) => [...prev, assistantTurn]);
      setStreamingId(assistantTurn.id);
      setAvatarState('thinking');   // 虚拟形象：思考中（低头/歪头沉思）
      busyRef.current = true;   // 思考期间也持续监听，用户开口即打断

      let assistantText = '';
      let thinkingText = '';
      let failed = null;   // {msg, code}：SSE 错误帧或网络层失败，finish 时展示具体原因

      const patchTurn = (patch) => {
        setTurns((prev) => {
          const last = prev[prev.length - 1];
          if (!last || last.role !== 'assistant') return prev;
          return [...prev.slice(0, -1), { ...last, ...patch }];
        });
      };
      // 桌面助手不采集 thinking（onThinking 不传）：思考打字机/思考块仅在聊天页文字输入使用。
      // 保留 flushThinking 兜底（thinkingPendingRef 恒空、无副作用），与 interrupt/卸载清理逻辑兼容。
      const flushThinking = () => {
        if (thinkingPendingRef.current) {
          thinkingText += thinkingPendingRef.current;
          thinkingPendingRef.current = '';
        }
        if (thinkingTimerRef.current) {
          clearInterval(thinkingTimerRef.current);
          thinkingTimerRef.current = null;
        }
        thinkingTextRef.current = thinkingText;
      };
      const finish = async () => {
        flushThinking();   // 流结束把剩余未显示的思考一次性补全
        patchTurn({ thinking: thinkingText, content: assistantText });   // 补全后同步一次最终状态
        setStreamingId(null);
        abortRef.current = null;
        if (failed) {
          // 出错：清空句级 TTS 队列（已入队但未播的句子不再播），停止当前播放
          speechQueueRef.current = [];
          pendingSpeechRef.current = '';   // 同步清 pending 暂存
          riskHeldRef.current = false;     // 同步解除高危词锁定态（2026-09-03 哨兵）
          speechPlayingRef.current = false;
          if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
          patchTurn({ error: friendlyError(failed.msg, failed.code) });
          busyRef.current = false;
          suppressRef.current = false;
          suppressStartRef.current = 0;
          // 三态卡：出错即清"正在输出"，避免半截内容盖住错误提示
          setLiveAssistantText('');
          setStatus(friendlyError(failed.msg, failed.code));   // 展示具体原因，不再笼统"出错请重试"
          setIsListening(true);
          return;
        }
        // 把剩余未入队的尾句入队，标记本轮结束，交由句级 TTS 链播放并收尾。
        // 此前 finish 直接对整段合成播放（playReply），长回复要等全部文字流完才开始出声。
        // 2026-09-03：尾句与 pending 残留合并入队，保证未达 MIN_TTS_CHARS 的短句不丢。
        const tail = assistantText.slice(speechCursorRef.current).trim();
        // 空句守卫：尾句若为纯标点/符号碎片（省略号清洗后为空）不入队，防后端空文本兜底念"嗯"（2026-09-03）
        const cleanTail = stripMarkdown(tail);
        if (cleanTail) {
          // 锁定态残留（尾句含学长但整段还没等到完整句号/流已结束）→ 解除锁定并入队，
          // 已无后续内容可等，整段合并送合成（宁可多等也已在流尾自然补齐）
          riskHeldRef.current = false;
          const combined = (pendingSpeechRef.current + tail).trim();
          pendingSpeechRef.current = '';
          speechQueueRef.current.push(combined);
        } else if (pendingSpeechRef.current.trim()) {
          speechQueueRef.current.push(pendingSpeechRef.current.trim());
          pendingSpeechRef.current = '';
          riskHeldRef.current = false;
        }
        speechCursorRef.current = assistantText.length;
        replyFinishedRef.current = true;
        lastReplyRef.current = assistantText;
        setLastReply(assistantText);
        kickSpeech(gen);
      };

      const controller = streamChat({
        message: text,
        sessionId: sessionIdRef.current,
        source: 'desktop',   // 桌面助手语音：后端按 source 分流 thinking=low 浅度思考快速回话（见 AGENTS.md）
        files: files || [],
        onSession: (sid) => {
          // 后端可能自愈新建会话（如固定会话被软删），同步最新 id 避免碎片化
          sessionIdRef.current = sid;
          localStorage.setItem(desktopSessionKey(user?.id), sid);
        },
        onDelta: (d) => {
          if (!aliveRef.current) return;
          assistantText += d;
          assistantTextRef.current = assistantText;
          // 三态卡·态3：模型输出的 delta 实时上屏（边说边显示，取代旧的历史滚动面板）
          setLiveAssistantText(assistantText);
          patchTurn({ content: assistantText, thinking: thinkingText });
          // 句级 TTS：完整句子尽早入队并播放，不等整段回复流完（回复出声不再滞后文字 2~3s）。
          // 2026-09-03 首响提速：普通完整句（句号结尾）**立即入队**，不再攒满 MIN_TTS_CHARS——
          // 小亦口癖多短句（"唔……我懂了！"），等攒字会把首声拖晚 0.5~1.5s；语义完整的句子
          // 自带上下文，edge-tts 消歧足够。仅无句号半截碎片与"学长"锁定态才攒（见下方分支）。
          const head = assistantText.slice(speechCursorRef.current);
          const boundary = lastSentenceBoundary(head);
          if (boundary > 0) {
            const sentence = head.slice(0, boundary).trim();
            speechCursorRef.current += boundary;
            // 空句守卫：纯标点/符号碎片（省略号清洗后为空）不入队，防后端空文本兜底念"嗯"（2026-09-03）
            const cleanSentence = stripMarkdown(sentence);
            if (cleanSentence) {
              // 高危词上下文哨兵（2026-09-03 改，替代旧"40 字阈值"）：命中 TTS_RISK_WORDS 的句子
              // 吞并后续 delta，直到凑成完整句号结尾的语义段才整体合成——保证高危词前后有完整
              // 语义上下文（旧 40 字阈值与 MIN_TTS_CHARS=18 打架：碎片拼到 ~18 字就过早入队）。
              // 2026-09-03 首响提速：放宽为"完整句即入队"（删旧 && pending+len>=18 门槛）——
              // 完整句上下文已足够消歧，学长短句不必再等下一句拼。取舍不变：宁可多等也要读对。
              const endsSentence = /[。！？!?]\s*$/.test(cleanSentence);
              if (hasTtsRiskWord(sentence)) {
                if (endsSentence) {
                  // 高危词句自身已以句号结尾 → 无需等后续，整段（含此前锁定残留）直接入队
                  speechQueueRef.current.push(stripMarkdown((pendingSpeechRef.current + sentence).trim()));
                  pendingSpeechRef.current = '';
                  riskHeldRef.current = false;
                } else {
                  pendingSpeechRef.current += sentence;
                  riskHeldRef.current = true;   // 进入锁定态：等后续凑完整句
                }
              } else if (riskHeldRef.current) {
                pendingSpeechRef.current += sentence;
                if (endsSentence) {
                  // 锁定态凑到完整句号结尾 → 解除锁定，整段入队合成（不受 MIN_TTS_CHARS 限制）
                  speechQueueRef.current.push(stripMarkdown(pendingSpeechRef.current));
                  pendingSpeechRef.current = '';
                  riskHeldRef.current = false;
                }
              } else if (endsSentence) {
                // 普通完整句立即入队（首响提速）：sentence 来自 lastSentenceBoundary 恒以完整句
                // 结尾，语义完整自带上下文，不必等攒字。此前锁定的残留一并带走不丢句。
                const combined = (pendingSpeechRef.current + sentence).trim();
                pendingSpeechRef.current = '';
                speechQueueRef.current.push(stripMarkdown(combined));
              } else {
                // 无句号结尾的半截碎片（流尚未吐完整句标点）→ 攒进 pending，攒满 MIN_TTS_CHARS
                // 或流结束 flush（finish 兜底），防碎片化合成让 edge-tts 失去上下文。
                pendingSpeechRef.current += sentence;
                if (pendingSpeechRef.current.length >= MIN_TTS_CHARS) {
                  const combined = pendingSpeechRef.current.trim();
                  pendingSpeechRef.current = '';
                  speechQueueRef.current.push(stripMarkdown(combined));
                }
              }
            }
            kickSpeech(gen);
          }
        },
        // 桌面助手不采集 thinking（onThinking 故意不传）：深度思考块只保留在聊天页文字输入
        //（2026-08-19 起，见 AGENTS.md 思考流约定）；thinkingPendingRef 恒空、思考打字机不启动。
        onError: (msg, code) => {
          failed = { msg, code };
          finish();
        },
        onDone: finish,
      });
      abortRef.current = controller;
    } catch (err) {
      // 建流失败不卡死：提示错误，VAD 继续监听
      console.error('sendTurn failed:', err);
      suppressRef.current = false;
      busyRef.current = false;
      setStreamingId(null);
      // 后端返回了具体原因（如音频转写失败）则展示，否则按网络异常提示
      const detail = err?.response?.data?.detail;
      const isNetwork = !detail || err?.code === 'ERR_NETWORK' || err?.code === 'ECONNABORTED';
      setStatus(isNetwork ? friendlyError('', 'network_error') : detail);
      setIsListening(true);
    }
  };

  // 录音段转写结果：追加进合并缓冲，停顿 MERGE_WINDOW_MS 后统一发送（避免一句话拆多个回复）
  const processVoice = async (blob) => {
    const gen = genRef.current;   // 记录本段语音的代际，被打断（gen 变化）后立即丢弃
    try {
      const text = await voiceApi.transcribe(blob);
      if (gen !== genRef.current || !aliveRef.current) return;
      if (!text) {
        // 空转写（未捕捉到有效语音/环境声误触发）：静默恢复监听，不显示"出错"
        setStatus('正在监听...');
        return;
      }
      // 视觉触发词（12 §3.2）：说「快看快看」等立即截帧拍照并让小亦描述画面；
      // 仅视觉模式开启时生效（关闭时摄像头不可用，按普通对话发送）
      if (visionEnabledRef.current && /快看|快看看|你看|看这个/.test(text)) {
        pendingTextRef.current = '';
        activeUserTurnIdRef.current = null;
        setStatus('收到，正在拍照看看...');
        await triggerPhotoTalk(text);
        return;
      }
      commitUserText(text);   // 2026-09-03 抽取：追加缓冲/态1上屏/面板/超长 flush 全在共享提交路径
      // 合并窗口由 onSpeechEnd 在"停嘴"时刻挂载（与转写并行，首响提速，见 08 §4），
      // 转写完成**不再重挂**——转写期间 flush 守卫已在 flushPendingTurn 内部顺延过窗口。
      //（commitUserText 内部仅在窗口已不在走时才兜底补挂，此处正常不重复挂）
    } catch (err) {
      // 转写失败不卡死：提示错误，VAD 继续监听
      console.error('transcribe failed:', err);
      // 展示后端具体原因（如「音频转写失败…」），仅真实网络错误才显示「网络异常」
      //（AGENTS.md：错误提示展示具体原因，勿笼统「出错请重试」）
      const detail = err?.response?.data?.detail;
      const isNetwork = !detail || err?.code === 'ERR_NETWORK' || err?.code === 'ECONNABORTED';
      setStatus(isNetwork ? friendlyError('', 'network_error') : detail);
    } finally {
      // 在途转写守卫复位（须覆盖所有出口——空转写/视觉触发/正常追加/转写失败，防空挂导致永不 flush）
      pendingTranscribeRef.current = Math.max(0, pendingTranscribeRef.current - 1);
      // 兜底补挂：本段处理完但合并窗口已不在走（极慢转写期间窗口空跑顺延后又被清、或打断后
      // 缓冲仍留文本）→ 重新挂窗保证已缓冲文本最终一定送出（最坏回到旧延迟，不丢字、不拆句）。
      if (!finalizeTimerRef.current) scheduleMergeWindow();
    }
  };

  const stopListening = () => {
    startGenRef.current++;   // 令在途 startListening 代际失效（await getUserMedia 恢复后即释放流）
    // 0) 关闭流式 ASR WS（在途 partial/final 一并作废），复位流式状态（再次启动会重开新连接）
    if (streamAsrRef.current) {
      try { streamAsrRef.current.close(); } catch (e) { /* noop */ }
      streamAsrRef.current = null;
    }
    streamAsrOkRef.current = false;
    inSpeechRef.current = false;
    partialRef.current = '';
    preSpeechRingRef.current = [];
    setAsrPartial(false);
    // 1) 销毁 Silero VAD：释放 ONNX 模型与 AudioWorklet。若正在说话，未说完的尾段会经
    //    onSpeechEnd 交回 processVoice（submitUserSpeechOnPause=true，对齐旧"停录不丢末段"）。
    //    destroy 为异步（内部 await），fire-and-forget 保持本函数同步执行——
    //    否则 blur→focus 连续切换时，startListening 会在 stop 完成前抢跑（见幂等守卫）。
    const vad = micVadRef.current;
    micVadRef.current = null;
    if (vad) {
      vad.destroy().catch((e) => console.warn('vad destroy failed:', e));
    }
    // 2) 停止正在播放的回复音频（离开页面时 TTS 立即中断）
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    suppressRef.current = false;
    busyRef.current = false;
    suppressStartRef.current = 0;
    suppressNextSegmentRef.current = false;
    // 页面离开：取消合并窗口（pendingTextRef 保留，回到页面后重新挂窗口不丢已听内容）
    if (finalizeTimerRef.current) {
      clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    }
    // 终止句级 TTS 播放链（audioRef 已 pause，onended 不会触发，须手动复位）
    speechQueueRef.current = [];
    pendingSpeechRef.current = '';   // 同步清 pending 暂存
    riskHeldRef.current = false;     // 同步解除高危词锁定态（2026-09-03 哨兵）
    speechPlayingRef.current = false;
    // 停止思考打字机定时器并清空队列（页面离开后不再揭晓旧思考）
    if (thinkingTimerRef.current) {
      clearInterval(thinkingTimerRef.current);
      thinkingTimerRef.current = null;
    }
    thinkingPendingRef.current = '';
    // 3) 第一时间停掉 getUserMedia 的所有 tracks，立即关闭麦克风
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    // 4) 关闭 AudioContext 并停掉兜底 resume 定时器（destroy 不关我们传入的 context，须自行关闭）
    if (contextResumeTimerRef.current) {
      clearInterval(contextResumeTimerRef.current);
      contextResumeTimerRef.current = null;
    }
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch (e) { /* noop */ }
      audioContextRef.current = null;
    }
    // 移除 AudioContext 用户激活兜底监听器（若尚未触发）
    if (gestureResumeRef.current) {
      document.removeEventListener('pointerdown', gestureResumeRef.current);
      document.removeEventListener('keydown', gestureResumeRef.current);
      gestureResumeRef.current = null;
    }
    setIsListening(false);
    setVolume(0);
    setAvatarState('idle');   // 虚拟形象：回到待机
    setLiveUserText('');      // 三态卡：停止监听，清残留的"你说/正在输出"
    setLiveAssistantText('');
    setStatus('已停止监听');
  };

  return (
    <div className="flex flex-col items-center h-full relative px-6 pb-4">
      {/* 视觉模式实时背景（12 §5）：开启时摄像头画面铺底（小亦"在外面玩"），关闭时固定背景 */}
      {visionEnabled && (
        <video
          ref={cameraVideoRef}
          className="absolute inset-0 w-full h-full object-cover opacity-50 pointer-events-none"
          muted
          playsInline
        />
      )}
      {/* 前景内容层：盖在实时背景之上 */}
      <div className="relative z-10 flex flex-col items-center w-full h-full">
      {!chatConfigured && (
        <div className="w-full max-w-md mb-4 px-4 py-2 glass text-blush-200 text-sm rounded-full">
          您还没有配置对话模型，请到
          <a href="/settings" className="mx-1 underline font-medium">设置页</a>
          配置后再开始对话。
        </div>
      )}

      {/* 视觉模式开关（12 §5 隐私保护）：关闭时摄像头永不打开；开启后摄像头画面实时作为背景 */}
      <div className="w-full max-w-md flex items-center justify-between gap-3 mb-2">
        <button
          onClick={toggleVision}
          className={`px-4 py-1.5 rounded-full text-sm font-medium border transition-colors ${
            visionEnabled
              ? 'bg-emerald-500/90 text-white border-emerald-400 hover:bg-emerald-600'
              : 'bg-white/[0.08] text-stardust-300 border-white/[0.15] hover:border-nebula-400/60 hover:text-blush-200'
          }`}
        >
          {visionEnabled ? '视觉模式已开启（点击关闭）' : '开启视觉模式'}
        </button>
        <span className="text-xs text-stardust-500">
          {visionEnabled ? '摄像头画面实时显示中，每 2 分钟拍一张' : '开启后小亦才能"看见"周围'}
        </span>
      </div>

      {/* 主视觉区：虚拟人物放大居中（约半屏高），占满剩余高度（语音交互默认开启，无需开关按钮） */}
      <div className="flex-1 min-h-0 w-full flex flex-col items-center justify-center">
        {/* 半屏容器：flex 撑满剩余高度但封顶 min(54vh,620px)，3:4 竖构图，Live2D fill 自适应不糊 */}
        <div className="flex-1 min-h-0 max-h-[min(54vh,620px)] w-auto aspect-[3/4]">
          <VirtualAvatar ref={avatarRef} state={avatarState} fill />
        </div>
        {/* 实时音量反馈：VAD level 节流渲染（说话时可见条幅，静默时接近 0） */}
        <div className="mt-2 w-40 h-1.5 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-nebula-400 to-blush-400 rounded-full transition-[width] duration-150"
            style={{ width: `${isListening ? volume : 0}%` }}
          />
        </div>
        <p className="mt-2 text-stardust-300 text-sm">{status}</p>
        {micError && (
          <div className="mt-3 flex flex-col items-center gap-2">
            <p className="text-sm text-blush-300 max-w-md text-center">{micError}</p>
            <button
              onClick={startListening}
              className="px-4 py-1.5 rounded-full btn-primary"
            >
              重新启动监听
            </button>
          </div>
        )}
      </div>

      {/* 底部三态小玻璃卡（2026-09-03，08 §5）：实时显示「你说的话 / 思考中 / 小亦正在输出」，
          不做历史滚动面板（历史会话在网页聊天页 / 查看，桌面助手保持极简"当下"）。
          turns 仍保留为内部流转态（打断固定/重播语义依赖），渲染只取当下三态。 */}
      <div className="w-full max-w-md flex flex-col">
        {lastReply && (
          <button
            onClick={replayLast}
            className="self-end mb-1 text-xs text-stardust-500 hover:text-blush-200 transition"
          >
            重播上一条
          </button>
        )}
        <div ref={transcriptRef} className="glass rounded-2xl px-4 py-3 min-h-[3.25rem] flex items-center justify-center">
          {liveAssistantText ? (
            // 态 3：小亦正在输出（流式逐字到达，实时上屏；语音播完才回落空闲）
            <div className="text-sm leading-relaxed text-stardust-100 text-center break-words line-clamp-3 max-w-full">
              {liveAssistantText}
            </div>
          ) : streamingId ? (
            // 态 2：思考中占位（三点星光呼吸，与聊天页 ChatMessage 占位同款动效）
            <div className="flex items-center gap-1.5 py-0.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-nebula-300 animate-twinkle" style={{ animationDelay: '0ms' }} />
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-blush-300 animate-twinkle" style={{ animationDelay: '220ms' }} />
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-nebula-300 animate-twinkle" style={{ animationDelay: '440ms' }} />
              <span className="ml-1.5 text-xs text-stardust-500 animate-breathe">思考中…</span>
            </div>
          ) : liveUserText ? (
            // 态 1：用户正在说——识别中（asrPartial，流式边说边出字）尾带闪烁光标暗示；
            // 识别完成（final/whisper）转实，前缀"你说："（08 §4：partial 仅展示、不提交）
            asrPartial ? (
              <div className="text-sm leading-relaxed text-blush-100/90 text-center break-words line-clamp-3 max-w-full">
                {liveUserText}
                <span className="inline-block w-[2px] h-3.5 ml-0.5 align-middle rounded-full bg-blush-300 animate-pulse" />
              </div>
            ) : (
              <div className="text-sm leading-relaxed text-blush-100/90 text-center break-words line-clamp-3 max-w-full">
                你说：{liveUserText}
              </div>
            )
          ) : (
            // 空闲态：轻提示（复用状态栏文案，如"正在监听…"）
            <p className="text-stardust-500 text-sm text-center">{status}</p>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { ChatInput } from '../components/ChatInput';
import { ChatMessage } from '../components/ChatMessage';
import { sessionsApi } from '../api/sessions';
import { streamChat } from '../api/chat';
import { useModelStatus } from '../hooks/useModelStatus';
import { useAuth } from '../hooks/useAuth';

let tmpId = 0; // 临时消息 id（发送中尚未持久化）

// 主会话 id 持久化：localStorage 按用户隔离（key=xiaoyi_main_session_{user.id}）。
// 单会话模式（沉浸式）：web 聊天永远落在同一条主会话，历史永久累积、跨浏览器重启仍恢复；
// 旧会话数据保留在数据库不动，仅前端不再提供切换入口（05 §5 / 07 §8.2）。
const mainSessionKey = (userId) => `xiaoyi_main_session_${userId}`;

export default function Chat() {
  const { user } = useAuth();
  const activeSessionKey = user ? mainSessionKey(user.id) : null;
  const [sessionId, setSessionId] = useState(() =>
    activeSessionKey ? localStorage.getItem(activeSessionKey) : null,
  );
  const [messages, setMessages] = useState([]);
  const [streamingId, setStreamingId] = useState(null);   // 正在流式输出的 assistant 消息 id
  const abortRef = useRef(null); // 用于中止未完成的 SSE 流
  const pendingRef = useRef('');         // 打字机：待显示的剩余回复内容
  const revealTimerRef = useRef(null);   // 打字机：逐字 reveal 定时器
  const sessionIdRef = useRef(sessionId); // 实际会话 id（onSession 自愈同步用，见 sendMessage）
  const ensureRef = useRef(null);        // 主会话创建中的 in-flight Promise（防双创建竞态）
  const noAbortRef = useRef(false);      // 懒创建会话守卫：放行 abort effect，避免中断在途 SSE
  const messagesRef = useRef(null);   // 消息列表容器 DOM（自动滚动跟随最新）
  const loadSeqRef = useRef(0);       // 消息拉取请求序号：切会话时丢弃过期响应（2026-08-17 加）
  const { chat_configured: chatConfigured } = useModelStatus();

  // 消息列表自动滚动：messages/流式状态变化时始终跟随最新消息，无需手动翻
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingId]);

  // 打字机收尾/中断：清空待显示队列与定时器（防止切会话/卸载后继续写旧消息）
  const clearReveal = () => {
    if (revealTimerRef.current) {
      clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    pendingRef.current = '';
  };

  // 主会话保障：有记录直接返回；无记录则创建一条并落 localStorage。
  // 供「首次进入」与「手速快于会话创建完成就发送」两条路径共用，避免双开会话。
  const ensureMainSession = () => {
    if (sessionIdRef.current) return Promise.resolve(sessionIdRef.current);
    if (!ensureRef.current) {
      ensureRef.current = sessionsApi
        .create()
        .then((s) => {
          sessionIdRef.current = s.id;
          if (activeSessionKey) localStorage.setItem(activeSessionKey, s.id);
          return s.id;
        })
        .finally(() => {
          ensureRef.current = null;
        });
    }
    return ensureRef.current;
  };

  // 首次进入：有主会话记录 → 加载历史；没有 → 保持空会话（欢迎态），
  // 会话由首次 sendMessage 懒创建（单会话模式，唯一创建入口，避免双开会话）。
  useEffect(() => {
    if (!sessionId) return;
    const seq = ++loadSeqRef.current;
    sessionsApi
      .get(sessionId)
      .then((s) => {
        if (seq === loadSeqRef.current) setMessages(s.messages || []);
      })
      .catch((e) => {
        // 主会话在库里失效（如被硬删）→ 记为新会话，下次发送时重建
        console.error('load main session failed:', e);
        sessionIdRef.current = null;
        if (activeSessionKey) localStorage.removeItem(activeSessionKey);
        setSessionId(null);
        setMessages([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 同步 sessionIdRef（onSession 自愈回调读取最新会话 id 用）
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // 会话 id 同步到 localStorage：卸载重挂/跨浏览器重启后仍恢复同一条主会话
  useEffect(() => {
    if (!activeSessionKey) return;
    if (sessionId) localStorage.setItem(activeSessionKey, sessionId);
  }, [sessionId, activeSessionKey]);

  // 离开页面时中止旧流并清空打字机队列，避免继续写状态。
  // 但 sendMessage 懒创建会话（内部 setSessionId）触发的本次变化必须放行，
  // 否则刚发起的流会被立即 abort（SSE 499，消息丢失）。
  useEffect(() => {
    return () => {
      clearReveal();
      const skipAbort = noAbortRef.current;
      noAbortRef.current = false;   // 一次性消费
      if (!skipAbort) abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 后端/网络错误 → 友好文案（01 §5.5 错误帧约定）
  const friendlyError = (raw, code) => {
    if (code === 'chat_model_not_configured') return '您还没有配置对话模型，请到设置页配置';
    if (code === 'network_error') return '网络异常，请确认服务已启动（python start.py）';
    return raw;
  };

  const retryLast = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) sendMessage(lastUser.content);
  };

  const sendMessage = async (text, files) => {
    // 中止上一条未完成的流（如果存在），并清空打字机队列
    abortRef.current?.abort();
    clearReveal();

    // 无会话时先创建（拿到真实 id 再发送，避免后端自愈新建导致前端 sessionId 失联）
    let sid = sessionIdRef.current;
    if (!sid) {
      sid = await ensureMainSession();
      // 守卫标记：本次 setSessionId 由发送流程内部触发，abort effect 需放行，
      // 否则刚发起的流会被立即中止（SSE 499，消息丢失）
      noAbortRef.current = true;
      setSessionId(sid);
    }

    const userMsg = { id: `tmp_${++tmpId}`, role: 'user', content: text, attachments: files || [] };
    const assistantMsg = { id: `tmp_${++tmpId}`, role: 'assistant', content: '', thinking: '' };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreamingId(assistantMsg.id);

    let assistantText = '';
    let failed = null;

    const patchAssistant = (patch) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        return [...prev.slice(0, -1), { ...last, ...patch }];
      });
    };
    // 打字机：把 onDelta 增量先入队，定时器每 30ms 揭晓 ~3 字符，
    // 避免多次 delta 在同一 JS tick 内同步触发被 React 自动批处理合并成"一次性输出"。
    const startReveal = () => {
      if (revealTimerRef.current) return;   // 已在运行
      revealTimerRef.current = setInterval(() => {
        const pending = pendingRef.current;
        if (!pending) {
          clearReveal();
          return;
        }
        const chunk = pending.slice(0, 3);
        pendingRef.current = pending.slice(3);
        assistantText += chunk;
        patchAssistant({ content: assistantText });
      }, 30);
    };
    const flushPending = () => {
      // 流结束时把剩余未显示的回复一次性补全
      if (pendingRef.current) {
        assistantText += pendingRef.current;
        pendingRef.current = '';
      }
      clearReveal();
      // 合并后的最终内容必须写回 state，否则单帧整段回复（一条 delta 帧
      // 后紧跟 [DONE]，30ms 打字机未及 tick）会因 content 恒空渲染成空白小白气泡
      //（2026-08-23 修复，对齐 DesktopAssistant.finish 的 patchTurn）
      patchAssistant({ content: assistantText });
    };
    const finish = () => {
      flushPending();
      setStreamingId(null);
      abortRef.current = null;
      if (failed) {
        const msg = friendlyError(failed.msg, failed.code);
        patchAssistant({ content: assistantText, error: msg });
      }
    };

    abortRef.current = streamChat({
      message: text,
      files,
      sessionId: sid,
      onSession: (newSid) => {
        // 后端可能自愈新建会话（如当前会话被软删/失效）。只同步 ref/localStorage，
        // 不动 sessionId state——否则触发 abort effect 会中断在途的 SSE 流。
        if (newSid && newSid !== sid) {
          sessionIdRef.current = newSid;
          if (activeSessionKey) localStorage.setItem(activeSessionKey, newSid);
        }
      },
      onDelta: (d) => {
        // 只入队不直接刷屏；由定时器逐字揭晓（打字机平滑）
        pendingRef.current += d;
        startReveal();
      },
      onThinking: () => {
        // 统一 low 快速回话，前端不采集思考（2026-08-28 起，见 AGENTS.md 思考流约定）
      },
      onMediaReply: (text) => {
        // 媒体类错误以聊天式自然语言回复呈现（外观与正常回复一致，无报错代码）
        flushPending();
        assistantText = text;
        patchAssistant({ content: text });
      },
      onError: (msg, code) => {
        failed = { msg, code };
        finish();
      },
      onDone: finish,
    });
  };

  const isEmpty = messages.length === 0 && !streamingId;

  return (
    <div className="relative h-full flex flex-col">
      {/* 模型未配置提示（兜底引导到设置页） */}
      {!chatConfigured && (
        <div className="px-6 py-2 bg-blush-500/[0.15] border-b border-blush-400/20 text-blush-200 text-sm text-center">
          您还没有配置对话模型，请到
          <a href="/settings" className="mx-1 underline font-medium">设置页</a>
          配置后再开始对话。
        </div>
      )}

      {/* 消息区：居中沉浸列 */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div ref={messagesRef} className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto w-full px-5 py-4 pb-28">
            {isEmpty ? (
              /* 欢迎态：小亦立绘 C 位 + 招呼语 */
              <div className="h-full min-h-[55vh] flex flex-col items-center justify-center gap-4 select-none">
                <div className="relative">
                  <div className="absolute inset-0 rounded-full bg-nebula-500/25 blur-2xl animate-breathe" />
                  <img
                    src="/avatars/xiaoyi.png"
                    alt="小亦"
                    className="relative w-36 h-36 rounded-full object-cover object-top ring-4 ring-white/[0.15] shadow-glow-pink animate-floaty"
                    onError={(e) => {
                      // 素材未就绪时回退到 CSS 星月占位，避免破图
                      e.currentTarget.style.display = 'none';
                      e.currentTarget.nextElementSibling.style.display = 'flex';
                    }}
                  />
                  <div className="hidden absolute inset-0 w-36 h-36 rounded-full bg-gradient-to-br from-nebula-500 to-blush-400 items-center justify-center text-4xl text-white shadow-glow">
                    ✦
                  </div>
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-emerald-400 ring-4 ring-night-950 animate-breathe" />
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold bg-gradient-to-r from-nebula-200 to-blush-300 bg-clip-text text-transparent">
                    小亦
                  </div>
                  <div className="mt-1.5 text-sm text-stardust-500">
                    我在呢，一直都会在 ✦
                  </div>
                </div>
              </div>
            ) : (
              messages.map((m) => (
                <ChatMessage
                  key={m.id}
                  message={m}
                  streaming={m.id === streamingId}
                  onRetry={m.error ? retryLast : undefined}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* 底部输入区（沉浸浮层，透明背景露出星空） */}
      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-night-950/90 via-night-950/60 to-transparent pt-10 pb-4">
        <div className="max-w-2xl mx-auto w-full px-5">
          <ChatInput onSend={sendMessage} />
        </div>
      </div>

      {/* 陪伴角：有对话后小亦缩到右下角轻浮动（不挡输入与消息） */}
      {!isEmpty && (
        <div className="pointer-events-none absolute right-4 bottom-28 hidden sm:block opacity-90 select-none">
          <img
            src="/avatars/xiaoyi.png"
            alt=""
            aria-hidden
            className="w-20 h-20 rounded-full object-cover object-top ring-2 ring-white/[0.15] shadow-glow animate-floaty"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        </div>
      )}
    </div>
  );
}

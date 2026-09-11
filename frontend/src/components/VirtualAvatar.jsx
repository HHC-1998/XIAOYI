import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Application, extensions } from 'pixi.js';
import {
  Live2DModel,
  Live2DPlugin,
  MotionPriority,
  CubismFramework,
  configureCubismSDK,
} from 'untitled-pixi-live2d-engine/cubism';

// 模型入口（frontend/public/live2d/Hiyori/，由 Vite 静态服务提供）。
// 想换形象：把新模型的 runtime 文件夹放到 public/live2d/ 下，改这一行即可。
const MODEL_PATH = '/live2d/Hiyori/Hiyori.model3.json';

// 模型参数 ID（Hiyori 的 cdi3.json）：口型/眼睛/头/身体等
const PARAM_MOUTH_OPEN = 'ParamMouthOpenY';
const PARAM_EYE_BALL_X = 'ParamEyeBallX';
const PARAM_EYE_BALL_Y = 'ParamEyeBallY';
const PARAM_EYE_L_OPEN = 'ParamEyeLOpen';
const PARAM_EYE_R_OPEN = 'ParamEyeROpen';
const PARAM_ANGLE_X = 'ParamAngleX';
const PARAM_ANGLE_Y = 'ParamAngleY';
const PARAM_ANGLE_Z = 'ParamAngleZ';
const PARAM_BODY_ANGLE_X = 'ParamBodyAngleX';
const PARAM_BREATH = 'ParamBreath';
const PARAM_MOUTH_FORM = 'ParamMouthForm';
const PARAM_EYE_L_SMILE = 'ParamEyeLSmile';
const PARAM_EYE_R_SMILE = 'ParamEyeRSmile';

// Idle 动作组在 Hiyori.model3.json 里的实际顺序（索引即 model.motion('Idle', idx) 的序号）。
// Hiyori 只有两类动作：Idle 组 9 个待机动作 + TapBody 组 1 个点击反应（m04），无"专属听/说"动画。
const IDLE_LIST = ['m01', 'm02', 'm03', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10'];
const IDX = (name) => IDLE_LIST.indexOf(name);
const THINKING_MOTION = IDX('m05');              // 沉思/托腮（时长最长的待机动作）
const GENTLE_IDLE = [IDX('m01'), IDX('m07')];    // 安稳待机候选（m01 呼吸转身 / m07 最小幅）
const randomGentleIdle = () => GENTLE_IDLE[Math.floor(Math.random() * GENTLE_IDLE.length)];

// 代码全权驱动（listening / speaking）时的姿态目标——幅度放大到肉眼可辨。
// 注意：这两个状态会停播模型动作（无循环动画干扰），头/身/眼全部由本表 + 波形控制。
const STATE_POSE = {
  // 2026-09-03 二次调参：listening 是桌面助手长驻态，幅度再放大到"明显在听"。
  // 注意：倾侧由 angleZ（面内歪头）+ angleX/bodyAngleX（前后左右倾）联合构成；
  // 单独 angleZ=-16 只歪头不侧身，观感不如 bodyAngleX 侧倾明显，故同步加强 bodyAngleX。
  listening: { angleX: 3,   angleY: 0,   angleZ: -16, bodyAngleX: 12, eyeL: 1, eyeR: 1, eyeBallX: 0,  eyeBallY: 0.5,  mouthForm: 0.4 },
  speaking:  { angleX: 0,   angleY: 0,   angleZ: -3,  bodyAngleX: 3,  eyeL: 1, eyeR: 1, eyeBallX: 0,  eyeBallY: 0.2,  mouthForm: 0.5 },
};

// 尺寸档位（桌面助手用 xl 或 fill，聊天页等其他处用默认 md）
const SIZE_CLASSES = {
  md: 'w-64 h-64',
  lg: 'w-80 h-80',
  xl: 'w-[26rem] h-[26rem]',
};

// 组件对外暴露的引用方法：bindAudio(el) 把 TTS 的 Audio 元素接进来做口型同步
// fill 模式（桌面助手主视觉）：容器由外部定尺寸（约半屏），画布自适应容器，模型按容器高缩放并居中
const VirtualAvatar = forwardRef(function VirtualAvatar(
  { state = 'idle', mouthLevel = 0, size = 'md', fill = false },
  ref,
) {
  const containerRef = useRef(null);   // 画布挂载点
  const canvasRef = useRef(null);      // Pixi canvas（React 只挂一次）
  const pixiAppRef = useRef(null);     // Pixi Application 实例
  const modelRef = useRef(null);       // Live2DModel 实例
  const stateRef = useRef(state);      // state 的 ref 镜像（Pixi 循环内读取最新值）
  const mouthLevelRef = useRef(mouthLevel); // 外部音量 0~1 的 ref 镜像（逐帧口型）
  const analyserRef = useRef(null);    // 口型同步用的 AnalyserNode
  const audioCtxRef = useRef(null);    // 口型同步专用 AudioContext（与页面 VAD 的 context 分开，避免互相干扰）
  const boundAudioRef = useRef(null);  // 已绑定过 createMediaElementSource 的 Audio 元素（同元素不可重复绑定）
  const mutedRef = useRef(false);      // 音频静音时禁用口型驱动（VAD 音量为 0）
  const layoutDoneRef = useRef(false); // 模型是否已完成首次缩放居中布局
  const resizeObsRef = useRef(null);   // ResizeObserver（画布跟随容器）
  const blinkRef = useRef({ next: 3, closeUntil: 0 }); // 代码级眨眼调度（listening/speaking 无 motion 兜底）

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { mouthLevelRef.current = mouthLevel; }, [mouthLevel]);

  // 平滑插值：把参数从当前值缓缓逼近目标值（每次调用返回新目标，取二者之间的中间值）
  const lerp = (cur, target, rate) => cur + (target - cur) * rate;

  // 模型布局：按容器高把模型缩放到 ~94%，水平居中；垂直方向让包围盒中心落在容器略偏下处
  //（站姿人形重心偏上，视觉舒服）。用 getBounds()（世界包围盒，含 position/scale）做
  // 增量校正，幂等收敛：二次调用时高度已达标、仅平移。resize 后同样可安全重入。
  const layoutModel = () => {
    const model = modelRef.current;
    const app = pixiAppRef.current;
    if (!model || !app) return;
    const screenW = app.screen.width;
    const screenH = app.screen.height;
    if (!screenW || !screenH) return;
    let b;
    try { b = model.getBounds(); } catch (e) { return; }
    if (!b || !b.width || !b.height) return;
    // 高度增量缩放：desiredH = 容器高 ×0.94
    const desiredH = screenH * 0.94;
    const mul = desiredH / b.height;
    model.scale.x *= mul;
    model.scale.y *= mul;
    const b2 = model.getBounds();
    // 水平居中；垂直中心放 52% 处（略低于几何中心，站姿更稳、不"飘"）
    const dx = screenW / 2 - (b2.x + b2.width / 2);
    const dy = screenH * 0.52 - (b2.y + b2.height / 2);
    model.position.x += dx;
    model.position.y += dy;
  };

  // 把代码驱动的姿态参数归零（默认态），供"进入模型动作态"前清残留：
  // 停播动作后参数停在上一个 pose（如 listening 歪头 -12°），若直接播 Idle 且该动作
  // 没有对应曲线，小人会一直歪着——先归零再由 motion FadeIn 平滑接管。
  const resetNeutralParams = (model) => {
    const core = model?.internalModel?.coreModel;
    if (!core) return;
    const id = (name) => CubismFramework.getIdManager().getId(name);
    const zero = [PARAM_ANGLE_X, PARAM_ANGLE_Y, PARAM_ANGLE_Z, PARAM_BODY_ANGLE_X,
      PARAM_EYE_L_SMILE, PARAM_EYE_R_SMILE, PARAM_EYE_BALL_X, PARAM_EYE_BALL_Y, PARAM_MOUTH_FORM, PARAM_MOUTH_OPEN];
    zero.forEach((p) => core.setParameterValueById(id(p), 0));
    core.setParameterValueById(id(PARAM_EYE_L_OPEN), 1);
    core.setParameterValueById(id(PARAM_EYE_R_OPEN), 1);
  };

  // 应用一帧姿态。分两种模式：
  // - listening / speaking：停播模型动作，代码全权驱动头/身/眼/口（差异最大、可控）
  // - idle / thinking：模型 motion 主导大动作，代码**不写头/眼参数**（避免每帧把 motion
  //   的大幅动作拉回目标值——旧实现"动作偏小"的根因），只兜底闭嘴。
  const applyPose = (t) => {
    const model = modelRef.current;
    if (!model || !model.internalModel?.coreModel) return;
    const st = stateRef.current;
    const core = model.internalModel.coreModel;
    const id = (name) => CubismFramework.getIdManager().getId(name);
    const codeDriven = st === 'listening' || st === 'speaking';
    const ease = codeDriven ? 0.2 : 0.1; // 代码态更快到位，避免"缓半天"看着没反应

    // 口型：优先 analyser 实时音量，否则用外部 mouthLevel；静音强制闭嘴
    let open = 0;
    if (!mutedRef.current) {
      const analyser = analyserRef.current;
      if (analyser) {
        const buf = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        open = Math.sqrt(sum / buf.length) * 3.5; // RMS → 0~1 开口度（经验增益）
      }
      open = Math.max(open, mouthLevelRef.current);
    }
    open = Math.min(1, open);

    if (codeDriven) {
      const pose = STATE_POSE[st];
      // 波形叠加：倾听=身体左右轻摇（认真在听）；说话=随口型点头+摆体（幅度取口型开度平方，弱音不点头）
      let sway = 0;
      let nod = 0;
      let breathe = 0;
      if (st === 'listening') {
        // 2026-09-03 二次调参：摆动幅度 ±5→±8、频率 1.2→1.6Hz，倾听观感更明显
        sway = Math.sin(t * 1.6) * 8.0;
        breathe = Math.sin(t * 1.8) * 1.2;
      } else {
        const s = open * open;
        nod = Math.sin(t * 11) * s * 6.0;
        sway = Math.sin(t * 6) * s * 3.0;
      }
      core.setParameterValueById(id(PARAM_ANGLE_X), lerp(core.getParameterValueById(id(PARAM_ANGLE_X)), pose.angleX + sway * 0.3, ease));
      core.setParameterValueById(id(PARAM_ANGLE_Y), lerp(core.getParameterValueById(id(PARAM_ANGLE_Y)), pose.angleY + nod, ease));
      core.setParameterValueById(id(PARAM_ANGLE_Z), lerp(core.getParameterValueById(id(PARAM_ANGLE_Z)), pose.angleZ + sway * 0.4, ease));
      core.setParameterValueById(id(PARAM_BODY_ANGLE_X), lerp(core.getParameterValueById(id(PARAM_BODY_ANGLE_X)), pose.bodyAngleX + sway + breathe, ease));
      core.setParameterValueById(id(PARAM_EYE_L_SMILE), lerp(core.getParameterValueById(id(PARAM_EYE_L_SMILE)), pose.eyeL, ease));
      core.setParameterValueById(id(PARAM_EYE_R_SMILE), lerp(core.getParameterValueById(id(PARAM_EYE_R_SMILE)), pose.eyeR, ease));
      core.setParameterValueById(id(PARAM_EYE_BALL_X), lerp(core.getParameterValueById(id(PARAM_EYE_BALL_X)), pose.eyeBallX, ease));
      core.setParameterValueById(id(PARAM_EYE_BALL_Y), lerp(core.getParameterValueById(id(PARAM_EYE_BALL_Y)), pose.eyeBallY, ease));
      core.setParameterValueById(id(PARAM_MOUTH_FORM), lerp(core.getParameterValueById(id(PARAM_MOUTH_FORM)), pose.mouthForm, ease));
      core.setParameterValueById(id(PARAM_MOUTH_OPEN), open);

      // 代码级眨眼 + 呼吸（这两个状态无 motion 兜底，不补会显僵）
      const bl = blinkRef.current;
      let eyeOpen = 1;
      if (t >= bl.closeUntil) {
        if (t >= bl.next) {
          bl.closeUntil = t + 0.16; // 一次眨眼 0.16s
          bl.next = t + 2 + Math.random() * 3; // 下次 2~5s 后
        }
      } else {
        const q = (bl.closeUntil - t) / 0.16; // 1→0
        eyeOpen = Math.abs(q * 2 - 1); // V 形：开→闭→开
      }
      core.setParameterValueById(id(PARAM_EYE_L_OPEN), lerp(core.getParameterValueById(id(PARAM_EYE_L_OPEN)), eyeOpen, 0.5));
      core.setParameterValueById(id(PARAM_EYE_R_OPEN), lerp(core.getParameterValueById(id(PARAM_EYE_R_OPEN)), eyeOpen, 0.5));
      core.setParameterValueById(id(PARAM_BREATH), lerp(core.getParameterValueById(id(PARAM_BREATH)), Math.sin(t * 1.6) * 0.08, ease));
    } else {
      // idle / thinking：动作交给模型 motion（不覆盖头/眼/身体，保持其本来的幅度）。
      // 只做两件事：闭嘴（无声音时 mouthOpen 归 0，避免 motion 里的张嘴残留）+ 不碰其它。
      core.setParameterValueById(id(PARAM_MOUTH_OPEN), open);
    }
  };

  // 初始化 Pixi + Live2D（只执行一次）
  useEffect(() => {
    let disposed = false;
    let pixiApp;
    let model;

    (async () => {
      try {
        configureCubismSDK({ memorySizeMB: 32 }); // Hiyori 纹理较大，加大 Cubism 工作内存防卡顿
        extensions.add(Live2DPlugin);

        // 画布初始尺寸 = 容器当前 CSS 尺寸（fill 时即桌面助手半屏容器；无尺寸先给 400 兜底，
        // 随后 ResizeObserver 校准）。resolution=DPR + autoDensity 保证大画布不糊。
        const rect = containerRef.current?.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect?.width || 400));
        const h = Math.max(1, Math.round(rect?.height || 400));
        pixiApp = new Application();
        await pixiApp.init({
          view: canvasRef.current,
          width: w,
          height: h,
          autoDensity: true,
          resolution: window.devicePixelRatio || 1,
          backgroundAlpha: 0, // 透明背景，融入页面卡片
          antialias: true,
          preference: 'webgl',
        });
        if (disposed) { pixiApp.destroy(true, { children: true }); return; }
        pixiAppRef.current = pixiApp;

        model = await Live2DModel.from(MODEL_PATH);
        if (disposed) { model?.destroy?.(); return; }
        modelRef.current = model;
        pixiApp.stage.addChild(model);

        // 模型首帧 bounds 可用后做一次缩放居中（bounds 需渲染后才算，放在 ticker 首个有效帧）
        layoutDoneRef.current = false;
        const tick = () => {
          try {
            if (!layoutDoneRef.current && model.bounds && model.bounds.width > 0) {
              layoutModel();
              layoutDoneRef.current = true;
            }
            applyPose(performance.now() / 1000);
          } catch (e) { /* 单帧异常不影响后续 */ }
        };
        pixiApp.ticker.add(tick);

        // 画布跟随容器尺寸（fill / 窗口缩放 / 布局变化）：resize 渲染器并重排模型
        const el = containerRef.current;
        if (el) {
          const ro = new ResizeObserver(() => {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) return;
            try {
              pixiApp.renderer.resize(Math.round(r.width), Math.round(r.height));
              if (layoutDoneRef.current) layoutModel(); // 高度变了 → 重算缩放与居中（幂等）
            } catch (e) { /* noop */ }
          });
          ro.observe(el);
          resizeObsRef.current = ro;
        }

        // 初始待机：安稳动作循环（呼吸感），motion 由状态 effect 在切换时接管
        model.motion('Idle', randomGentleIdle(), MotionPriority.IDLE, { loop: true });
      } catch (e) {
        console.error('VirtualAvatar 初始化失败:', e);
      }
    })();

    return () => {
      disposed = true;
      resizeObsRef.current?.disconnect?.();
      resizeObsRef.current = null;
      try { pixiApp?.ticker?.destroy(); } catch (e) { /* noop */ }
      try { pixiApp?.destroy?.(true, { children: true }); } catch (e) { /* noop */ }
      pixiAppRef.current = null;
      modelRef.current = null;
      layoutDoneRef.current = false;
      audioCtxRef.current?.close?.();
      audioCtxRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // state 变化 → 切换动作模式（表情/姿态由 applyPose 持续驱动）：
  // idle/thinking 播模型动作（thinking 固定 m05）；listening/speaking 停播、代码全驱
  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    // Live2D 层异常只记日志，不击穿到页面错误边界（否则整页"桌面助手加载失败"白屏）
    try {
      if (state === 'thinking') {
        resetNeutralParams(model);
        model.motion('Idle', THINKING_MOTION, MotionPriority.NORMAL, { loop: true });
      } else if (state === 'idle') {
        resetNeutralParams(model);
        model.motion('Idle', randomGentleIdle(), MotionPriority.IDLE, { loop: true });
      } else {
        // listening / speaking：避免 Idle 循环覆盖姿态 → 停播，姿态交给 applyPose 代码。
        // 注意：模型实例的方法是 stopMotions()（转调 motionManager.stopAllMotions），
        // 写成 stopAllMotions 会抛 TypeError（2026-09-03 桌面助手加载失败根因）
        model.stopMotions();
      }
    } catch (e) {
      console.error('VirtualAvatar 状态切换失败:', e);
    }
  }, [state]);

  // 对外暴露 bindAudio：把 TTS 的 Audio 元素接进 AnalyserNode，逐帧读取音量驱动口型
  useImperativeHandle(ref, () => ({
    bindAudio(audioEl) {
      if (!audioEl) return;
      try {
        if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
        // createMediaElementSource 同一元素只能绑定一次，已绑过则直接复用 analyser
        if (boundAudioRef.current !== audioEl) {
          const src = audioCtxRef.current.createMediaElementSource(audioEl);
          const analyser = audioCtxRef.current.createAnalyser();
          analyser.fftSize = 1024;
          analyser.smoothingTimeConstant = 0.3;
          src.connect(analyser);
          analyser.connect(audioCtxRef.current.destination); // 必须连到 destination，否则音频不发声
          analyserRef.current = analyser;
          boundAudioRef.current = audioEl;
        }
        // 每次绑定都尝试恢复音频上下文（自动播放策略要求用户手势后才能出声）
        if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
      } catch (e) {
        console.error('VirtualAvatar bindAudio 失败:', e);
      }
    },
    // 静音开关：关闭后口型不跟随音量（避免静音时小人还在张嘴）
    setMuted(v) { mutedRef.current = v; },
  }));

  const containerClass = fill
    ? 'relative w-full h-full'
    : `relative ${SIZE_CLASSES[size] || SIZE_CLASSES.md}`;

  return (
    <div
      ref={containerRef}
      className={`${containerClass} flex items-center justify-center`}
      style={{ pointerEvents: 'none' }}
    >
      <canvas ref={canvasRef} className="w-full h-full" style={{ display: 'block' }} />
    </div>
  );
});

export default VirtualAvatar;

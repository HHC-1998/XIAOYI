import { Component, useEffect, useMemo, useRef } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';

// 星图渲染错误边界（2026-09-03 十三轮）：ForceGraph3D 挂载/生命周期抛错时显示
// 明确错误 + 重试，避免整页只剩星空背景难以排查。
export class GraphBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    // eslint-disable-next-line no-console
    console.error('星图渲染错误:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-stardust-500 gap-3">
          <div className="text-lg">图谱加载失败</div>
          <button
            onClick={() => window.location.reload()}
            className="btn-secondary px-4 py-2"
          >
            点击重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// 3D 力导向图包装组件（对标 3d-force-graph 官方风格，vasturiano/3d-force-graph）
// 星夜主题（03 §9 / 05 §8）：深空背景 + 深空紫连线。
// 普通节点 = 3D 尖芒多角「星石」（共享几何 + 糖果色 MeshPhongMaterial + 加法光晕），
//   按 label 哈希映射糖果色，rAF 自转 + 辉光错落脉动；立体多角、Q 版闪亮。
// 中心节点（is_self）= 明亮发光的 3D 球体（"学长与小亦"群星核心，Graph.jsx 合成），
//   高亮粉紫 + 加法光晕，固定在原点并明显大于普通星石。
// 结构（2026-09-03 十五轮）：双层 Object3D——outer 定位/拖拽/弹回（不缩放），inner 承载星体按
//   度数缩放；名字为常驻 billboard Sprite（细闪小字，hover 提亮）。中心锁死不可拖/不可点，
//   卫星拖拽松手沿方位弹回原轨道半径；hover 放大、自转/拖拽/缩放照旧。
// width/height 由父组件显式传入（Graph 页用 ResizeObserver 量取），保证画布填满可视区。
//
// 注意：three-forcegraph 对 nodeThreeObject 返回的自定义对象不做缩放/着色/透明度
// （默认球分支被绕过），所以星石的尺寸、糖果色与脉动全部由本组件自理。

// ---------- 糖果色板（10 色，闪亮系，深空下醒目） ----------
const CANDY_COLORS = [
  '#ff7eb6', // 草莓粉
  '#5ac8fa', // 冰蓝
  '#4fd8c8', // 薄荷青
  '#b58cff', // 香芋紫
  '#ffb35c', // 蜜橘
  '#ffd94a', // 柠檬黄
  '#ff5e8a', // 玫红
  '#7ee787', // 青苹果
  '#c4a7ff', // 淡紫
  '#ffa7a7', // 蜜桃
];

// 字符串哈希：同 label（节点类型）恒映射到同一糖果色
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function labelToCandyColor(label) {
  return CANDY_COLORS[hashStr(String(label || '')) % CANDY_COLORS.length];
}

// ---------- 3D 尖芒星石几何（模块级共享缓存，多节点复用同一份） ----------
let starGeom = null;

function getStarRockGeometry(k = 12, amp = 0.55, spike = 8) {
  if (starGeom) return starGeom;
  // 芒向：fibonacci 均匀铺球，保证星芒满球分布
  const dirs = [];
  const GA = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < k; i += 1) {
    const y = 1 - (i / (k - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = GA * i;
    dirs.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r));
  }
  const geo = new THREE.SphereGeometry(1, 64, 48);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  // 顶点沿法线方向按"指向各芒向的程度"外推：满球尖芒、旋转可见立体多角
  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i).normalize();
    let dSum = 0;
    for (const d of dirs) {
      const dot = v.dot(d);
      if (dot > 0) dSum += dot ** spike;
    }
    const rr = 1 + amp * dSum;
    pos.setXYZ(i, v.x * rr, v.y * rr, v.z * rr);
  }
  geo.computeVertexNormals();
  starGeom = geo;
  return geo;
}

// ---------- 柔光纹理（模块级缓存，加法混合用，白→透明） ----------
let glowTex = null;

function getGlowTexture() {
  if (glowTex) return glowTex;
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  glowTex = new THREE.CanvasTexture(cv);
  glowTex.colorSpace = THREE.SRGBColorSpace; // r185：线性→sRGB，否则颜色发灰
  return glowTex;
}

// ---------- 常驻名字 Sprite（细闪小字，billboard 永远正对屏幕） ----------
// 2026-09-03 十五轮：hover 弹气泡在手机端不可用，名字改为常驻节点下方——canvas 高分辨率绘制
// 白色柔光中文（星紫光晕，融星夜不突兀），Sprite 恒定世界大小（随缩放等比变大变小），
// 静止态半透明（labelRest），hover 星石时提亮到 1；同名字共用一份纹理缓存。
const labelTexCache = new Map();

function makeLabelSprite(text, glyphWorld) {
  const gText = String(text || '');
  let tex = labelTexCache.get(gText);
  if (!tex) {
    const FS = 90; // 画布字号（高分辨率绘制，sprite 显示时缩小 → 文字清晰）
    const font = `600 ${FS}px "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif`;
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const m = probe.measureText(gText);
    const ascent = m.actualBoundingBoxAscent || FS * 0.8;
    const descent = m.actualBoundingBoxDescent || FS * 0.2;
    const pad = Math.ceil(FS * 0.55);
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(m.width) + pad * 2;
    cv.height = Math.ceil(ascent + descent) + pad * 2;
    const ctx = cv.getContext('2d');
    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.97)';
    // 两层星紫柔光：外层大晕 + 内层细边 → 夜光字观感
    ctx.shadowColor = 'rgba(168,140,255,0.85)';
    ctx.shadowBlur = 16;
    ctx.fillText(gText, pad, pad + ascent);
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'rgba(216,196,255,0.4)';
    ctx.shadowBlur = 30;
    ctx.fillText(gText, pad, pad + ascent);
    tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex._aspect = cv.width / cv.height;
    labelTexCache.set(gText, tex);
  }
  const sp = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0.55, // 实际静止透明度由调用处按 labelRest 覆盖
      depthWrite: false,
    }),
  );
  // 字主体高 ≈ glyphWorld：canvas 高 ≈ 字高 + 2·pad，整体放高到 glyphWorld*2.1 即得净高≈glyphWorld
  const h = glyphWorld * 2.1;
  sp.scale.set(h * tex._aspect, h, 1);
  sp.renderOrder = 20; // 文字最后绘制，叠在星石/光晕/连线之上更清晰
  // 名字只读不交互：透明矩形不参与拾取，避免挡到后方星石
  sp.raycast = () => {};
  return sp;
}

// ---------- 静态星图布局（2026-09-03，十四轮） ----------
// 中心(is_self)钉在原点；普通节点按度数分层放在 fibonacci 均匀球壳上（首帧即与中心分开）。
// 所有节点直接设 fx/fy/fz 预固定：d3 力不移动它们 → 天然不叠中心、不塌缩、无引擎收敛依赖；
// 节点可拖拽（DragControls 对固定节点有效，松手停在原处）。曾用"移除 center 力 + d3ReheatSimulation"
// 干预引擎，但那会在 layout 异步建立前置 engineRunning=true 致渲染循环崩溃（见台账十四轮），已废弃。
const SHELL_MIN = 45; // 初始分布最小半径（中心光晕视觉半径~8，远小于 45）
const SHELL_MAX = 70; // 初始分布最大半径

export function Graph3D({ data, onNodeClick, width, height }) {
  const fgRef = useRef();
  const hoveredNodeRef = useRef(null);

  // 度数（关联度）统计：决定星石尺寸
  const degreeMap = useMemo(() => {
    const m = {};
    (data.links || []).forEach((l) => {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      m[s] = (m[s] || 0) + 1;
      m[t] = (m[t] || 0) + 1;
    });
    return m;
  }, [data]);

  const isSelf = (node) => node?.properties?.is_self === true;

  // 布局预处理（03 §9 / 2026-09-03 十四轮 静态星图布局）：
  // 全节点预固定（fx/fy/fz = x/y/z）——中心(is_self)固定原点，普通节点固定在各度数分层的
  // fibonacci 均匀球壳上（r = clamp(70 - √deg·8, 45, 70)，中心光晕视觉半径仅 ~8 远小于 45）。
  // 固定节点不被任何 d3 力移动 → 天然不叠中心、不塌缩、无引擎收敛依赖；DragControls 对
  // 固定节点拖拽照常工作、松手停在原处（three-forcegraph 在拖拽期改 fx、dragend 保持）。
  const graphData = useMemo(() => {
    const self = (data.nodes || []).find((n) => n.properties?.is_self === true);
    const others = (data.nodes || []).filter((n) => !(self && n.id === self.id));
    const GA = Math.PI * (3 - Math.sqrt(5)); // 黄金角
    const nodes = others.map((n, i) => {
      const y = 1 - (i / Math.max(1, others.length)) * 2; // fibonacci 球面 y
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const th = GA * i;
      const deg = degreeMap[n.id] || 0;
      // 度数越高越靠内（关联度高=更贴近中心），但下限 SHELL_MIN 保证不贴脸
      const r = Math.max(SHELL_MIN, Math.min(SHELL_MAX, 70 - Math.sqrt(deg) * 8));
      const x = r * rr * Math.cos(th);
      const y2 = r * y;
      const z = r * rr * Math.sin(th);
      return { ...n, x, y: y2, z, fx: x, fy: y2, fz: z };
    });
    if (self) {
      nodes.push({ ...self, fx: 0, fy: 0, fz: 0, x: 0, y: 0, z: 0, val: 40 });
    }
    return { nodes, links: data.links || [] };
  }, [data, degreeMap]);

  // 普通星石半径：按度数（关联度越高略大），范围 [1.0, 1.9]
  const starScale = (node) => {
    const deg = degreeMap[node.id] || 0;
    return Math.min(1.9, Math.max(1.0, Math.sqrt(deg) * 0.3 + 0.85));
  };

  // hover 放大 / 还原（2026-09-03 十五轮 双层结构）：星体在内层 inner 上、按 starScale 缩放；
  // hover 只放大 inner（名字不跟着变大），并把常驻名字提亮到 1，移出还原回 labelRest。
  const setHoverScale = (node, factor) => {
    const obj = node?.__threeObj;
    const ud = obj?.userData;
    if (!obj || !ud) return;
    const def = ud.defScale;
    if (ud.inner) {
      ud.inner.scale.set(def.x * factor, def.y * factor, def.z * factor);
    } else {
      obj.scale.set(def.x * factor, def.y * factor, def.z * factor);
    }
    if (ud.label) ud.label.material.opacity = factor > 1 ? 1 : (ud.labelRest ?? 0.6);
  };
  const handleNodeHover = (node) => {
    if (hoveredNodeRef.current && hoveredNodeRef.current !== node) {
      setHoverScale(hoveredNodeRef.current, 1);
    }
    if (node) setHoverScale(node, 1.5);
    hoveredNodeRef.current = node;
  };

  // 拖拽语义（2026-09-03 十五轮）：普通星可自由拖拽"转动星座"，松手沿当前方位弹回
  // 原轨道半径 shellR（永不塌进中心）；中心节点已禁射线（见 nodeThreeObject），不会触发到这里。
  const handleNodeDrag = (node) => {
    const ud = node?.__threeObj?.userData;
    if (ud?.kind === 'star') ud.snap = null; // 拖动开始：取消未完成的弹回
  };
  const handleNodeDragEnd = (node) => {
    const obj = node?.__threeObj;
    const ud = obj?.userData;
    if (!obj || ud?.kind !== 'star') return;
    const v = new THREE.Vector3(node.x, node.y, node.z);
    if (v.lengthSq() < 1e-6) v.copy(ud.dir0); // 拖到中心附近兜底：沿原方向弹回
    v.normalize().multiplyScalar(ud.shellR);
    ud.snap = {
      sx: node.x, sy: node.y, sz: node.z,
      tx: v.x, ty: v.y, tz: v.z,
      t: 0,
    };
  };

  // 节点对象（2026-09-03 十五轮起 双层 + 名字常驻）：外层 outer 负责定位/拖拽/弹回动画（不缩放），
  // 内层 inner 承载星体并按 starScale 缩放（hover 只放大 inner），常驻名字 label Sprite 挂 outer。
  const nodeThreeObject = (node) => {
    // 群星核心「学长与小亦」：亮粉紫 3D 球 + 加法光晕 + 内层 halo + 常驻名字
    if (isSelf(node)) {
      const outer = new THREE.Group();
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: getGlowTexture(),
          color: new THREE.Color(0xffb8e0),
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      glow.scale.set(8, 8, 1);
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(1, 48, 48),
        new THREE.MeshPhongMaterial({
          color: 0xffc4ec, // 亮粉
          emissive: 0xa85cf0, // 星紫辉光
          emissiveIntensity: 0.7,
          shininess: 90,
        }),
      );
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(1.5, 32, 32),
        new THREE.MeshBasicMaterial({
          color: 0x9d6cff,
          transparent: true,
          opacity: 0.22,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      const inner = new THREE.Group();
      inner.add(halo, glow, core);
      const label = makeLabelSprite(node.name || '小亦', 2.6); // 核心名略大，置于光晕下方
      label.position.set(0, -5.6, 0);
      label.material.opacity = 0.8; // labelRest：核心名比星名稍亮
      outer.add(inner, label);
      outer.userData = {
        kind: 'core',
        defScale: { x: 1, y: 1, z: 1 },
        glow,
        core,
        inner,
        label,
        labelRest: 0.8,
      };
      // 中心锁死（2026-09-03 十五轮）：整棵子树射线禁命中 → 拖拽/悬停/点击都绕开它，
      // 「学长与小亦」永远钉在屏幕最中心（原点，fx/fy/fz=0 不被引擎/拖拽改动）；名字照常显示。
      outer.traverse((o) => {
        o.raycast = () => {};
      });
      return outer;
    }

    // 普通节点：尖芒星石 + 加法柔光（颜色=糖果色）+ 常驻名字
    const candy = labelToCandyColor(node.label || node.name || '');
    const color = new THREE.Color(candy);
    const inner = new THREE.Group();
    const mesh = new THREE.Mesh(
      getStarRockGeometry(),
      new THREE.MeshPhongMaterial({
        color,
        emissive: color.clone(),
        emissiveIntensity: 0.5,
        shininess: 70,
      }),
    );
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: getGlowTexture(),
        color: color.clone(),
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    // 光晕比星体大一圈：内层缩放下子对象同比缩放
    glow.scale.set(4.6, 4.6, 1);
    inner.add(mesh, glow);
    const s = starScale(node);
    inner.scale.set(s, s, s);

    const outer = new THREE.Group();
    const label = makeLabelSprite(node.name || node.label || '', 2.2); // 名字在星石下方
    label.position.set(0, -(s * 1.9 + 1.8), 0);
    label.material.opacity = 0.62; // labelRest：静止态半透明细闪小字
    outer.add(inner, label);

    // shellR/dir0：拖拽弹回轨道用（见 handleNodeDragEnd）——初始即已预固定 fx/fy/fz
    const fx = node.fx ?? node.x ?? 0;
    const fy = node.fy ?? node.y ?? 0;
    const fz = node.fz ?? node.z ?? 0;
    const R = Math.hypot(fx, fy, fz) || SHELL_MIN;
    outer.userData = {
      kind: 'star',
      defScale: { x: s, y: s, z: s },
      mesh,
      glow,
      inner,
      label,
      labelRest: 0.62,
      phase: Math.random() * Math.PI * 2,
      speed: 0.8 + Math.random() * 1.4, // 辉光脉动角速度
      rotSpeed: 0.2 + Math.random() * 0.5, // 自转角速度 rad/s
      shellR: R,
      dir0: new THREE.Vector3(fx, fy, fz).normalize(),
      snap: null, // 弹回动画状态（handleNodeDragEnd 写入，rAF 消费）
    };
    return outer;
  };

  // 星石自转 + 辉光错落脉动：只动 rotation / material，不与 hover 缩放冲突
  // 十三轮修复：直接遍历闭包 graphData.nodes 读 node.__threeObj（three-forcegraph 会把
  // 渲染对象挂到数据节点的 __threeObj 上）；此前误调 fgRef.current.graphData()——该方法
  // 不在 react-force-graph-3d 暴露的 methodNames 里（graphData 是 prop 不是方法），
  // 每帧必抛 TypeError，动画与渲染循环随之中断。
  useEffect(() => {
    const list = graphData?.nodes;
    if (!list || list.length === 0) return; // 空图（引擎未挂载）：无对象可驱动
    let raf = 0;
    let last = performance.now();
    const t0 = last;
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = (now - t0) / 1000;
      for (let i = 0; i < list.length; i += 1) {
        const ud = list[i].__threeObj?.userData;
        if (!ud) continue;
        if (ud.kind === 'star') {
          // 自转让 3D 尖芒"转起来"，立体感
          ud.mesh.rotation.y += dt * ud.rotSpeed;
          ud.mesh.rotation.x += dt * ud.rotSpeed * 0.35;
          const w = 0.5 + 0.5 * Math.sin(t * ud.speed + ud.phase);
          ud.glow.material.opacity = 0.45 + 0.42 * w; // 布灵布灵错落闪烁
          ud.mesh.material.emissiveIntensity = 0.32 + 0.5 * w;
          // 十五轮：拖拽松手后弹回原轨道半径（easeOutCubic ~0.32s，先快后缓）
          if (ud.snap) {
            const sp = ud.snap;
            sp.t += dt / 0.32;
            const k = Math.min(1, sp.t);
            const e = 1 - (1 - k) ** 3;
            const o = list[i].__threeObj; // outer
            const p = o.position;
            p.x = sp.sx + (sp.tx - sp.sx) * e;
            p.y = sp.sy + (sp.ty - sp.sy) * e;
            p.z = sp.sz + (sp.tz - sp.sz) * e;
            // 同步节点坐标：连线端点 / 再次拖拽都读到最新位置（引擎静止期不会反向覆盖）
            const n = list[i];
            n.x = p.x;
            n.y = p.y;
            n.z = p.z;
            n.fx = p.x;
            n.fy = p.y;
            n.fz = p.z;
            if (k >= 1) ud.snap = null;
          }
        } else if (ud.kind === 'core') {
          // 中心球轻脉动呼吸
          const w = 0.5 + 0.5 * Math.sin(t * 1.4);
          ud.glow.material.opacity = 0.7 + 0.25 * w;
          ud.core.material.emissiveIntensity = 0.55 + 0.35 * w;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [graphData]);

  // 相机对准原点：库默认相机距离按节点数开三次方（节点少时极近），这里固定拉到 z=150。
  // 只动相机、不碰引擎内部状态（不再调 d3Force/d3ReheatSimulation——十四轮确认它在
  // layout 异步建立前置 engineRunning=true，首个动画帧 tick undefined 即抛错并杀死渲染循环）。
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || typeof fg.cameraPosition !== 'function') return;
    try {
      fg.cameraPosition({ x: 0, y: 0, z: 150 });
      fg.camera()?.lookAt(0, 0, 0);
    } catch (e) {
      console.error('Graph3D 相机设置失败:', e);
    }
  }, [graphData]);

  // 诊断日志（2026-09-03 十一轮）：数据量变化时打印一次。若星图异常，凭此秒级定位是
  // 「后端数据空(nodes=0)」还是「渲染层问题(nodes>0 仍白屏)」。
  useEffect(() => {
    console.log('[Graph3D] nodes:', graphData.nodes.length, 'links:', graphData.links.length);
  }, [graphData]);

  // 空图 gate（2026-09-03 十三轮）：nodes=0 时不挂载 ForceGraph3D——引擎在空图阶段
  // init 后首个动画帧就 tick 到未建立的 layout 会抛错并中断渲染循环；有节点再挂载，
  // 首次应用数据时 layout 即建立，避开该崩溃路径。
  if (!data.nodes || data.nodes.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <p className="text-sm text-stardust-500">图谱还没有节点，先和小亦聊几句吧</p>
      </div>
    );
  }

  return (
    <GraphBoundary>
      <div className="absolute inset-0 graph3d-shell">
        <ForceGraph3D
          ref={fgRef}
          graphData={graphData}
          width={width}
          height={height}
          // 透明画布（2026-09-03 十二轮）：backgroundColor 用 rgba(0,0,0,0)，three-render-objects
          // 会 setClearColor(黑色, alpha=0) → WebGL 画布全透明，露出 App 根节点 .starry-sky 星夜，
          // 使星图与星语/星伴/拾光背景完全一致（renderer 默认 alpha:true，官方支持透明叠加）。
          backgroundColor="rgba(0,0,0,0)"
          // 节点名字已常驻 Sprite 化（十五轮）：显式置空库默认气泡，仅连线悬停保留玻璃气泡
          nodeLabel={() => ''}
          nodeThreeObject={nodeThreeObject}
          // 星石/核心为自定义对象：nodeAutoColorBy / nodeOpacity / nodeRelSize / nodeVal 对默认球失效，已移除
          // 边：简洁静态连线（无箭头/粒子/曲率），悬停显示关系类型（03 §9）
          linkLabel={(l) => (l.type ? `关系：${l.type}` : '关系')}
          linkColor={() => 'rgba(124, 108, 255, 0.55)'}
          linkWidth={1.5}
          linkHoverPrecision={10}
          onNodeHover={handleNodeHover}
          onNodeClick={onNodeClick}
          onNodeDrag={handleNodeDrag}
          onNodeDragEnd={handleNodeDragEnd}
          autoRotate
          autoRotateSpeed={0.6}
          warmupTicks={60}
        />
      </div>
    </GraphBoundary>
  );
}

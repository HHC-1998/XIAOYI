import { useEffect, useState, useRef, useLayoutEffect } from 'react';
import { memoryApi } from '../api/memory';
import { NodeDetail } from '../components/NodeDetail';
import { Graph3D, GraphBoundary } from '../components/Graph3D';
import { useModelStatus } from '../hooks/useModelStatus';

// 双人中心合成（2026-09-03，03 §9）：图谱只记录"小亦 + 用户"共同发生的事，
// 把 is_self 节点与小亦(is_bot)节点在展示层合成一个中心节点：
// bot 节点移除、其关系并入 self 节点、名字合并为 "<昵称简称>与小亦"。
// 昵称「星辰学长」展示时省略前缀「星辰」，中心显示名即「学长与小亦」（2026-09-03）。
// 仅改前端展示数据，后端 is_self/is_bot 不变量与检索链路不受影响。
export function composeDuoCenter(data) {
  const nodes = [...(data.nodes || [])];
  const links = [...(data.links || [])];
  const self = nodes.find((n) => n.properties?.is_self === true);
  const bot = nodes.find((n) => n.properties?.is_bot === true);
  if (!self || !bot) return data;

  const selfId = self.id;
  const botId = bot.id;

  // 幂等：反复加载不叠加后缀；昵称"星辰学长"→简称"学长"再并名
  const short = (self.name || '').replace(/^星辰/, '') || self.name || '学长';
  const combined = short.includes('与小亦') ? short : `${short}与小亦`;

  const mapEnd = (v) => {
    const id = typeof v === 'object' && v !== null ? v.id : v;
    return id === botId ? selfId : id;
  };
  const mappedLinks = [];
  for (const l of links) {
    const s = mapEnd(l.source);
    const t = mapEnd(l.target);
    if (s === t) continue; // 合并后自环无信息量，丢弃
    mappedLinks.push({ ...l, source: s, target: t });
  }

  return {
    nodes: [
      { ...self, name: combined },
      ...nodes.filter((n) => n.id !== botId && n.id !== selfId),
    ],
    links: mappedLinks,
    truncated: data.truncated,
  };
}

export default function Graph() {
  const containerRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [data, setData] = useState({ nodes: [], links: [] });
  const [truncated, setTruncated] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);
  const { chat_configured: chatConfigured } = useModelStatus();

  useEffect(() => {
    memoryApi.getGraph().then((r) => {
      setData(composeDuoCenter(r));
      setTruncated(Boolean(r.truncated));
    });
  }, []);

  // 量取容器真实尺寸，显式传给 3D 画布（填满可视区、无滚动条；窗口变化时跟随）
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleNodeClick = (node) => {
    setSelectedNode(node);
  };

  const handleDeleteNode = async (nodeId, password) => {
    await memoryApi.deleteNode(nodeId, password);
    // 兼容 source/target 为 id 字符串或节点对象两种形态
    const srcId = (l) => (typeof l.source === 'object' ? l.source?.id : l.source);
    const tgtId = (l) => (typeof l.target === 'object' ? l.target?.id : l.target);
    setData((prev) => ({
      nodes: prev.nodes.filter((n) => n.id !== nodeId),
      links: prev.links.filter((l) => srcId(l) !== nodeId && tgtId(l) !== nodeId),
    }));
    setSelectedNode(null);
  };

  return (
    // 去掉实色 bg-night-900（2026-09-03 十二轮）：透出 App 根节点 .starry-sky 星夜，
    // 使星图与星语/星伴/拾光背景一致；星点由 Graph3D 透明画布直接透显。
    // GraphBoundary（十三轮）：ForceGraph3D 渲染错误时显示重试而非整页空白。
    <div ref={containerRef} className="absolute inset-0">
      <GraphBoundary>
        <Graph3D data={data} onNodeClick={handleNodeClick} width={size.width} height={size.height} />
      </GraphBoundary>
      {truncated && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 px-4 py-2 glass text-stardust-300 text-sm rounded-full shadow-glow">
          图谱关系较多，当前仅显示前 {data.links.length} 条关系（图谱会随对话逐渐整理，不必担心）
        </div>
      )}
      {!chatConfigured && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 px-4 py-2 glass text-blush-200 text-sm rounded-full shadow-glow">
          您还没有配置对话模型，请到
          <a href="/settings" className="mx-1 underline font-medium">设置页</a>
          配置后再开始对话。
        </div>
      )}
      {selectedNode && (
        <NodeDetail
          node={selectedNode}
          onClose={() => setSelectedNode(null)}
          onDelete={handleDeleteNode}
        />
      )}
    </div>
  );
}

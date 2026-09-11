import { useState } from 'react';

export function NodeDetail({ node, onClose, onDelete }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  return (
    <div className="absolute top-4 right-4 w-80 max-w-[calc(100vw-2rem)] glass-strong rounded-3xl p-5">
      <h3 className="font-bold text-stardust-100 mb-2">{node.name}</h3>
      <div className="text-sm text-stardust-300 space-y-1">
        <p>类型：<span className="text-blush-200">{node.label}</span></p>
        <p>别名：{node.properties?.aliases?.join(', ') || '无'}</p>
        <p>描述：{node.properties?.summary || '暂无'}</p>
      </div>
      <div className="mt-4">
        <p className="text-sm text-stardust-500 mb-2">删除节点需要输入密码：</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input-base mb-2"
        />
        {error && <p className="text-blush-300 text-sm mb-2">{error}</p>}
        <button
          onClick={async () => {
            try {
              await onDelete(node.id, password);
            } catch (e) {
              setError(e.response?.data?.detail || '删除失败');
            }
          }}
          className="rounded-full bg-gradient-to-r from-red-500 to-blush-500 text-white px-4 py-1.5 text-sm hover:brightness-110 transition mr-2"
        >
          删除节点
        </button>
        <button onClick={onClose} className="btn-secondary">
          关闭
        </button>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';

// 确认弹窗：open 控制显隐，onConfirm(password) 在确认时回调（免密模式回调不传参），
// onClose 在取消/遮罩点击/失败后关闭时回调。
// props: { open, onConfirm, onClose, title, description, confirmText, requirePassword }
// title/description/confirmText 为可选文案（默认"确认清空数据"系列，Settings 数据管理区沿用默认值）。
// requirePassword 默认为 true（显示密码输入框）；传 false 时免密（聊天会话软删除用）。
export function DeleteConfirm({ open, onConfirm, onClose, title, description, confirmText, requirePassword = true }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setPassword('');
      setError('');
      if (requirePassword) inputRef.current?.focus();   // 打开即聚焦密码输入
    }
  }, [open, requirePassword]);

  if (!open) return null;

  const handleConfirm = async () => {
    if (requirePassword && !password) return setError('请输入密码');
    setLoading(true);
    setError('');
    try {
      if (requirePassword) {
        await onConfirm(password);
        setPassword('');
      } else {
        await onConfirm();
      }
    } catch (e) {
      setError(e.response?.data?.detail || '操作失败，请重试');   // 密码错误等后端 403
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-night-950/70 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="glass-strong rounded-3xl p-6 w-80 border-white/[0.15]" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-stardust-100 mb-2">{title || '确认清空数据'}</h3>
        <p className="text-sm text-stardust-500 mb-4">{description || '该操作不可恢复，请输入密码确认。'}</p>
        {requirePassword && (
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
            placeholder="请输入密码"
            className="input-base mb-3"
          />
        )}
        {error && <p className="text-blush-300 text-sm mb-3">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-1.5 rounded-full text-stardust-300 hover:bg-white/10 disabled:opacity-50 transition"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="px-5 py-1.5 rounded-full bg-gradient-to-r from-nebula-500 to-blush-400 text-white hover:brightness-110 disabled:opacity-50 transition"
          >
            {loading ? '处理中…' : (confirmText || '确认清空')}
          </button>
        </div>
      </div>
    </div>
  );
}

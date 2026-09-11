import { useEffect, useState, useRef } from 'react';
import { settingsApi } from '../api/settings';
import { authApi } from '../api/auth';
import { api } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { DeleteConfirm } from '../components/DeleteConfirm';

export default function Settings() {
  const { setUser } = useAuth();   // 绑定手机号成功后刷新全局用户信息
  const [deleteTarget, setDeleteTarget] = useState(null);

  // 账号绑定（为账号补录手机号 + 密码，之后可用手机号+密码登录）
  const [bindPhone, setBindPhone] = useState('');
  const [bindCode, setBindCode] = useState('');
  const [bindPassword, setBindPassword] = useState('');
  const [bindCountdown, setBindCountdown] = useState(0);
  const bindTimerRef = useRef(null);   // 绑定验证码倒计时定时器（卸载清理，防 setInterval 泄漏）
  useEffect(
    () => () => {
      clearInterval(bindTimerRef.current);
    },
    []
  );

  const clearData = async (type, password) => {
    await settingsApi.clearData(type, password);
    alert('已清空');
  };

  const sendBindCode = async () => {
    if (!bindPhone) return alert('请填写手机号');
    const res = await authApi.sendCode(bindPhone);
    // mock 模式（SMS_MOCK=1）后端直接把验证码随响应返回：自动填入 + 提示，与 Login/Register
    // 一致，否则 mock 下用户看不到验证码无法完成绑定（2026-08-17 修）
    if (res?.code) {
      setBindCode(res.code);
      alert(`演示模式，验证码已自动填入：${res.code}`);
    }
    setBindCountdown(60);
    clearInterval(bindTimerRef.current);   // 防连续点击叠加多个倒计时定时器
    bindTimerRef.current = setInterval(() => {
      setBindCountdown((c) => {
        if (c <= 1) { clearInterval(bindTimerRef.current); return 0; }
        return c - 1;
      });
    }, 1000);
  };

  const bindAccount = async () => {
    if (!bindPhone || !bindCode || !bindPassword) return alert('请填写手机号、验证码和新密码');
    await authApi.bindPhone({ phone: bindPhone, code: bindCode, password: bindPassword });
    setUser(await authApi.me());   // 刷新全局用户（昵称/手机号），顶部导航同步更新
    alert('绑定成功，可用手机号+密码登录');
    setBindPhone('');
    setBindCode('');
    setBindPassword('');
  };

  // 导出全部数据（09 §4.1）：下载 xiaoyi_backup.zip
  const exportAll = async () => {
    const res = await fetch('/api/data/export', {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    });
    if (!res.ok) return alert('导出失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'xiaoyi_backup.zip';
    a.click();
    URL.revokeObjectURL(url);
  };

  // 导入备份（09 §5）：需当前用户本人备份
  const importBackup = async (file) => {
    const form = new FormData();
    form.append('file', file);
    try {
      await api.post('/api/data/import', form);
      alert('导入成功');
    } catch (e) {
      alert(e.response?.data?.detail || '导入失败');
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-1 text-stardust-100">设置</h1>
      <p className="text-sm text-stardust-500 mb-5">小亦的小窝，随你摆弄</p>

      <section className="glass rounded-3xl p-6 mb-6">
        <h2 className="font-bold mb-3 text-stardust-100">模型配置</h2>
        <p className="text-sm text-stardust-300">
          对话 / 记忆抽取 / 向量化模型已在环境变量（<code>.env</code>）中固定配置，全部走本地
          Ollama，无需在此设置：
        </p>
        <ul className="mt-2 text-sm text-stardust-500 list-disc list-inside space-y-1">
          <li>聊天模型：<code>XIAOYI_CHAT_MODEL</code>（本地微调说话风格模型）</li>
          <li>记忆抽取模型：<code>XIAOYI_EXTRACT_MODEL</code>（本地千问）</li>
          <li>向量化模型：<code>XIAOYI_EMBEDDING_MODEL</code>（本地 bge）</li>
        </ul>
      </section>

      <section className="glass rounded-3xl p-6 mb-6">
        <h2 className="font-bold mb-3 text-stardust-100">账号绑定</h2>
        <p className="text-sm text-stardust-500 mb-3">
          为当前账号补录真实手机号与密码（注册账号的初始账号没有真实手机号/密码，补录后可用手机号+密码登录）：
        </p>
        <div className="flex gap-2 mb-2 flex-wrap">
          <input value={bindPhone} onChange={(e) => setBindPhone(e.target.value)} placeholder="手机号" className="input-base max-w-[200px]" />
          <input value={bindCode} onChange={(e) => setBindCode(e.target.value)} placeholder="验证码" className="input-base w-28" />
          <button onClick={sendBindCode} disabled={bindCountdown > 0} className="shrink-0 px-4 py-2 rounded-full border border-white/[0.15] bg-white/[0.08] text-sm text-stardust-300 hover:bg-white/[0.15] disabled:opacity-50">
            {bindCountdown > 0 ? `${bindCountdown}s` : '获取验证码'}
          </button>
        </div>
        <div className="flex gap-2 flex-wrap">
          <input type="password" value={bindPassword} onChange={(e) => setBindPassword(e.target.value)} placeholder="新密码" className="input-base max-w-[200px]" />
          <button onClick={bindAccount} className="btn-primary px-5 py-2.5">绑定</button>
        </div>
      </section>

      <section className="glass rounded-3xl p-6 mb-6">
        <h2 className="font-bold mb-3 text-stardust-100">数据管理</h2>
        <div className="flex gap-2 mb-4 flex-wrap">
          <button onClick={exportAll} className="btn-secondary">导出全部数据</button>
          <label className="btn-secondary cursor-pointer">
            导入备份
            <input
              type="file"
              accept=".zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importBackup(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setDeleteTarget('sql')} className="rounded-full border border-blush-400/30 bg-blush-500/10 text-blush-300 px-3.5 py-1.5 text-sm hover:bg-blush-500/20 transition">清空 SQL 对话</button>
          <button onClick={() => setDeleteTarget('chroma')} className="rounded-full border border-blush-400/30 bg-blush-500/10 text-blush-300 px-3.5 py-1.5 text-sm hover:bg-blush-500/20 transition">清空 Chroma 向量</button>
          <button onClick={() => setDeleteTarget('kg')} className="rounded-full border border-blush-400/30 bg-blush-500/10 text-blush-300 px-3.5 py-1.5 text-sm hover:bg-blush-500/20 transition">清空知识图谱</button>
          <button onClick={() => setDeleteTarget('all')} className="rounded-full bg-gradient-to-r from-red-500 to-blush-500 text-white px-4 py-1.5 text-sm hover:brightness-110 transition">清空全部数据</button>
        </div>

        <DeleteConfirm
          open={deleteTarget !== null}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async (password) => {
            await clearData(deleteTarget, password);
            setDeleteTarget(null);
          }}
        />
      </section>
    </div>
  );
}

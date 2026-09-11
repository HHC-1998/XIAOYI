import { useState, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { authApi } from '../api/auth';
import { useAuth } from '../hooks/useAuth';

export default function Login() {
  const [mode, setMode] = useState('password'); // 'password' | 'code'
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { login } = useAuth();
  const timerRef = useRef(null);   // 验证码倒计时定时器（卸载清理，防 setInterval 泄漏）

  // 组件卸载时清理倒计时定时器（切页/离开后不再 setState）
  useEffect(() => () => clearInterval(timerRef.current), []);

  const sendCode = async () => {
    if (!phone) return setError('请填写手机号');
    try {
      const res = await authApi.sendCode(phone);
      if (res?.code) {
        setCode(res.code);
        setError(`演示模式，验证码已自动填入：${res.code}`);
      }
      setCountdown(60);
      clearInterval(timerRef.current);   // 防连续点击叠加多个倒计时定时器
      timerRef.current = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) { clearInterval(timerRef.current); return 0; }
          return c - 1;
        });
      }, 1000);
    } catch (e) {
      setError(e.response?.data?.detail || '验证码发送失败');
    }
  };

  const handleSubmit = async () => {
    setError('');
    try {
      const res = mode === 'password'
        ? await authApi.login({ phone, password })
        : await authApi.login({ phone, code });
      login(res.token, res.user);
      navigate('/');
    } catch (e) {
      setError(e.response?.data?.detail || '登录失败');
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center p-4">
      <div className="glass-strong p-8 rounded-3xl w-96 max-w-[92vw] space-y-5">
        <div className="text-center">
          <div className="mx-auto mb-4 w-16 h-16 rounded-full bg-gradient-to-br from-nebula-500 to-blush-400 flex items-center justify-center text-3xl text-white shadow-glow">
            ✦
          </div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-nebula-300 to-blush-300 bg-clip-text text-transparent mb-1">
            XIAOYI 小亦
          </h1>
          <p className="text-sm text-stardust-500">欢迎回来，登录以继续</p>
        </div>
        <div className="flex gap-1 p-1 bg-white/[0.08] border border-white/10 rounded-full">
          <button
            onClick={() => setMode('password')}
            className={`flex-1 py-2 rounded-full text-sm font-medium transition ${
              mode === 'password' ? 'bg-white/[0.12] text-blush-200 shadow-inner-glow' : 'text-stardust-500 hover:text-stardust-300'
            }`}
          >
            密码登录
          </button>
          <button
            onClick={() => setMode('code')}
            className={`flex-1 py-2 rounded-full text-sm font-medium transition ${
              mode === 'code' ? 'bg-white/[0.12] text-blush-200 shadow-inner-glow' : 'text-stardust-500 hover:text-stardust-300'
            }`}
          >
            验证码登录
          </button>
        </div>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="手机号"
          className="input-base"
        />
        {mode === 'password' ? (
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="密码"
            className="input-base"
          />
        ) : (
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              placeholder="验证码"
              className="input-base"
            />
            <button
              onClick={sendCode}
              disabled={countdown > 0}
              className="shrink-0 px-3 py-2 rounded-full border border-white/[0.15] bg-white/[0.08] text-sm text-stardust-300 hover:bg-white/[0.15] disabled:opacity-50"
            >
              {countdown > 0 ? `${countdown}s` : '获取验证码'}
            </button>
          </div>
        )}
        {error && <p className="text-blush-300 text-sm">{error}</p>}
        <button onClick={handleSubmit} className="btn-primary w-full py-2.5">
          登录
        </button>
        <Link to="/register" className="block text-center text-sm text-nebula-300 hover:text-blush-300">
          还没有账号？注册
        </Link>
      </div>
    </div>
  );
}

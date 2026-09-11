import { createContext, useState, useEffect } from 'react';

export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    // 启动时用本地 token 校验登录态（GET /api/auth/me）
    const token = localStorage.getItem('token');
    if (!token) return setInitializing(false);
    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (res.status === 401) {
          // 仅 401（token 失效）清除本地 token：5xx/断网等错误不清登录态，
          // 避免后端临时故障把已登录用户弹回登录页（下次刷新自动重试）
          localStorage.removeItem('token');
          return null;
        }
        if (!res.ok) return undefined;   // 5xx 等错误：保留 token，不覆盖现有登录态
        return res.json();
      })
      .then((u) => {
        if (u !== undefined) setUser(u);
      })
      .catch(() => { /* 网络异常：保留 token 与登录态，下次刷新重试 */ })
      .finally(() => setInitializing(false));
  }, []);

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
  };

  // 登录/注册成功后的统一入口：写入 token + 设置全局 user。
  // 若不更新 user，AuthRoute 会因 user 为 null 把刚登录的用户弹回 /login（曾导致跳转 bug）。
  const login = (token, user) => {
    localStorage.setItem('token', token);
    setUser(user);
  };

  return (
    <AuthContext.Provider value={{ user, setUser, initializing, logout, login }}>
      {children}
    </AuthContext.Provider>
  );
}

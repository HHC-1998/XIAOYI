import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export function AuthRoute({ children }) {
  const { user, initializing } = useAuth();
  // 刷新页面时 token 尚未校验完成：显示 loading，避免登录页闪跳
  if (initializing) {
    return <div className="h-screen flex items-center justify-center text-stardust-500">加载中...</div>;
  }
  return user ? children : <Navigate to="/login" replace />;
}

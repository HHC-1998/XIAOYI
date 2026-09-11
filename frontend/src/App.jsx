import { Component, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { useAuth } from './hooks/useAuth';
import { AuthRoute } from './components/AuthRoute';
import Navbar from './components/Navbar';
import MobileTabBar from './components/MobileTabBar';
import Login from './pages/Login';
import Register from './pages/Register';
import Chat from './pages/Chat';
import Graph from './pages/Graph';
import Settings from './pages/Settings';
import Gallery from './pages/Gallery';

// 桌面助手页含 Live2D/PixiJS 渲染（体积较大），延迟到进入 /desktop 时才加载，不拖累聊天页首屏
const DesktopAssistant = lazy(() => import('./pages/DesktopAssistant'));

// 懒加载 chunk 错误边界：分片加载失败（部署后旧版本缓存/网络异常）时展示重试而非白屏
class LazyBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    // eslint-disable-next-line no-console
    console.error('Lazy chunk load failed:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-stardust-500 gap-3">
          <div className="text-lg">桌面助手加载失败</div>
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

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppLayout />
      </BrowserRouter>
    </AuthProvider>
  );
}

function AppLayout() {
  const { user } = useAuth();

  return (
    <div className="h-screen flex flex-col starry-sky">
      {/* 导航双轨（2026-09-03）：桌面=顶部 Navbar（内含移动极简顶栏），移动=底部 MobileTabBar */}
      {user && <Navbar />}
      <main className="flex-1 relative overflow-auto">
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/" element={<AuthRoute><Chat /></AuthRoute>} />
          <Route path="/graph" element={<AuthRoute><Graph /></AuthRoute>} />
          <Route path="/desktop" element={
            <AuthRoute>
              <LazyBoundary>
                <Suspense fallback={<div className="flex items-center justify-center h-full text-stardust-500">加载桌面助手...</div>}>
                  <DesktopAssistant />
                </Suspense>
              </LazyBoundary>
            </AuthRoute>
          } />
          <Route path="/gallery" element={<AuthRoute><Gallery /></AuthRoute>} />
          <Route path="/settings" element={<AuthRoute><Settings /></AuthRoute>} />
        </Routes>
      </main>
      {/* 移动端底部导航：仅 <md 显示（桌面仍走顶部 Navbar） */}
      {user && <MobileTabBar />}
    </div>
  );
}

export default App;

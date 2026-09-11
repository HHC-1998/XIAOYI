import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

// 导航星象名（2026-09-03，呼应小亦"星空/收集星系"人设）：
//   /        星语（文字聊天——和小亦说的话都是星星的低语）
//   /desktop 星伴（桌面语音陪伴——Live2D 小亦陪你）
//   /gallery 拾光（视觉照片墙——小亦替你拾起的光影时刻）
//   /graph   星图（记忆/人际图谱——小亦收集的记忆星系）
// 设置不入导航区：桌面为右侧齿轮按钮、移动为顶栏齿轮（与本文件移动 header 一致）。
const navItems = [
  { to: '/', label: '星语' },
  { to: '/desktop', label: '星伴' },
  { to: '/gallery', label: '拾光' },
  { to: '/graph', label: '星图' },
];

// 通用小图标按钮样式（齿轮/退出）
const iconBtnCls =
  'w-9 h-9 rounded-full flex items-center justify-center text-stardust-400 hover:text-blush-200 hover:bg-white/10 active:scale-95 transition';

// 齿轮图标（设置入口，桌面顶栏右侧 + 移动顶栏共用）
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// 品牌标识（渐变字 + ✦ 星徽），桌面/移动顶栏复用
function Brand() {
  return (
    <span className="flex items-center gap-2 text-lg font-bold bg-gradient-to-r from-nebula-300 to-blush-300 bg-clip-text text-transparent whitespace-nowrap">
      <span className="w-7 h-7 rounded-full bg-gradient-to-br from-nebula-500 to-blush-400 flex items-center justify-center text-sm text-white shadow-glow">
        ✦
      </span>
      XIAOYI 小亦
    </span>
  );
}

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <>
      {/* 桌面顶栏（md+）：品牌 + 4 导航胶囊 + 昵称/设置齿轮/退出 */}
      <nav className="hidden md:flex shrink-0 px-4 h-14 items-center justify-between border-b border-white/10 bg-night-900/60 backdrop-blur-xl">
        <div className="flex items-center gap-6 min-w-0">
          <Brand />
          <div className="flex items-center gap-1 overflow-x-auto">
            {navItems.map((item) => {
              const active = location.pathname === item.to;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`px-3.5 py-1.5 rounded-full text-sm whitespace-nowrap transition ${
                    active
                      ? 'bg-white/[0.12] text-blush-200 shadow-inner-glow'
                      : 'text-stardust-500 hover:text-stardust-100 hover:bg-white/[0.08]'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-sm text-stardust-500">{user?.nickname || `用户${user?.phone}`}</span>
          <Link to="/settings" aria-label="设置" className={iconBtnCls}>
            <GearIcon />
          </Link>
          <button onClick={handleLogout} aria-label="退出" className={iconBtnCls}>
            {/* 电源/退出 */}
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </nav>

      {/* 移动顶栏（<md）：品牌 + 设置/退出图标（4 主入口已沉底到 MobileTabBar） */}
      <header className="md:hidden shrink-0 h-14 px-4 flex items-center justify-between border-b border-white/10 bg-night-900/60 backdrop-blur-xl">
        <Brand />
        <div className="flex items-center gap-1 shrink-0">
          <Link to="/settings" aria-label="设置" className={iconBtnCls}>
            <GearIcon />
          </Link>
          <button onClick={handleLogout} aria-label="退出" className={iconBtnCls}>
            {/* 电源/退出 */}
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </header>
    </>
  );
}

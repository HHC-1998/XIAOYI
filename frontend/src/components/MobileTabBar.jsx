import { Link, useLocation } from 'react-router-dom';

// 移动端底部导航（<md，md+ 由 App.jsx 隐藏）：4 主入口沉底，星象名（2026-09-03）。
// 设置 / 退出不放这里——它们在移动顶栏（Navbar.jsx 的 header）。
// /graph 用星形图标：关系网 = 小亦收集的记忆星系"星图"。
const tabs = [
  {
    to: '/',
    label: '星语',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    ),
  },
  {
    to: '/desktop',
    label: '星伴',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    to: '/gallery',
    label: '拾光',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    ),
  },
  {
    to: '/graph',
    label: '星图',
    icon: (
      /* 四角星 sparkle：记忆星系 */
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l1.9 5.6a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z" />
      </svg>
    ),
  },
];

export default function MobileTabBar() {
  const { pathname } = useLocation();

  return (
    <nav className="md:hidden shrink-0 border-t border-white/10 bg-night-900/70 backdrop-blur-xl px-2 pt-1 pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-stretch">
        {tabs.map((tab) => {
          const active = pathname === tab.to;
          return (
            <Link
              key={tab.to}
              to={tab.to}
              className={`flex-1 flex flex-col items-center gap-1 py-1.5 rounded-xl transition ${
                active
                  ? 'text-blush-200 bg-white/[0.08] shadow-inner-glow'
                  : 'text-stardust-500 hover:text-stardust-200 active:scale-95'
              }`}
            >
              <span className="w-5 h-5">{tab.icon}</span>
              <span className="text-[10px] leading-none">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

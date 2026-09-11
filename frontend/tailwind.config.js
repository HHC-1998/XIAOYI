/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // 夜空底色系（从深空到星雾，页面背景主用 night-950/900/800）
        night: {
          950: '#070a1f',
          900: '#0c1233',
          800: '#131b4a',
          700: '#1c2766',
          600: '#2a3886',
        },
        // 星紫（主强调色，替代原 indigo/violet）
        nebula: {
          200: '#d6ccff',
          300: '#b9a9ff',
          400: '#9d8aff',
          500: '#7c6cff',
          600: '#6552f0',
          700: '#503fd0',
        },
        // 粉彩（甜系点缀：高亮/爱心/重要操作）
        blush: {
          100: '#ffe3ef',
          200: '#ffc2dd',
          300: '#ffa0c8',
          400: '#ff7fb4',
          500: '#f76fa6',
        },
        // 星尘文字（浅色层级）
        stardust: {
          100: '#f3f1ff',
          300: '#cfcaf0',
          500: '#8f87c9',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04)',
        lift: '0 8px 24px rgba(124, 108, 255, 0.35), 0 2px 6px rgba(0, 0, 0, 0.4)',
        glow: '0 0 18px rgba(124, 108, 255, 0.35)',
        'glow-pink': '0 0 18px rgba(255, 127, 180, 0.4)',
        'inner-glow': 'inset 0 1px 0 rgba(255,255,255,0.12)',
      },
      borderRadius: {
        xl: '0.9rem',
        '2xl': '1.2rem',
        '3xl': '1.6rem',
        bubble: '1.4rem',
      },
      keyframes: {
        // 星星闪烁（打字机"思考中"三点 / 背景点缀）
        twinkle: {
          '0%, 100%': { opacity: '0.25', transform: 'scale(0.85)' },
          '50%': { opacity: '1', transform: 'scale(1)' },
        },
        // Q 版形象轻柔上下浮动
        floaty: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
        // 呼吸（灯泡式提示点/状态点）
        breathe: {
          '0%, 100%': { opacity: '0.55' },
          '50%': { opacity: '1' },
        },
        // 新消息进场：轻微上浮淡入
        popIn: {
          '0%': { opacity: '0', transform: 'translateY(6px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        twinkle: 'twinkle 1.6s ease-in-out infinite',
        'twinkle-slow': 'twinkle 2.6s ease-in-out infinite',
        floaty: 'floaty 3.4s ease-in-out infinite',
        breathe: 'breathe 2.4s ease-in-out infinite',
        'pop-in': 'popIn 0.28s ease-out both',
      },
    },
  },
  plugins: [],
};

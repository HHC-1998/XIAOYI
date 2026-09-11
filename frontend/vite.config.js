import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // SSE 流式接口同样走代理（http-proxy 默认支持）
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        // WebSocket 升级（2026-09-03 流式 ASR /asr-stream，04 §8 / 台账 38 节）：
        // 本地开发经 vite 访问桌面助手时，缺 ws:true 会让 WS 握手 502
        ws: true,
      },
    },
  },
});

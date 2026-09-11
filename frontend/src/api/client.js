import axios from 'axios';

const TOKEN_KEY = 'token';

// baseURL 留空：所有接口用 /api/... 全路径，走同源代理
// （生产：nginx 代理 /api → backend；开发：vite server.proxy 代理 /api → localhost:8000）
export const api = axios.create({
  baseURL: '',
  timeout: 60000,
});

// 请求拦截器：自动附加 token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 响应拦截器：401 统一处理
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

// 供 fetch 流式请求（SSE）使用的 token 读取辅助函数
export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

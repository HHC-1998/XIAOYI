import { api } from './client';

// 登录统一走 POST /api/auth/login，按 body 区分验证码/密码（与 CLI 共用同一接口）：
//   { phone, code }      → 验证码登录
//   { phone, password }  → 密码登录
export const authApi = {
  // 发送验证码（mock 阶段后端返回 code 供前端自动填入，见 05 注册时序图）
  sendCode(phone) {
    return api.post('/api/auth/send_code', { phone }).then((r) => r.data);
  },

  // 统一登录接口，按 body 区分验证码/密码
  login(payload) {
    return api.post('/api/auth/login', payload).then((r) => r.data);
  },

  // 注册（密码必填，成功后返回 token 即登录态）
  register(payload) {
    return api.post('/api/auth/register', payload).then((r) => r.data);
  },

  // 当前用户
  me() {
    return api.get('/api/auth/me').then((r) => r.data);
  },
};

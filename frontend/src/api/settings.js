import { api } from './client';

export const settingsApi = {
  getModels: () => api.get('/api/settings/models').then((r) => r.data),
  addModel: (model) => api.post('/api/settings/models', model).then((r) => r.data),
  testModel: (id) => api.post(`/api/settings/models/${id}/test`).then((r) => r.data),
  updateModel: (id, model) => api.put(`/api/settings/models/${id}`, model).then((r) => r.data),
  deleteModel: (id) => api.delete(`/api/settings/models/${id}`).then((r) => r.data),
  getFunctionModels: () => api.get('/api/settings/function-models').then((r) => r.data),
  assignFunctionModel: (func, modelId) =>
    api.put('/api/settings/function-models', { func, model_id: modelId }).then((r) => r.data),
  // 清空数据：密码放 JSON body（接口见 09_数据管理详解.md）
  clearData: (type, password) =>
    api.post('/api/data/clear', { type, password }).then((r) => r.data),
  // 为当前账号补录手机号 + 密码
  bindPhone: ({ phone, code, password }) =>
    api.post('/api/settings/bind-phone', { phone, code, password }).then((r) => r.data),
  // 修改密码（需手机号 + 验证码确认）
  changePassword: ({ phone, code, newPassword }) =>
    api.post('/api/settings/change-password', { phone, code, new_password: newPassword }).then((r) => r.data),
};

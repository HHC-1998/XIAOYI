import { api } from './client';

export const memoryApi = {
  getGraph: () => api.get('/api/memory/graph').then((r) => r.data),
  // 删除节点：密码放 JSON body，不进 URL query（避免进访问日志）
  deleteNode: (nodeId, password) =>
    api.delete(`/api/memory/graph/node/${nodeId}`, { data: { password } }).then((r) => r.data),
};

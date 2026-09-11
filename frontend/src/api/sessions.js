import { api } from './client';

export const sessionsApi = {
  list: (params) => api.get('/api/sessions', { params }).then((r) => r.data),
  create: (source = 'web') =>
    api.post('/api/sessions', { source }).then((r) => r.data),
  get: (id) => api.get(`/api/sessions/${id}`).then((r) => r.data),
  remove: (id) => api.delete(`/api/sessions/${id}`).then((r) => r.data),
};

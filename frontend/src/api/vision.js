import { getToken } from './client';

// 视觉功能 API（12 §8.4）：照片上传/列表/下载/收藏 + 视觉模式开关

// 视觉模式开关（12 §5 隐私保护）：关闭时前端不得打开摄像头/轮询拍照
export function getVisionStatus() {
  return fetch('/api/vision/status', {
    headers: { Authorization: `Bearer ${getToken()}` },
  }).then((res) => {
    if (!res.ok) throw new Error(`vision status failed: ${res.status}`);
    return res.json();
  });
}

export function setVisionStatus(enabled) {
  return fetch('/api/vision/status', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify({ enabled }),
  }).then((res) => {
    if (!res.ok) throw new Error(`vision status put failed: ${res.status}`);
    return res.json();
  });
}

// 上传照片：source = poll（轮询）/ trigger（语音触发）/ upload（网页上传）
// analyze=1 时后端调用视觉模型描述并存入照片库；poll 且命中主动搭话时返回 proactive_reply
export function uploadPhoto({ blob, source = 'poll', analyze = 1 }) {
  const fd = new FormData();
  fd.append('source', source);
  fd.append('analyze', String(analyze));
  fd.append('file', blob, `vision_${Date.now()}.jpg`);
  return fetch('/api/vision/photo', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: fd,
  }).then((res) => {
    if (!res.ok) throw new Error(`vision photo failed: ${res.status}`);
    return res.json();
  });
}

// 分页列照片（gallery 用）
export function listPhotos({ page = 1, pageSize = 60 } = {}) {
  const qs = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  return fetch(`/api/vision/photos?${qs}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  }).then((res) => {
    if (!res.ok) throw new Error(`vision photos failed: ${res.status}`);
    return res.json();
  });
}

// 收藏 / 取消收藏
export function setFavorite(photoId, favorite) {
  return fetch(`/api/vision/photos/${photoId}/favorite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify({ favorite }),
  }).then((res) => {
    if (!res.ok) throw new Error(`vision favorite failed: ${res.status}`);
    return res.json();
  });
}

// 下载原图：直接触发浏览器下载
export function downloadPhoto(photoId) {
  const url = `/api/vision/photos/${photoId}/download`;
  return fetch(url, {
    headers: { Authorization: `Bearer ${getToken()}` },
  })
    .then((res) => {
      if (!res.ok) throw new Error(`vision download failed: ${res.status}`);
      return res.blob();
    })
    .then((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `photo_${photoId}.jpg`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
}

// 聚合导出（与 voiceApi 等惯例一致，供页面统一调用）
export const visionApi = {
  getVisionStatus,
  setVisionStatus,
  uploadPhoto,
  listPhotos,
  setFavorite,
  downloadPhoto,
};

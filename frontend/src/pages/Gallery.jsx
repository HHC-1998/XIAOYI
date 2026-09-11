import { useEffect, useState } from 'react';
import { listPhotos, setFavorite, downloadPhoto } from '../api/vision';

// 每日精彩（12 §7）：照片墙展示视觉模式拍下的照片，可预览/下载/收藏。
// 照片为环形缓冲（上限 1000 张）：未收藏的照片被新照片顶掉后无法找回。
export default function Gallery() {
  const [photos, setPhotos] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(60);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);   // 大图预览的照片对象
  const [togglingId, setTogglingId] = useState(null);

  const load = async (p) => {
    setLoading(true);
    setError('');
    try {
      const res = await listPhotos({ page: p, pageSize });
      setPhotos(res.photos || []);
      setTotal(res.total || 0);
    } catch (e) {
      setError('加载照片失败，请确认后端已启动');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFav = async (photo, ev) => {
    ev.stopPropagation();
    setTogglingId(photo.id);
    try {
      const res = await setFavorite(photo.id, !photo.is_favorite);
      setPhotos((prev) => prev.map((p) => (p.id === photo.id ? { ...p, is_favorite: res.is_favorite } : p)));
    } catch (e) {
      alert(e?.response?.data?.detail || '收藏操作失败');
    } finally {
      setTogglingId(null);
    }
  };

  const handlePreview = (photo) => {
    if (photo.is_private) {
      // 隐私照片仅显示描述（12 §4：不展示含隐私内容的缩略图本体），可下载但默认不主动展示
      setPreview(photo);
      return;
    }
    setPreview(photo);
  };

  const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-6xl mx-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-stardust-100">每日精彩</h1>
            <p className="text-sm text-stardust-500 mt-1">
              小亦"看见"的世界 · 共 {total} 张（环形存储，上限 1000 张，未收藏的照片会被新照片顶掉）
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 px-4 py-2 bg-blush-500/10 border border-blush-400/25 text-blush-300 text-sm rounded-2xl">
            {error}
          </div>
        )}

        {loading && photos.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-stardust-500">加载中...</div>
        ) : photos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-stardust-500 gap-2">
            <div className="w-16 h-16 rounded-full bg-white/[0.08] border border-white/[0.12] flex items-center justify-center text-3xl">📷</div>
            <p className="text-sm">还没有照片</p>
            <p className="text-xs text-stardust-500">在桌面助手页开启视觉模式，小亦会定时记录周围的世界</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {photos.map((p) => (
                <div
                  key={p.id}
                  onClick={() => handlePreview(p)}
                  className="group relative rounded-2xl overflow-hidden glass cursor-pointer hover:shadow-glow transition-shadow"
                >
                  <div className="aspect-square overflow-hidden bg-white/5">
                    {p.image && !p.is_private ? (
                      <img
                        src={p.image}
                        alt={p.description || '照片'}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-stardust-500 gap-1">
                        <span className="text-3xl">{p.is_private ? '🔒' : '🖼️'}</span>
                        <span className="text-xs">{p.is_private ? '隐私画面' : '图片不可用'}</span>
                      </div>
                    )}
                  </div>
                  <div className="p-2.5">
                    <p className="text-xs text-stardust-300 line-clamp-2 min-h-[2rem]">
                      {p.description || '（无描述）'}
                    </p>
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-[11px] text-stardust-500">{fmtTime(p.shot_at)}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-stardust-500 px-1.5 py-0.5 bg-white/[0.08] rounded-full">
                          {{ poll: '轮询', trigger: '触发', upload: '上传' }[p.source] || p.source}
                        </span>
                        <button
                          onClick={(ev) => toggleFav(p, ev)}
                          disabled={togglingId === p.id}
                          className={`text-sm ${p.is_favorite ? 'text-amber-400' : 'text-stardust-500 hover:text-amber-300'}`}
                          title={p.is_favorite ? '取消收藏' : '收藏（收藏不参与淘汰）'}
                        >
                          {p.is_favorite ? '★' : '☆'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* 分页 */}
            <div className="flex items-center justify-center gap-4 mt-6">
              <button
                onClick={() => { setPage(page - 1); load(page - 1); }}
                disabled={page <= 1}
                className="px-4 py-2 rounded-full border border-white/[0.15] bg-white/[0.08] text-sm text-stardust-300 hover:bg-white/[0.15] hover:text-blush-200 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                上一页
              </button>
              <span className="text-sm text-stardust-500">{page} / {totalPages}</span>
              <button
                onClick={() => { setPage(page + 1); load(page + 1); }}
                disabled={page >= totalPages}
                className="px-4 py-2 rounded-full border border-white/[0.15] bg-white/[0.08] text-sm text-stardust-300 hover:bg-white/[0.15] hover:text-blush-200 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                下一页
              </button>
            </div>
          </>
        )}
      </div>

      {/* 大图预览弹层 */}
      {preview && (
        <div
          className="fixed inset-0 z-50 bg-night-950/80 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => setPreview(null)}
        >
          <div
            className="glass-strong rounded-3xl max-w-2xl w-full overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-night-900/60 flex items-center justify-center max-h-[60vh] overflow-hidden">
              {preview.image && !preview.is_private ? (
                <img src={preview.image} alt={preview.description} className="w-full h-auto object-contain" />
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-stardust-500 gap-2">
                  <span className="text-5xl">{preview.is_private ? '🔒' : '🖼️'}</span>
                  <p className="text-sm">{preview.is_private ? '该画面含隐私内容，不展示原图' : '图片不可用'}</p>
                </div>
              )}
            </div>
            <div className="p-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-stardust-500">{fmtTime(preview.shot_at)} · 来源：{{ poll: '轮询', trigger: '触发', upload: '上传' }[preview.source] || preview.source}</span>
                <button
                  onClick={() => setPreview(null)}
                  className="text-stardust-500 hover:text-stardust-100 text-xl leading-none"
                >
                  ×
                </button>
              </div>
              <p className="text-sm text-stardust-300 mb-4">{preview.description || '（无描述）'}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => downloadPhoto(preview.id).catch((e) => alert('下载失败，请重试'))}
                  className="px-4 py-2 rounded-full bg-gradient-to-r from-nebula-500 to-blush-400 text-white text-sm shadow-glow hover:brightness-110 transition"
                >
                  下载原图
                </button>
                <button
                  onClick={(ev) => toggleFav(preview, ev)}
                  disabled={togglingId === preview.id}
                  className={`px-4 py-2 rounded-full border text-sm transition ${
                    preview.is_favorite
                      ? 'bg-amber-500/[0.15] border-amber-400/40 text-amber-300'
                      : 'border-white/[0.15] bg-white/[0.08] text-stardust-300 hover:border-amber-400/60 hover:text-amber-300'
                  }`}
                >
                  {preview.is_favorite ? '已收藏 ★' : '收藏 ☆'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

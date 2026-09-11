// 文本工具：TTS 前把 Markdown 还原为纯文本，避免语音念出 * # 等符号（04 §9 / 08 §2.4）。
// 与后端 voice.py 的 regex 兜底相互配合（双保险）。

export function stripMarkdown(text) {
  if (!text) return '';
  return text
    // 代码块 ```lang ... ```
    .replace(/```[\s\S]*?```/g, '')
    // 行内代码 `code`
    .replace(/`([^`]*)`/g, '$1')
    // 图片 ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 链接 [text](url) → text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 标题 # 到 ######
    .replace(/^#{1,6}\s*/gm, '')
    // 列表符号 - * + 与有序列表数字
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, '')
    // 引用块
    .replace(/^\s*>\s?/gm, '')
    // 加粗/斜体 ** ** __ __ * * _ _
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    // 删除线 ~~ ~~
    .replace(/~~(.*?)~~/g, '$1')
    // 表格分隔行 |---|
    .replace(/^\s*\|[\s\-:|]+\|\s*$/gm, '')
    // 表格单元格 → 逗号分隔
    .replace(/\|/g, '，')
    // HTML 标签残留
    .replace(/<[^>]+>/g, '')
    // 表情符号（emoji）及 ZWJ/变体选择符残留：语音只念纯文本（显示层不受影响）
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u200d\ufe0f]/g, '')
    // 省略号（…… / ... / 。。。 / ⋯）→ 空格：edge-tts 遇省略号会明显停顿，朗读层去除（文字显示保留）
    // 只匹配"省略号形态"，不误伤单句号/单点；与后端 voice.py 的规则保持一致（2026-09-03）
    .replace(/…+|\.{3,}|。{2,}|⋯+/g, ' ')
    // 折叠多余空白
    .replace(/\s+/g, ' ')
    .trim();
}

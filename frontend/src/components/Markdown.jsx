import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Markdown 美化渲染（05 §12）：react-markdown + remark-gfm，样式贴合全站星夜 Q 版风格。
// 聊天/桌面助手的最终回复统一经此渲染，避免用户看到原始 Markdown 语法符号。
export function Markdown({ children }) {
  const text = typeof children === 'string' ? children : '';
  if (!text.trim()) return null;
  return (
    <div className="text-sm leading-relaxed break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ node, ...props }) => <p {...props} className="my-1.5 first:mt-0 last:mb-0" />,
          a: ({ node, href, children, ...props }) => (
            <a {...props} href={href} className="text-nebula-300 hover:text-blush-200 hover:underline" target="_blank" rel="noreferrer" />
          ),
          h1: ({ node, ...props }) => <h1 {...props} className="text-lg font-bold mt-3 mb-2 text-stardust-100" />,
          h2: ({ node, ...props }) => <h2 {...props} className="text-base font-bold mt-3 mb-1.5 text-stardust-100" />,
          h3: ({ node, ...props }) => <h3 {...props} className="text-sm font-bold mt-2 mb-1 text-stardust-100" />,
          h4: ({ node, ...props }) => <h4 {...props} className="text-sm font-semibold mt-2 mb-1 text-stardust-100" />,
          ul: ({ node, ...props }) => <ul {...props} className="list-disc pl-5 my-2 space-y-1" />,
          ol: ({ node, ...props }) => <ol {...props} className="list-decimal pl-5 my-2 space-y-1" />,
          li: ({ node, ...props }) => <li {...props} className="leading-relaxed" />,
          blockquote: ({ node, ...props }) => (
            <blockquote
              {...props}
              className="border-l-4 border-blush-400/50 bg-white/[0.06] px-3 py-1 my-2 rounded-r-md text-stardust-300 italic"
            />
          ),
          hr: () => <hr className="my-3 border-white/[0.15]" />,
          strong: ({ node, ...props }) => <strong {...props} className="font-semibold text-stardust-100" />,
          em: ({ node, ...props }) => <em {...props} className="italic" />,
          code: ({ node, inline, className, children, ...props }) => {
            const isBlock = !inline;
            if (isBlock) {
              return (
                <code
                  {...props}
                  className="block bg-night-900/90 text-stardust-100 border border-white/10 rounded-xl px-3 py-2 my-2 text-xs font-mono overflow-x-auto"
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                {...props}
                className="px-1.5 py-0.5 rounded-md bg-white/[0.15] text-blush-200 text-[0.85em] font-mono"
              >
                {children}
              </code>
            );
          },
          pre: ({ node, ...props }) => <pre {...props} className="my-2" />,
          table: ({ node, ...props }) => (
            <div className="overflow-x-auto my-2">
              <table {...props} className="min-w-full border-collapse text-xs text-stardust-300" />
            </div>
          ),
          thead: ({ node, ...props }) => (
            <thead {...props} className="bg-white/10 text-stardust-100" />
          ),
          th: ({ node, ...props }) => (
            <th {...props} className="border border-white/[0.12] px-2 py-1.5 text-left font-semibold" />
          ),
          td: ({ node, ...props }) => (
            <td {...props} className="border border-white/[0.12] px-2 py-1.5" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

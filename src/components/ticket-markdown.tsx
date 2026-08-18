"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Linear assets need our auth header, so route them through the proxy. */
function proxied(src: string): string {
  if (src.startsWith("https://uploads.linear.app/")) {
    return `/api/linear-asset?url=${encodeURIComponent(src)}`;
  }
  return src;
}

/* Reading styles come from the "PR detail — opened" artboard: 15/25 body on a
   640px measure, 5px bullet dots, screenshots in a 12px-radius well. */
export function TicketMarkdown({ body }: { body: string }) {
  if (!body.trim()) {
    return (
      <p className="text-[15px] leading-[25px] text-text-faint">
        No description on the ticket - the title is all we have.
      </p>
    );
  }

  return (
    <div className="flex max-w-[640px] flex-col gap-[12px] text-[15px] leading-[25px] text-text-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="text-[15px] leading-[25px]">{children}</p>
          ),
          h1: ({ children }) => (
            <h3 className="pt-[6px] text-[16px] font-semibold leading-[22px] tracking-[-0.01em] text-text">
              {children}
            </h3>
          ),
          h2: ({ children }) => (
            <h3 className="pt-[6px] text-[16px] font-semibold leading-[22px] tracking-[-0.01em] text-text">
              {children}
            </h3>
          ),
          h3: ({ children }) => (
            <h4 className="pt-[4px] text-[15px] font-semibold leading-[21px] text-text">
              {children}
            </h4>
          ),
          ul: ({ children }) => (
            <ul className="flex flex-col gap-[8px] pt-[2px]">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="flex list-decimal flex-col gap-[8px] pl-[20px] pt-[2px] marker:text-text-faint">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="flex items-start gap-[11px] text-[15px] leading-[23px]">
              <span className="mt-[9px] h-[5px] w-[5px] shrink-0 rounded-full bg-text-faint" />
              <span className="min-w-0">{children}</span>
            </li>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-text">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ children }) => (
            <code className="rounded-md bg-control px-[6px] py-[2px] font-mono text-[13px] text-text">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-xl bg-surface-2 p-[16px] font-mono text-[13px] leading-[21px] text-text">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l border-rule-strong pl-[14px] text-text-faint">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-rule" />,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-accent transition hover:underline"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-rule bg-surface-2 px-[10px] py-[6px] text-left font-medium text-text">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-rule px-[10px] py-[6px]">{children}</td>
          ),
          img: ({ src, alt }) => {
            if (typeof src !== "string") return null;
            const url = proxied(src);
            return (
              <span className="flex flex-col gap-[8px] pt-[6px]">
                <a href={url} target="_blank" rel="noreferrer" className="block">
                  <img
                    src={url}
                    alt={alt ?? "Ticket attachment"}
                    loading="lazy"
                    className="max-h-[420px] w-auto max-w-[640px] rounded-xl bg-[#111017] object-contain"
                  />
                </a>
                <span className="text-[13px] leading-[20px] text-text-2">
                  {alt?.trim() ? alt : "Screenshot attached by the customer"}
                </span>
              </span>
            );
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

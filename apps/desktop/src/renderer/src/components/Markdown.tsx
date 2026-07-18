import { useMemo, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import markdown from "highlight.js/lib/languages/markdown";
import "highlight.js/styles/github-dark.css";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("powershell", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("markdown", markdown);

function highlightCode(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert bare paths to markdown links without breaking existing [text](url) links.
 */
function linkifyPaths(text: string): string {
  // Protect existing markdown links
  const placeholders: string[] = [];
  let protectedText = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (full) => {
    const i = placeholders.length;
    placeholders.push(full);
    return `\u0000MD${i}\u0000`;
  });

  // Bare paths / image refs
  const re =
    /((?:[A-Za-z]:\\|\\\\)[^\s`"'<>|\]]+|(?:\.\/)?(?:images?|attachments?)\/[^\s`"'<>|\]]+)/g;

  protectedText = protectedText.replace(re, (match) => {
    let path = match;
    let trailing = "";
    while (/[.,;:!?)]$/.test(path)) {
      trailing = path.slice(-1) + trailing;
      path = path.slice(0, -1);
    }
    if (!path) return match;
    return `[${path}](${path})${trailing}`;
  });

  return protectedText.replace(/\u0000MD(\d+)\u0000/g, (_, n) => placeholders[Number(n)] || "");
}

function looksLikePath(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (/^(?:\.\/)?(?:images?|attachments?)\//i.test(t)) return true;
  if (/\.(png|jpe?g|webp|gif|mp4|webm|pdf|md|ts|tsx|js|json|py|txt)$/i.test(t)) return true;
  return false;
}

export function Markdown({
  text,
  projectRoot,
  onStatus,
}: {
  text: string;
  projectRoot?: string | null;
  onStatus?: (msg: string) => void;
}) {
  const prepared = useMemo(() => linkifyPaths(text), [text]);

  const openLocal = async (href: string) => {
    let target = href.trim();
    try {
      target = decodeURIComponent(target);
    } catch {
      /* keep */
    }
    // Normalize markdown leftover
    const md = target.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (md) target = (md[2] || md[1] || target).trim();

    const res = await window.grokDeck.shell.openPath(target, projectRoot || undefined);
    if (res.ok) {
      onStatus?.(`열림: ${res.resolved || target}`);
    } else {
      onStatus?.(res.message || `열기 실패: ${target}`);
      console.warn("openPath failed", res);
    }
  };

  const components = useMemo(
    () => ({
      code({
        className,
        children,
        ...props
      }: React.HTMLAttributes<HTMLElement> & { className?: string }) {
        const match = /language-(\w+)/.exec(className || "");
        const code = String(children).replace(/\n$/, "");
        const isBlock = Boolean(match) || code.includes("\n");
        if (!isBlock) {
          const raw = code.trim();
          if (looksLikePath(raw)) {
            return (
              <button
                type="button"
                className="md-path-link md-inline-code"
                title="클릭 → 탐색기에서 열기"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void openLocal(raw);
                }}
              >
                {raw}
              </button>
            );
          }
          return (
            <code className="md-inline-code" {...props}>
              {children}
            </code>
          );
        }
        const lang = match?.[1] || "";
        const html = highlightCode(code, lang);
        return (
          <div className="md-code-block">
            <div className="md-code-head">
              <span>{lang || "code"}</span>
              <button
                type="button"
                className="md-copy"
                onClick={() => void navigator.clipboard.writeText(code)}
              >
                복사
              </button>
            </div>
            <pre>
              <code
                className={`hljs ${className || ""}`}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </pre>
          </div>
        );
      },
      a({ href, children }: { href?: string; children?: ReactNode }) {
        const handle = (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (!href) return;
          if (/^https?:\/\//i.test(href)) {
            void window.grokDeck.shell.openPath(href);
            return;
          }
          void openLocal(href);
        };
        const local = href ? !/^https?:\/\//i.test(href) && !/^mailto:/i.test(href) : false;
        return (
          <a
            href={href || "#"}
            className={local ? "md-path-link" : undefined}
            title={local ? `클릭 → 탐색기에서 열기 (${href})` : href}
            onClick={handle}
          >
            {children}
          </a>
        );
      },
    }),
    // openLocal closes over projectRoot/onStatus
    [projectRoot, onStatus],
  );

  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components as never}>
        {prepared}
      </ReactMarkdown>
    </div>
  );
}

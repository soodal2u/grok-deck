import { memo, useMemo, useRef, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { hrefToLocalPath, looksLikePath, prepareMarkdownPaths } from "../path-links";
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

const REMARK_PLUGINS = [remarkGfm];

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

export const Markdown = memo(function Markdown({
  text,
  projectRoot,
  onStatus,
}: {
  text: string;
  projectRoot?: string | null;
  onStatus?: (msg: string) => void;
}) {
  const prepared = useMemo(() => prepareMarkdownPaths(text), [text]);
  const projectRootRef = useRef(projectRoot);
  projectRootRef.current = projectRoot;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const components = useMemo(
    () => {
      const openLocal = async (href: string) => {
        const target = hrefToLocalPath(href);
        const res = await window.grokDeck.shell.openPath(
          target,
          projectRootRef.current || undefined,
        );
        if (res.ok) {
          onStatusRef.current?.(`열림: ${res.resolved || target}`);
        } else {
          onStatusRef.current?.(res.message || `열기 실패: ${target}`);
          console.warn("openPath failed", res);
        }
      };
      return {
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
        const localPath = local ? hrefToLocalPath(href || "") : "";
        return (
          <a
            href={href || "#"}
            className={local ? "md-path-link" : undefined}
            title={local ? `클릭 → 탐색기에서 열기 (${localPath || href})` : href}
            onClick={handle}
          >
            {children}
          </a>
        );
      },
      p({ children }: { children?: ReactNode }) {
        return <p className="md-p">{children}</p>;
      },
      li({ children }: { children?: ReactNode }) {
        return <li className="md-li">{children}</li>;
      },
    };
    },
    [],
  );

  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components as never}>
        {prepared}
      </ReactMarkdown>
    </div>
  );
});

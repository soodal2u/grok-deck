/**
 * Detect Windows/Unix/relative file paths in chat markdown and turn them into
 * clickable file:// links. Covers the messy forms Grok actually emits:
 *   C:\Users\name\Documents\프로젝트
 *   [C:\foo\bar](C:\foo\bar)
 *   `C:\foo\bar\file.exe`
 *   path split across a newline (`…\프로젝트` then `\release\app.exe`)
 */

const TRAIL_PUNCT = /[.,;:!?。、]+$/;
const MD_LINK_RE = /\[([^\]]*)\]\((<[^>]+>|[^)\s]+)\)/g;

export function looksLikePath(raw: string): boolean {
  const t = stripWrap(raw);
  if (!t || t.length > 1024) return false;
  if (/^(https?:\/\/|mailto:)/i.test(t)) return false;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (/^\\\\[^\\/\s]/.test(t)) return true;
  if (/^file:\/\//i.test(t)) return true;
  if (/^(?:\.\/)?(?:images?|attachments?|src|apps|packages|release|out|dist)[/\\]/i.test(t)) {
    return true;
  }
  if (
    /\.(png|jpe?g|webp|gif|mp4|webm|pdf|md|ts|tsx|js|jsx|json|py|txt|exe|dll|zip|html|css|svg|ico|yml|yaml|toml)$/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/** Close an unmatched opening ``` so leftover fences cannot swallow later text. */
export function closeOpenFences(text: string): string {
  if (!text) return text;
  const ticks = text.match(/^ {0,3}```/gm);
  if (!ticks || ticks.length % 2 === 0) return text;
  return `${text.replace(/\s*$/, "")}\n\`\`\`\n`;
}

export function prepareMarkdownPaths(text: string): string {
  if (!text) return text;
  let s = closeOpenFences(text);
  s = joinSplitWindowsPaths(s);
  s = mapOutsideFences(s, rewriteExistingPathLinks);
  s = mapOutsideFences(s, linkifyBarePaths);
  return s;
}

export function hrefToLocalPath(href: string): string {
  let t = stripWrap(href);
  try {
    t = decodeURIComponent(t);
  } catch {
    /* keep */
  }
  const md = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (md) t = stripWrap(md[2] || md[1] || t);
  if (/^file:\/\//i.test(t)) {
    t = t.replace(/^file:\/\/\/?/i, "");
    if (/^[A-Za-z]:/.test(t) === false && /^[A-Za-z]%3A/i.test(t) === false) {
      t = t.replace(/^\//, "");
    }
    try {
      t = decodeURIComponent(t);
    } catch {
      /* keep */
    }
    t = t.replace(/\//g, "\\");
  }
  return t;
}

function stripWrap(s: string): string {
  return (s || "")
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/^`+|`+$/g, "")
    .replace(TRAIL_PUNCT, "");
}

function mapOutsideFences(text: string, fn: (chunk: string) => string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((chunk) => (chunk.startsWith("```") ? chunk : fn(chunk)))
    .join("");
}

/**
 * Grok often wraps a folder path in a markdown link then puts the rest of the
 * path on the next line: `\release\VAL-STORE.exe`
 */
function joinSplitWindowsPaths(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let lastWin = "";
  for (const line of lines) {
    const found = line.match(/[A-Za-z]:[\\/][^\s`"'<>|*?\]]+/g);
    if (found?.length) {
      lastWin = stripPathTail(found[found.length - 1]!);
    }
    const frag = line.match(/^\s*(\\[^\s`"'<>|*?]+)\s*$/);
    if (frag && lastWin) {
      const combined = lastWin.replace(/[\\/]+$/, "") + frag[1];
      out.push(combined);
      lastWin = combined;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function rewriteExistingPathLinks(chunk: string): string {
  return chunk.replace(MD_LINK_RE, (full, label: string, href: string) => {
    const raw = stripWrap(href);
    if (/^(https?:\/\/|mailto:|file:)/i.test(raw)) return full;
    if (!looksLikePath(raw)) return full;
    const display = (label || raw).trim() || raw;
    return `[${escapeLinkText(display)}](<${toFileHref(raw)}>)`;
  });
}

function linkifyBarePaths(chunk: string): string {
  // Protect existing markdown links / inline code so we don't wrap twice
  const placeholders: string[] = [];
  const hold = (s: string) => {
    const i = placeholders.length;
    placeholders.push(s);
    return `\u0000P${i}\u0000`;
  };
  let next = chunk.replace(MD_LINK_RE, (full) => hold(full));
  next = next.replace(/`[^`]+`/g, (full) => hold(full));

  const re =
    /(?:[A-Za-z]:[\\/][^\s`"'<>|*?\]]+|\\\\[^\s`"'<>|*?\]]+|(?:\.\/)?(?:images?|attachments?|src|apps|packages|release)[/\\][^\s`"'<>|*?\]]+)/g;

  next = next.replace(re, (match) => {
    const path = stripPathTail(match);
    const trailing = match.slice(path.length);
    if (!path || !looksLikePath(path)) return match;
    return `[${escapeLinkText(path)}](<${toFileHref(path)}>)${trailing}`;
  });

  return next.replace(/\u0000P(\d+)\u0000/g, (_, n) => placeholders[Number(n)] || "");
}

function stripPathTail(p: string): string {
  let path = p;
  while (/[.,;:!?。)\]>'"]$/.test(path) && !/[A-Za-z]:[\\/]$/.test(path)) {
    path = path.slice(0, -1);
  }
  return path;
}

function escapeLinkText(s: string): string {
  return s.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function toFileHref(p: string): string {
  const cleaned = p.replace(/\\\\/g, "\\");
  const posix = cleaned.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(posix)) {
    return `file:///${encodeURI(posix)}`;
  }
  if (posix.startsWith("//")) {
    return `file:${encodeURI(posix)}`;
  }
  if (posix.startsWith("/")) {
    return `file://${encodeURI(posix)}`;
  }
  return encodeURI(posix);
}

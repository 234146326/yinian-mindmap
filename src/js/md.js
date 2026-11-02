/* 轻量 Markdown 渲染：先转义再解析，避免 XSS
 * 支持：# 标题、**粗体**、*斜体*、`代码`、[链接](url)、- 列表、1. 列表、
 * > 引用、--- 分隔线、```代码块```、换行。
 */

import { escapeHtml } from './util.js';

function safeUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return null;
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (/^#/.test(url)) return url;
  return null;
}

function inline(text) {
  let out = text;
  // 行内代码先占位，避免内部内容被其它规则处理
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const href = safeUrl(url);
    if (!href) return label;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|\W)\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)] || ''}</code>`);
  return out;
}

export function renderMarkdown(src) {
  const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';

  const lines = text.split('\n');
  const html = [];
  let i = 0;

  const flushParagraph = (buffer) => {
    if (!buffer.length) return;
    html.push(`<p>${buffer.map((l) => inline(l)).join('<br>')}</p>`);
    buffer.length = 0;
  };
  const para = [];

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^\s*```/.test(line)) {
      flushParagraph(para);
      const lang = line.replace(/^\s*```/, '').trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      html.push(
        `<pre class="md-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(
          buf.join('\n'),
        )}</code></pre>`,
      );
      continue;
    }

    if (!line.trim()) {
      flushParagraph(para);
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(para);
      const level = Math.min(6, heading[1].length + 1);
      html.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(\s*)([-*+])\s+/.test(line)) {
      flushParagraph(para);
      const items = [];
      while (i < lines.length && /^(\s*)([-*+])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^(\s*)([-*+])\s+/, ''));
        i += 1;
      }
      html.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^(\s*)\d+[.)]\s+/.test(line)) {
      flushParagraph(para);
      const items = [];
      while (i < lines.length && /^(\s*)\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^(\s*)\d+[.)]\s+/, ''));
        i += 1;
      }
      html.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph(para);
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote>${buf.map((l) => inline(l)).join('<br>')}</blockquote>`);
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushParagraph(para);
      html.push('<hr>');
      i += 1;
      continue;
    }

    para.push(line);
    i += 1;
  }
  flushParagraph(para);
  return html.join('\n');
}

/** 纯文本摘要：用于搜索结果、节点预览 */
export function plainSummary(src, max = 90) {
  const text = String(src || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

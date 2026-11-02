/* 把导图渲染为自包含的 SVG：用于预览、导出与分享。
 * 只做展示，不参与数据回写（数据交换始终以 JSON 为准）。
 */

import { layoutTree, edgePath } from './layout.js';
import { visibleChildren } from './model.js';

const PAD = 40;

const THEMES = {
  light: {
    bg: '#FBFAF7',
    card: '#FFFFFF',
    rootCard: '#F1F4FB',
    border: '#E2DED4',
    text: '#211F1B',
    sub: '#6C675D',
    edge: '#C7C1B4',
    accent: '#2E5AAC',
  },
  dark: {
    bg: '#16181C',
    card: '#20242B',
    rootCard: '#26303F',
    border: '#333A45',
    text: '#ECEBE7',
    sub: '#9AA1AC',
    edge: '#3D4450',
    accent: '#7CA6F0',
  },
};

function charWidth(ch) {
  return /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.56;
}

function textWidth(text, size) {
  let units = 0;
  for (const ch of String(text || '')) units += charWidth(ch);
  return units * size;
}

function wrap(text, size, maxWidth, maxLines = 3) {
  const chars = [...String(text || '')];
  const lines = [];
  let line = '';
  let width = 0;
  for (const ch of chars) {
    const w = charWidth(ch) * size;
    if (width + w > maxWidth && line) {
      lines.push(line);
      if (lines.length === maxLines) break;
      line = '';
      width = 0;
    }
    line += ch;
    width += w;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) {
    const consumed = lines.join('').length;
    if (consumed < chars.length) {
      lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, -1)}…`;
    }
  }
  return lines;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function measure(node, depth) {
  const size = depth === 0 ? 16 : 14;
  const maxText = depth === 0 ? 240 : 200;
  const w = Math.round(Math.min(depth === 0 ? 300 : 260, Math.max(132, textWidth(node.title, size) + 34)));
  const lines = wrap(node.title, size, Math.min(maxText, w - 28), 2).length || 1;
  const h = Math.round((depth === 0 ? 22 : 18) + lines * (size + 8));
  return { w, h };
}

/**
 * @param {object} root 节点（可以是子树根）
 * @param {{dark?:boolean, title?:string, showBadges?:boolean}} opts
 */
export function buildSvg(root, opts = {}) {
  const theme = opts.dark ? THEMES.dark : THEMES.light;
  const layout = layoutTree(root, { measure });
  const { boxes, bounds } = layout;
  if (!boxes.length) {
    return { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', width: 10, height: 10 };
  }
  const offsetX = PAD - bounds.minX;
  const offsetY = PAD - bounds.minY;
  const width = Math.ceil(bounds.width + PAD * 2);
  const height = Math.ceil(bounds.height + PAD * 2);

  const edges = [];
  for (const box of boxes) {
    for (const child of visibleChildren(box.node)) {
      const cb = layout.byId.get(child.id);
      if (!cb) continue;
      const d = edgePath(
        { x: box.x + offsetX, y: box.y + offsetY, w: box.w, h: box.h },
        { x: cb.x + offsetX, y: cb.y + offsetY, w: cb.w, h: cb.h },
      );
      edges.push(`<path d="${d}" fill="none" stroke="${theme.edge}" stroke-width="1.6" stroke-linecap="round"/>`);
    }
  }

  const nodes = boxes.map((box) => {
    const node = box.node;
    const x = box.x + offsetX;
    const y = box.y + offsetY;
    const size = box.depth === 0 ? 16 : 14;
    const fill = box.depth === 0 ? theme.rootCard : theme.card;
    const stroke = node.color || theme.border;
    const lines = wrap(node.title, size, box.w - 28, 2);
    const totalText = lines.length * (size + 8);
    let ty = y + box.h / 2 - totalText / 2 + size;
    const tspans = lines
      .map((line) => {
        const t = `<tspan x="${x + 16}" y="${Math.round(ty)}">${escapeXml(line)}</tspan>`;
        ty += size + 8;
        return t;
      })
      .join('');
    const accentBar = node.color
      ? `<rect x="${x}" y="${y}" width="4" height="${box.h}" rx="2" fill="${node.color}"/>`
      : '';
    const hidden =
      node.collapsed && node.children.length
        ? `<text x="${x + box.w - 10}" y="${y + box.h - 9}" text-anchor="end" font-size="11" fill="${theme.sub}">+${node.children.length}</text>`
        : '';
    return `<g class="node" data-id="${escapeXml(node.id)}">
      <rect x="${x}" y="${y}" width="${box.w}" height="${box.h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>
      ${accentBar}
      <text font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif" font-size="${size}" font-weight="${box.depth === 0 ? 600 : 500}" fill="${theme.text}">${tspans}</text>
      ${hidden}
    </g>`;
  });

  const title = opts.title || root.title || '一念';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <title>${escapeXml(title)}</title>
  <rect width="${width}" height="${height}" fill="${theme.bg}"/>
  <g class="edges">${edges.join('')}</g>
  <g class="nodes">${nodes.join('')}</g>
  <text x="${PAD}" y="${height - 14}" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif" font-size="11" fill="${theme.sub}">${escapeXml(title)} · 一念</text>
</svg>`;
  return { svg, width, height };
}

export function svgFileName(title) {
  const safe = String(title || '导图')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${safe || '导图'}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.svg`;
}

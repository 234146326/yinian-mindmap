/* 领域模型：节点是一棵可递归的树，导图 = 元信息 + 根节点 */

import { uid, nowISO, isPlainObject, clamp } from './util.js';

export const ATTACHMENT_KINDS = ['image', 'video', 'link', 'ref'];
export const NODE_COLOR_PALETTE = [
  null,
  '#3B6FD4',
  '#2E9E8F',
  '#D97706',
  '#D24B5A',
  '#7C5CD6',
  '#5B7083',
];

export const LIMITS = {
  maxDepth: 80,
  titleLength: 500,
  noteLength: 100000,
  attachments: 200,
  children: 500,
  tags: 40,
};

export function createAttachment(partial = {}) {
  const kind = ATTACHMENT_KINDS.includes(partial.kind) ? partial.kind : 'link';
  const att = {
    id: partial.id || uid('a'),
    kind,
    title: String(partial.title || '').slice(0, 300),
    url: typeof partial.url === 'string' ? partial.url : '',
    note: String(partial.note || '').slice(0, 2000),
  };
  if (partial.mediaId) {
    att.mediaId = String(partial.mediaId);
    att.mime = String(partial.mime || '');
    att.size = Number(partial.size) || 0;
    att.name = String(partial.name || att.title || '');
  }
  return att;
}

export function createNode(partial = {}) {
  const t = nowISO();
  return {
    id: partial.id || uid('n'),
    title: typeof partial.title === 'string' && partial.title.trim() ? partial.title : '新节点',
    note: typeof partial.note === 'string' ? partial.note : '',
    collapsed: !!partial.collapsed,
    color: partial.color || null,
    tags: Array.isArray(partial.tags) ? partial.tags.slice(0, LIMITS.tags) : [],
    attachments: Array.isArray(partial.attachments) ? partial.attachments.map(createAttachment) : [],
    // 规则与规则字段值：rule 只在节点自己设定模板时存在，未设定则沿祖先继承
    rule: partial.rule && partial.rule.template
      ? { template: String(partial.rule.template), ...(partial.rule.updatedAt ? { updatedAt: partial.rule.updatedAt } : {}) }
      : null,
    ruleInherited: partial.ruleInherited && partial.ruleInherited.template ? { ...partial.ruleInherited } : null,
    data: isPlainObject(partial.data) ? { ...partial.data } : {},
    children: [],
    createdAt: partial.createdAt || t,
    updatedAt: partial.updatedAt || t,
  };
}

export function createMap(title = '未命名导图') {
  const t = nowISO();
  const root = createNode({ title });
  return {
    id: uid('m'),
    title: title || '未命名导图',
    root,
    createdAt: t,
    updatedAt: t,
  };
}

/* ---------------- 遍历与查询 ---------------- */

export function walk(node, cb, parent = null, depth = 0) {
  if (!node) return;
  cb(node, parent, depth);
  const kids = node.children || [];
  for (let i = 0; i < kids.length; i += 1) walk(kids[i], cb, node, depth + 1);
}

export function locate(root, id) {
  if (!root || !id) return null;
  let found = null;
  const stack = [{ node: root, parent: null, depth: 0 }];
  while (stack.length) {
    const item = stack.pop();
    if (item.node.id === id) {
      const siblings = item.parent ? item.parent.children : [root];
      found = {
        node: item.node,
        parent: item.parent,
        depth: item.depth,
        index: siblings.indexOf(item.node),
      };
      break;
    }
    const kids = item.node.children || [];
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      stack.push({ node: kids[i], parent: item.node, depth: item.depth + 1 });
    }
  }
  return found;
}

export function pathTo(root, id) {
  const out = [];
  const dfs = (node, trail) => {
    if (!node) return false;
    const next = trail.concat(node);
    if (node.id === id) {
      out.push(...next);
      return true;
    }
    for (const child of node.children || []) {
      if (dfs(child, next)) return true;
    }
    return false;
  };
  dfs(root, []);
  return out;
}

export function isDescendant(ancestor, id) {
  if (!ancestor) return false;
  let hit = false;
  walk(ancestor, (n) => {
    if (n.id === id && n !== ancestor) hit = true;
  });
  return hit;
}

/**
 * 按集数补齐子节点：只补差额，不重建已有结构。
 * 已有 20 个子节点、目标 30 → 只新增 10 个（第 21 集 … 第 30 集）。
 * 返回实际新增的节点数组（目标小于现有数量时返回空数组，绝不删除）。
 */
export function generateEpisodes(node, target) {
  if (!node) return [];
  const want = Math.max(0, Math.floor(Number(target) || 0));
  const have = (node.children || []).length;
  const added = [];
  for (let i = have; i < want; i += 1) {
    const child = createNode({ title: `第 ${i + 1} 集` });
    addNode(node, child);
    added.push(child);
  }
  return added;
}

export function countNodes(root) {
  let n = 0;
  walk(root, () => {
    n += 1;
  });
  return n;
}

export function maxDepth(root) {
  let d = 0;
  walk(root, (_n, _p, depth) => {
    if (depth > d) d = depth;
  });
  return d;
}

export function visibleChildren(node) {
  if (!node || node.collapsed) return [];
  return node.children || [];
}

export function flattenVisible(root) {
  const out = [];
  const step = (node, parent, depth) => {
    out.push({ node, parent, depth });
    visibleChildren(node).forEach((c) => step(c, node, depth + 1));
  };
  if (root) step(root, null, 0);
  return out;
}

/* ---------------- 结构修改 ---------------- */

export function addNode(parent, node, index = -1) {
  if (!parent) throw new Error('缺少父节点');
  if ((parent.children || []).length >= LIMITS.children) throw new Error('子节点数量已达上限');
  parent.children = parent.children || [];
  const list = parent.children;
  const at = index < 0 || index > list.length ? list.length : index;
  list.splice(at, 0, node);
  parent.collapsed = false;
  touch(parent);
  return node;
}

export function removeNode(root, id) {
  const hit = locate(root, id);
  if (!hit) return null;
  if (!hit.parent) return null; // 不允许删除根节点
  hit.parent.children.splice(hit.index, 1);
  touch(hit.parent);
  return hit.node;
}

export function moveNode(root, id, targetParentId, index = -1) {
  if (!root || id === root.id) return { ok: false, reason: '根节点不能移动' };
  const hit = locate(root, id);
  if (!hit) return { ok: false, reason: '节点不存在' };
  const target = locate(root, targetParentId);
  if (!target) return { ok: false, reason: '目标节点不存在' };
  if (targetParentId === id) return { ok: false, reason: '不能移到自身之下' };
  if (isDescendant(hit.node, targetParentId)) return { ok: false, reason: '不能移到自己的子孙节点之下' };

  const oldParent = hit.parent;
  const oldIndex = hit.index;
  hit.parent.children.splice(oldIndex, 1);

  let at = index < 0 ? target.node.children.length : index;
  // 同一父节点内向后移动时需要修正索引
  if (oldParent === target.node && at > oldIndex) at -= 1;
  target.node.children.splice(clamp(at, 0, target.node.children.length), 0, hit.node);
  target.node.collapsed = false;
  touch(oldParent);
  touch(target.node);
  return { ok: true, node: hit.node, from: { parentId: oldParent.id, index: oldIndex } };
}

export function duplicateSubtree(root, id) {
  const hit = locate(root, id);
  if (!hit) return null;
  const copy = cloneSubtree(hit.node);
  addNode(hit.parent, copy, hit.index + 1);
  return copy;
}

export function cloneSubtree(node) {
  const copy = (n) => {
    const out = {
      id: uid('n'),
      title: n.title,
      note: n.note || '',
      collapsed: !!n.collapsed,
      color: n.color || null,
      tags: Array.isArray(n.tags) ? n.tags.slice() : [],
      attachments: (n.attachments || []).map((a) => createAttachment({ ...a, id: uid('a') })),
      children: (n.children || []).map(copy),
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    return out;
  };
  return copy(node);
}

export function touch(node) {
  if (node) node.updatedAt = nowISO();
}

/* ---------------- 文本与检索 ---------------- */

export function nodeSearchText(node) {
  const parts = [node.title, node.note];
  for (const a of node.attachments || []) parts.push(a.title, a.note, a.url);
  for (const t of node.tags || []) parts.push(t);
  return parts.filter(Boolean).join('\n');
}

export function findMatches(root, query, limit = 80) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const results = [];
  walk(root, (node, parent, depth) => {
    if (results.length >= limit) return;
    const title = String(node.title || '').toLowerCase();
    const body = nodeSearchText(node).toLowerCase();
    let score = 0;
    if (title === q) score = 100;
    else if (title.startsWith(q)) score = 80;
    else if (title.includes(q)) score = 60;
    else if (body.includes(q)) score = 30;
    if (score > 0) results.push({ node, parent, depth, score, inBody: !title.includes(q) });
  });
  return results.sort((a, b) => b.score - a.score);
}

export function outlineText(root, depth = 0) {
  const lines = [];
  const step = (node, d) => {
    lines.push(`${'  '.repeat(d)}- ${node.title}${node.note ? `（${node.note.replace(/\s+/g, ' ').slice(0, 40)}）` : ''}`);
    (node.children || []).forEach((c) => step(c, d + 1));
  };
  step(root, depth);
  return lines.join('\n');
}

export function stats(root) {
  let nodes = 0;
  let attachments = 0;
  let notes = 0;
  walk(root, (n) => {
    nodes += 1;
    attachments += (n.attachments || []).length;
    if (n.note && n.note.trim()) notes += 1;
  });
  return { nodes, attachments, notes, depth: maxDepth(root) };
}

/* ---------------- 校验与修复 ---------------- */

const TITLE_KEYS = ['title', 'text', 'name', 'label', 'topic'];
const NOTE_KEYS = ['note', 'notes', 'content', 'description', 'detail', 'remark'];
const CHILD_KEYS = ['children', 'kids', 'nodes', 'subtopics', 'items'];
const ATTACH_KEYS = ['attachments', 'media', 'links', 'resources', 'files'];
const TAG_KEYS = ['tags', 'categories', 'labels'];

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null) return obj[k];
  }
  return undefined;
}

function asString(v, limit) {
  if (v == null) return '';
  if (typeof v === 'string') return limit ? v.slice(0, limit) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isPlainObject(v) && typeof v.text === 'string') return asString(v.text, limit);
  return '';
}

function inferKind(raw) {
  const explicit = String(raw.kind || raw.type || '').toLowerCase();
  if (ATTACHMENT_KINDS.includes(explicit)) return explicit;
  const mime = String(raw.mime || '');
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (explicit.includes('image') || explicit.includes('photo')) return 'image';
  if (explicit.includes('video')) return 'video';
  if (explicit.includes('ref') || explicit.includes('paper') || explicit.includes('doc')) return 'ref';
  const url = String(raw.url || raw.href || '');
  if (/\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(url)) return 'image';
  if (/\.(mp4|webm|ogg|mov|m4v)(\?|$)/i.test(url)) return 'video';
  return 'link';
}

function normalizeAttachment(raw, issues, path) {
  if (!isPlainObject(raw)) {
    issues.push(`${path}: 附件不是对象，已忽略`);
    return null;
  }
  const kind = inferKind(raw);
  const url = asString(raw.url || raw.href || raw.src || '', 4000).trim();
  const mediaId = asString(raw.mediaId || raw.media, 200).trim();
  if (!url && !mediaId && kind !== 'ref') {
    issues.push(`${path}: 附件缺少地址，已忽略`);
    return null;
  }
  const att = createAttachment({
    id: uid('a'),
    kind,
    title: asString(raw.title || raw.name || raw.label, 300),
    url: url.startsWith('data:') ? '' : url,
    note: asString(raw.note || raw.description, 2000),
    mediaId: mediaId || undefined,
    mime: asString(raw.mime, 120),
    size: Number(raw.size) || 0,
    name: asString(raw.name || raw.filename, 300),
  });
  if (att.kind !== 'image' && att.kind !== 'video' && !att.url) {
    issues.push(`${path}: 链接类型附件缺少 URL，已忽略`);
    return null;
  }
  return att;
}

/**
 * 把任意外部 JSON 中的节点对象规范化为内部节点。
 * 容错优先：识别常见字段别名，丢弃非法内容并记录 issue。
 */
export function normalizeNode(raw, opts = {}) {
  const {
    depth = 0,
    issues = [],
    path = 'root',
    regenIds = true,
    seen = new Set(),
  } = opts;

  if (depth > LIMITS.maxDepth) {
    issues.push(`${path}: 超过最大嵌套深度 ${LIMITS.maxDepth}，已截断`);
    return null;
  }
  let source = raw;
  if (Array.isArray(raw)) {
    source = { title: '导入的分组', children: raw };
  }
  if (!isPlainObject(source)) {
    issues.push(`${path}: 节点不是对象，已忽略`);
    return null;
  }

  const title = asString(pick(source, TITLE_KEYS), LIMITS.titleLength).trim();
  const note = asString(pick(source, NOTE_KEYS), LIMITS.noteLength);
  let id = asString(source.id, 120).trim();
  if (!id || regenIds || seen.has(id)) id = uid('n');
  seen.add(id);

  const node = {
    id,
    title: title || '未命名节点',
    note,
    collapsed: !!source.collapsed,
    color: typeof source.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(source.color) ? source.color : null,
    tags: [],
    attachments: [],
    rule: isPlainObject(source.rule) && source.rule.template ? { template: asString(source.rule.template, 60) } : null,
    ruleInherited:
      isPlainObject(source.ruleInherited) && source.ruleInherited.template
        ? {
            template: asString(source.ruleInherited.template, 60),
            from: source.ruleInherited.from ? asString(source.ruleInherited.from, 80) : null,
            fromTitle: source.ruleInherited.fromTitle ? asString(source.ruleInherited.fromTitle, 200) : null,
            at: typeof source.ruleInherited.at === 'string' ? source.ruleInherited.at : null,
            version: Number(source.ruleInherited.version) || 1,
          }
        : null,
    data: isPlainObject(source.data) ? { ...source.data } : {},
    children: [],
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : nowISO(),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : nowISO(),
  };

  const rawTags = pick(source, TAG_KEYS);
  if (Array.isArray(rawTags)) {
    node.tags = rawTags
      .map((t) => asString(t, 40).trim())
      .filter(Boolean)
      .slice(0, LIMITS.tags);
  }

  const rawAtts = pick(source, ATTACH_KEYS);
  if (Array.isArray(rawAtts)) {
    node.attachments = rawAtts
      .slice(0, LIMITS.attachments)
      .map((a, i) => normalizeAttachment(a, issues, `${path}.attachments[${i}]`))
      .filter(Boolean);
  }

  const rawKids = pick(source, CHILD_KEYS);
  if (Array.isArray(rawKids)) {
    for (let i = 0; i < rawKids.length && i < LIMITS.children; i += 1) {
      const child = normalizeNode(rawKids[i], {
        depth: depth + 1,
        issues,
        path: `${path}.children[${i}]`,
        regenIds,
        seen,
      });
      if (child) node.children.push(child);
    }
  }
  return node;
}

/* JSON 交换格式：节点子树 / 单张导图 / 全量备份
 * 统一信封，保证版本演进与媒体迁移的完整性。
 */

import { normalizeNode, countNodes, createAttachment } from './model.js';
import { nowISO, uid, isPlainObject } from './util.js';

export const APP_INFO = { name: '一念', slug: 'yinian', version: '1.0.0' };
export const SCHEMA_VERSION = 1;
export const FORMATS = {
  node: 'yinian.node',
  map: 'yinian.map',
  backup: 'yinian.backup',
};

function envelope(format, extra) {
  return {
    $schema: `https://yinian.app/schema/v${SCHEMA_VERSION}/${format.split('.')[1]}.json`,
    format,
    version: SCHEMA_VERSION,
    exportedAt: nowISO(),
    app: APP_INFO,
    ...extra,
  };
}

/** 递归内嵌 data 中的媒体（分镜图片等） */
function embedValue(value, mediaOut, resolveMedia) {
  if (Array.isArray(value)) return value.map((v) => embedValue(v, mediaOut, resolveMedia));
  if (!isPlainObject(value)) return value;
  const copy = {};
  for (const [k, v] of Object.entries(value)) copy[k] = embedValue(v, mediaOut, resolveMedia);
  if (typeof copy.mediaId === 'string' && copy.mediaId && resolveMedia) {
    const data = resolveMedia(copy.mediaId);
    if (data) {
      mediaOut[copy.mediaId] = {
        mime: copy.mime || data.mime || 'application/octet-stream',
        name: copy.name || data.name || '',
        size: copy.size || 0,
        dataUrl: data.dataUrl,
      };
    } else {
      copy.missingMedia = true;
    }
  }
  return copy;
}

function serializeNode(node, mediaOut, resolveMedia) {
  const out = {
    id: node.id,
    title: node.title,
    note: node.note || '',
    collapsed: !!node.collapsed,
    color: node.color || null,
    tags: (node.tags || []).slice(),
    rule: node.rule || null,
    ruleInherited: node.ruleInherited || null,
    data: embedValue(node.data || {}, mediaOut, resolveMedia),
    attachments: (node.attachments || []).map((a) => {
      const copy = { ...a };
      if (copy.mediaId && resolveMedia) {
        const data = resolveMedia(copy.mediaId);
        if (data) {
          mediaOut[copy.mediaId] = {
            mime: copy.mime || data.mime || 'application/octet-stream',
            name: copy.name || data.name || '',
            size: copy.size || 0,
            dataUrl: data.dataUrl,
          };
          delete copy.url;
        } else {
          // 媒体缺失：保留元信息但标注，导入侧会提示
          copy.missingMedia = true;
        }
      }
      return copy;
    }),
    children: (node.children || []).map((c) => serializeNode(c, mediaOut, resolveMedia)),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
  return out;
}

/**
 * @param {object} node
 * @param {{resolveMedia?:(id:string)=>{dataUrl:string,mime?:string,name?:string}|null}} opts
 */
export function buildNodeExport(node, opts = {}) {
  const media = {};
  const payload = envelope(FORMATS.node, {
    root: serializeNode(node, media, opts.resolveMedia),
  });
  if (Object.keys(media).length) {
    payload.media = media;
    payload.mediaMode = 'embedded';
  }
  return payload;
}

export function buildMapExport(map, opts = {}) {
  const media = {};
  const payload = envelope(FORMATS.map, {
    map: {
      id: map.id,
      title: map.title,
      root: serializeNode(map.root, media, opts.resolveMedia),
      createdAt: map.createdAt,
      updatedAt: map.updatedAt,
    },
  });
  if (Object.keys(media).length) {
    payload.media = media;
    payload.mediaMode = 'embedded';
  }
  return payload;
}

export function buildBackup(maps, opts = {}) {
  const media = {};
  const payload = envelope(FORMATS.backup, {
    workspace: {
      appName: APP_INFO.name,
      mapCount: maps.length,
      nodeCount: maps.reduce((s, m) => s + countNodes(m.root), 0),
    },
    maps: maps.map((m) => ({
      id: m.id,
      title: m.title,
      root: serializeNode(m.root, media, opts.resolveMedia),
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    })),
  });
  if (Object.keys(media).length) {
    payload.media = media;
    payload.mediaMode = 'embedded';
  }
  return payload;
}

export class ImportError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'ImportError';
    this.issues = issues;
  }
}

/**
 * 解析任意来源的 JSON 文本，返回规范化后的结果（尚未落库）。
 * kind: 'node' | 'map' | 'backup'
 */
export function parseImportText(text) {
  let data;
  try {
    data = JSON.parse(String(text || '').trim());
  } catch (err) {
    throw new ImportError(`JSON 解析失败：${err.message}`, []);
  }
  if (!data || (typeof data !== 'object' && !Array.isArray(data))) {
    throw new ImportError('JSON 内容不是有效的对象或数组', []);
  }
  return parseImportData(data);
}

export function parseImportData(data) {
  const issues = [];
  let kind = 'node';
  let rawNode = null;
  let rawMap = null;
  let rawMaps = null;
  const media = isPlainObject(data.media) ? data.media : {};

  if (isPlainObject(data) && typeof data.format === 'string') {
    if (data.format === FORMATS.map) kind = 'map';
    else if (data.format === FORMATS.backup) kind = 'backup';
    else kind = 'node';
    if (data.version && Number(data.version) > SCHEMA_VERSION) {
      issues.push(`文件版本 ${data.version} 高于当前应用支持的版本 ${SCHEMA_VERSION}，已尽力兼容导入`);
    }
  } else if (isPlainObject(data) && Array.isArray(data.maps)) {
    kind = 'backup';
  } else if (isPlainObject(data) && data.map && data.map.root) {
    kind = 'map';
  }

  if (kind === 'backup') {
    rawMaps = Array.isArray(data.maps) ? data.maps : [];
    if (!rawMaps.length) throw new ImportError('备份文件中没有导图数据', issues);
  } else if (kind === 'map') {
    rawMap = data.map || data;
    if (!rawMap.root) throw new ImportError('导图文件中缺少 root 节点', issues);
  } else {
    rawNode = data.root || data.node || data;
    if (!rawNode) throw new ImportError('文件中没有可导入的节点', issues);
  }

  if (kind === 'backup') {
    const maps = rawMaps.map((m, i) => {
      const root = normalizeNode(m.root || m, {
        regenIds: true,
        issues,
        path: `maps[${i}]`,
      });
      if (!root) return null;
      const title = String(m.title || root.title || `导入的导图 ${i + 1}`).slice(0, 120);
      return {
        id: uid('m'),
        title,
        root,
        createdAt: m.createdAt || nowISO(),
        updatedAt: nowISO(),
      };
    }).filter(Boolean);
    if (!maps.length) throw new ImportError('备份文件中的导图均无法解析', issues);
    return { kind, maps, media, issues, summary: summarizeBackup(maps, media) };
  }

  if (kind === 'map') {
    const root = normalizeNode(rawMap.root, { regenIds: true, issues, path: 'map.root' });
    if (!root) throw new ImportError('导图根节点无法解析', issues);
    return {
      kind,
      map: {
        id: uid('m'),
        title: String(rawMap.title || root.title || '导入的导图').slice(0, 120),
        root,
        createdAt: rawMap.createdAt || nowISO(),
        updatedAt: nowISO(),
      },
      media,
      issues,
      summary: summarizeBackup([{ root }], media),
    };
  }

  const root = normalizeNode(rawNode, { regenIds: true, issues, path: 'root' });
  if (!root) throw new ImportError('节点无法解析', issues);
  return {
    kind,
    node: root,
    media,
    issues,
    summary: {
      title: root.title,
      nodeCount: countNodes(root),
      mediaCount: collectMediaIds(root).filter((id) => media[id]).length,
      missingMedia: collectMediaIds(root).filter((id) => !media[id]).length,
    },
  };
}

function summarizeBackup(maps, media) {
  let nodeCount = 0;
  let mediaRefs = 0;
  for (const m of maps) {
    nodeCount += countNodes(m.root);
    mediaRefs += collectMediaIds(m.root).length;
  }
  const available = Object.keys(media).length;
  return {
    title: maps.length === 1 ? maps[0].title : `${maps.length} 张导图`,
    mapCount: maps.length,
    nodeCount,
    mediaCount: Math.min(mediaRefs, available),
    missingMedia: Math.max(0, mediaRefs - available),
  };
}

export function collectMediaIds(node) {
  const ids = [];
  const walkData = (value) => {
    if (Array.isArray(value)) return value.forEach(walkData);
    if (!isPlainObject(value)) return;
    if (typeof value.mediaId === 'string' && value.mediaId) ids.push(value.mediaId);
    Object.values(value).forEach(walkData);
  };
  const walkNode = (n) => {
    (n.attachments || []).forEach((a) => a.mediaId && ids.push(a.mediaId));
    walkData(n.data || {});
    (n.children || []).forEach(walkNode);
  };
  walkNode(node);
  return ids;
}

/**
 * 把信封内嵌的媒体写入存储，并把附件里的 mediaId 换成新的本地 id。
 * @param {object} root
 * @param {Record<string, {dataUrl:string, mime?:string, name?:string}>} media
 * @param {(blob:Blob, info:{name:string})=>Promise<{id:string,mime:string,name:string,size:number}>} putMedia
 */
export async function adoptImportedMedia(root, media, putMedia) {
  const cache = new Map();
  const missing = [];
  const nodes = [];
  const step = (n) => {
    nodes.push(n);
    (n.children || []).forEach(step);
  };
  step(root);

  for (const node of nodes) {
    for (const att of node.attachments) {
      if (!att.mediaId) continue;
      if (cache.has(att.mediaId)) {
        const rec = cache.get(att.mediaId);
        if (rec) {
          att.mediaId = rec.id;
          att.mime = rec.mime || att.mime;
          att.size = rec.size || att.size;
          att.name = rec.name || att.name;
        } else {
          delete att.mediaId;
        }
        continue;
      }
      const payload = media[att.mediaId];
      if (!payload || !payload.dataUrl) {
        cache.set(att.mediaId, null);
        missing.push(att.title || att.name || att.mediaId);
        delete att.mediaId;
        continue;
      }
      const blob = dataUrlToBlobSafe(payload.dataUrl);
      if (!blob) {
        cache.set(att.mediaId, null);
        missing.push(att.title || att.name || att.mediaId);
        delete att.mediaId;
        continue;
      }
      const rec = await putMedia(blob, { name: payload.name || att.name || '媒体文件' });
      cache.set(att.mediaId, rec);
      att.mediaId = rec.id;
      att.mime = rec.mime;
      att.size = rec.size;
      att.name = rec.name;
    }
  }
  return { missing, restored: [...cache.values()].filter(Boolean).length };
}

function dataUrlToBlobSafe(dataUrl) {
  try {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl));
    if (!m) return null;
    const mime = m[1] || 'application/octet-stream';
    if (!m[2]) return new Blob([decodeURIComponent(m[3])], { type: mime });
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

/** 导出文件名 */
export function exportFileName(kind, title) {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = String(title || '一念')
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || '一念';
  const suffix = kind === 'backup' ? '备份' : kind === 'map' ? '导图' : '节点';
  return `${base}-${suffix}-${stamp}.json`;
}

export { createAttachment };

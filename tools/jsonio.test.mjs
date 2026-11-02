import test from 'node:test';
import assert from 'node:assert/strict';

import { createMap, createNode, addNode, countNodes, findMatches, createAttachment, locate } from '../src/js/model.js';
import {
  buildNodeExport,
  buildMapExport,
  buildBackup,
  parseImportText,
  parseImportData,
  adoptImportedMedia,
  ImportError,
  FORMATS,
  exportFileName,
} from '../src/js/jsonio.js';

function sampleMap() {
  const map = createMap('知识地图');
  const root = map.root;
  const a = addNode(root, createNode({ title: '第一章', note: '# 标题\n内容 **加粗**' }));
  addNode(a, createNode({ title: '1.1', tags: ['重点'] }));
  a.attachments.push(
    createAttachment({ kind: 'image', title: '示意图', mediaId: 'md_demo', mime: 'image/png', size: 12, name: 'a.png' }),
    createAttachment({ kind: 'link', title: '参考文章', url: 'https://example.com/post' }),
  );
  addNode(root, createNode({ title: '第二章' }));
  return map;
}

const mediaResolver = () => ({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mime: 'image/png', name: 'a.png' });

test('导出节点：信封字段完整，媒体内嵌', () => {
  const map = sampleMap();
  const payload = buildNodeExport(map.root, { resolveMedia: mediaResolver });
  assert.equal(payload.format, FORMATS.node);
  assert.equal(payload.version, 1);
  assert.ok(payload.exportedAt);
  assert.equal(payload.root.title, '知识地图');
  assert.equal(payload.root.children.length, 2);
  assert.ok(payload.media.md_demo.dataUrl.startsWith('data:image/png'));
  assert.equal(payload.root.children[1].children.length, 0);
});

test('节点导出 → 导入：结构、内容、附件完整恢复，ID 全新', () => {
  const map = sampleMap();
  const payload = buildNodeExport(map.root, { resolveMedia: mediaResolver });
  const text = JSON.stringify(payload);
  const parsed = parseImportText(text);
  assert.equal(parsed.kind, 'node');
  assert.equal(parsed.node.title, '知识地图');
  assert.equal(countNodes(parsed.node), 4);
  assert.notEqual(parsed.node.id, map.root.id);
  const chapter = parsed.node.children[0];
  assert.equal(chapter.title, '第一章');
  assert.match(chapter.note, /标题/);
  assert.equal(chapter.tags.length, 0);
  assert.equal(parsed.node.children[0].children[0].tags[0], '重点');
  assert.equal(chapter.attachments.length, 2);
  assert.equal(chapter.attachments[0].kind, 'image');
  assert.equal(parsed.summary.nodeCount, 4);
  assert.equal(parsed.summary.mediaCount, 1);
});

test('导入媒体落库并替换 mediaId', async () => {
  const map = sampleMap();
  const payload = buildNodeExport(map.root, { resolveMedia: mediaResolver });
  const parsed = parseImportText(JSON.stringify(payload));
  const stored = [];
  const res = await adoptImportedMedia(parsed.node, parsed.media, async (blob, info) => {
    stored.push({ size: blob.size, type: blob.type, info });
    return { id: 'md_new1', mime: blob.type, name: info.name, size: blob.size };
  });
  assert.equal(res.missing.length, 0);
  const att = parsed.node.children[0].attachments[0];
  assert.equal(att.mediaId, 'md_new1');
  assert.equal(stored.length, 1);
});

test('媒体缺失时降级为引用并报告 missing', async () => {
  const payload = {
    format: FORMATS.node,
    version: 1,
    root: {
      title: 'x',
      attachments: [{ kind: 'image', mediaId: 'md_ghost', title: '丢失图' }],
    },
  };
  const parsed = parseImportText(JSON.stringify(payload));
  const res = await adoptImportedMedia(parsed.node, parsed.media || {}, async () => {
    throw new Error('不应被调用');
  });
  assert.equal(res.missing.length, 1);
  assert.equal(parsed.node.attachments[0].mediaId, undefined);
});

test('导图导出 → 导入：保留标题与时间', () => {
  const map = sampleMap();
  const payload = buildMapExport(map, { resolveMedia: mediaResolver });
  const parsed = parseImportText(JSON.stringify(payload));
  assert.equal(parsed.kind, 'map');
  assert.equal(parsed.map.title, '知识地图');
  assert.equal(countNodes(parsed.map.root), 4);
});

test('全量备份往返：多导图 + 节点数一致', () => {
  const m1 = sampleMap();
  const m2 = createMap('第二个导图');
  addNode(m2.root, createNode({ title: 'X' }));
  const payload = buildBackup([m1, m2], { resolveMedia: mediaResolver });
  assert.equal(payload.format, FORMATS.backup);
  assert.equal(payload.workspace.mapCount, 2);
  const parsed = parseImportText(JSON.stringify(payload));
  assert.equal(parsed.kind, 'backup');
  assert.equal(parsed.maps.length, 2);
  assert.equal(parsed.maps[0].title, '知识地图');
  assert.equal(parsed.maps[1].root.children[0].title, 'X');
  assert.equal(countNodes(parsed.maps[0].root), 4);
  assert.notEqual(parsed.maps[0].id, m1.id);
});

test('兼容外部简单结构：title + children，无 format 字段', () => {
  const text = JSON.stringify({
    title: '外部根',
    children: [{ title: '子1', children: [{ title: '孙' }] }, { title: '子2' }],
  });
  const parsed = parseImportText(text);
  assert.equal(parsed.kind, 'node');
  assert.equal(countNodes(parsed.node), 4);
});

test('兼容数组输入（视为一组同级节点）', () => {
  const parsed = parseImportText(JSON.stringify([{ title: 'A' }, { title: 'B' }]));
  assert.equal(parsed.node.children.length, 2);
});

test('兼容 name/kids/description 等别名字段', () => {
  const parsed = parseImportData({
    name: '别名根',
    description: '说明',
    kids: [{ name: '别名子', description: '子说明' }],
  });
  assert.equal(parsed.node.title, '别名根');
  assert.equal(parsed.node.note, '说明');
  assert.equal(parsed.node.children[0].title, '别名子');
});

test('非法输入给出可读错误', () => {
  assert.throws(() => parseImportText('not json'), ImportError);
  assert.throws(() => parseImportText('null'), ImportError);
  assert.throws(() => parseImportText('123'), ImportError);
  assert.throws(() => parseImportData({ format: FORMATS.map }), ImportError);
  assert.throws(() => parseImportData({ format: FORMATS.backup, maps: [] }), ImportError);
});

test('高版本文件仅提示不阻断', () => {
  const parsed = parseImportText(JSON.stringify({ format: FORMATS.node, version: 99, root: { title: '未来' } }));
  assert.equal(parsed.node.title, '未来');
  assert.ok(parsed.issues.some((i) => i.includes('99')));
});

test('导入后仍可编辑：搜索、定位、追加节点', () => {
  const map = sampleMap();
  const parsed = parseImportText(JSON.stringify(buildMapExport(map)));
  const imported = parsed.map.root;
  const hits = findMatches(imported, '第二');
  assert.equal(hits.length, 1);
  const parent = locate(imported, hits[0].node.id).node;
  addNode(parent, createNode({ title: '新增' }));
  assert.equal(countNodes(imported), 5);
});

test('导出文件名安全且带类型后缀', () => {
  const name = exportFileName('node', '我的/导图:测试');
  assert.match(name, /我的 导图 测试-节点-\d{4}-\d{2}-\d{2}\.json/);
  assert.equal(exportFileName('backup', ''), `一念-备份-${new Date().toISOString().slice(0, 10)}.json`);
});

test('环状引用不会导致无限递归（深度截断）', () => {
  const node = { title: 'root', children: [] };
  node.children.push({ title: 'child', children: [node] });
  const issues = [];
  const parsed = normalizeSafe(node, issues);
  assert.ok(countNodes(parsed) < 200);
  assert.ok(issues.length > 0);
});

function normalizeSafe(raw, issues) {
  // 通过公开 API 走同样的规范化路径
  const parsed = parseImportData({ root: raw });
  issues.push(...parsed.issues);
  return parsed.node;
}

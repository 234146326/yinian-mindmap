import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createNode,
  createMap,
  addNode,
  removeNode,
  moveNode,
  locate,
  pathTo,
  isDescendant,
  countNodes,
  maxDepth,
  findMatches,
  normalizeNode,
  cloneSubtree,
  outlineText,
  flattenVisible,
  stats,
} from '../src/js/model.js';

function sample() {
  const map = createMap('项目');
  const root = map.root;
  const a = addNode(root, createNode({ title: '设计' }));
  const a1 = addNode(a, createNode({ title: '信息架构', note: '卡片排序' }));
  const a2 = addNode(a, createNode({ title: '视觉' }));
  const b = addNode(root, createNode({ title: '开发' }));
  return { map, root, a, a1, a2, b };
}

test('创建导图与节点：根节点即标题节点', () => {
  const map = createMap('我的知识库');
  assert.equal(map.root.title, '我的知识库');
  assert.equal(map.root.children.length, 0);
  assert.ok(map.id.startsWith('m_'));
  assert.equal(countNodes(map.root), 1);
});

test('添加 / 定位 / 路径', () => {
  const { root, a, a1 } = sample();
  assert.equal(countNodes(root), 5);
  assert.equal(maxDepth(root), 2);
  const hit = locate(root, a1.id);
  assert.equal(hit.parent.id, a.id);
  assert.equal(hit.depth, 2);
  assert.equal(hit.index, 0);
  const trail = pathTo(root, a1.id).map((n) => n.title);
  assert.deepEqual(trail, ['项目', '设计', '信息架构']);
});

test('删除节点返回被删子树，且不允许删除根', () => {
  const { root, a } = sample();
  const removed = removeNode(root, a.id);
  assert.equal(removed.title, '设计');
  assert.equal(countNodes(root), 2);
  assert.equal(removeNode(root, root.id), null);
});

test('moveNode：换父、拒绝环、同父重排', () => {
  const { root, a, a1, a2, b } = sample();
  // 把自己移到自己的子孙下应失败
  const r0 = moveNode(root, a.id, a2.id);
  assert.equal(r0.ok, false);

  // a1 移到 b 下
  const r1 = moveNode(root, a1.id, b.id);
  assert.equal(r1.ok, true);
  assert.equal(locate(root, a1.id).parent.id, b.id);

  // 根节点不能移动
  assert.equal(moveNode(root, root.id, a.id).ok, false);

  // 同父内重排：b 移到索引 0
  const r3 = moveNode(root, b.id, root.id, 0);
  assert.equal(r3.ok, true);
  assert.deepEqual(root.children.map((c) => c.title), ['开发', '设计']);

  // 同父向后移动时索引需要修正
  const r4 = moveNode(root, root.children[0].id, root.id, 2);
  assert.equal(r4.ok, true);
  assert.deepEqual(root.children.map((c) => c.title), ['设计', '开发']);
});

test('isDescendant 判断子树关系', () => {
  const { a, a1, b } = sample();
  assert.equal(isDescendant(a, a1.id), true);
  assert.equal(isDescendant(a, b.id), false);
  assert.equal(isDescendant(a, a.id), false);
});

test('折叠后可见节点只保留父层', () => {
  const { root, a } = sample();
  a.collapsed = true;
  const visible = flattenVisible(root).map((x) => x.node.title);
  assert.deepEqual(visible, ['项目', '设计', '开发']);
});

test('搜索：标题优先、正文次之', () => {
  const { root } = sample();
  const byTitle = findMatches(root, '视觉');
  assert.equal(byTitle[0].node.title, '视觉');
  const byNote = findMatches(root, '卡片');
  assert.equal(byNote.length, 1);
  assert.equal(byNote[0].node.title, '信息架构');
  assert.equal(byNote[0].inBody, true);
  assert.equal(findMatches(root, '不存在的词').length, 0);
});

test('克隆子树：全新 ID、结构一致、互不影响', () => {
  const { a } = sample();
  const copy = cloneSubtree(a);
  assert.notEqual(copy.id, a.id);
  assert.equal(countNodes(copy), countNodes(a));
  assert.notEqual(copy.children[0].id, a.children[0].id);
  copy.children[0].title = '改动';
  assert.equal(a.children[0].title, '信息架构');
});

test('normalizeNode：识别别名、丢弃垃圾、限制深度', () => {
  const raw = {
    text: '外部节点',
    content: '正文',
    kids: [
      { name: '子节点 A', tags: ['x', 'y'] },
      { title: '子节点 B', children: [{ label: '孙节点' }] },
      'bad',
    ],
    media: [{ type: 'image', url: 'https://example.com/a.png', name: '图' }],
  };
  const issues = [];
  const node = normalizeNode(raw, { issues });
  assert.equal(node.title, '外部节点');
  assert.equal(node.note, '正文');
  assert.equal(node.children.length, 2);
  assert.equal(node.children[1].children[0].title, '孙节点');
  assert.equal(node.attachments[0].kind, 'image');
  assert.ok(issues.length >= 1);
  assert.ok(node.id.startsWith('n_'));
});

test('normalizeNode：数组输入被包装为节点', () => {
  const node = normalizeNode([{ title: '一' }, { title: '二' }]);
  assert.equal(node.children.length, 2);
});

test('大纲文本包含缩进层级', () => {
  const { root } = sample();
  const text = outlineText(root);
  assert.match(text, /^- 项目/m);
  assert.match(text, /^ {2}- 设计/m);
  assert.match(text, /^ {4}- 视觉/m);
});

test('统计信息', () => {
  const { root } = sample();
  const s = stats(root);
  assert.equal(s.nodes, 5);
  assert.equal(s.depth, 2);
  assert.equal(s.attachments, 0);
});

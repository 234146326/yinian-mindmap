import test from 'node:test';
import assert from 'node:assert/strict';

import { createMap, createNode, addNode } from '../src/js/model.js';
import { layoutTree, edgePath, LAYOUT } from '../src/js/layout.js';

const measure = () => ({ w: 200, h: 40 });

function buildTree() {
  const map = createMap('根');
  const a = addNode(map.root, createNode({ title: 'A' }));
  const b = addNode(map.root, createNode({ title: 'B' }));
  const a1 = addNode(a, createNode({ title: 'A1' }));
  const a2 = addNode(a, createNode({ title: 'A2' }));
  const a1x = addNode(a1, createNode({ title: 'A1x' }));
  return { map, a, b, a1, a2, a1x };
}

test('每个可见节点都有布局盒子', () => {
  const { map } = buildTree();
  const res = layoutTree(map.root, { measure });
  assert.equal(res.boxes.length, 6);
  assert.ok(res.byId.has(map.root.id));
});

test('同层节点 x 对齐，子节点在父节点右侧', () => {
  const { map, a, b, a1 } = buildTree();
  const res = layoutTree(map.root, { measure });
  const rootBox = res.byId.get(map.root.id);
  const aBox = res.byId.get(a.id);
  const bBox = res.byId.get(b.id);
  const a1Box = res.byId.get(a1.id);
  assert.equal(aBox.x, bBox.x);
  assert.ok(aBox.x > rootBox.x + rootBox.w);
  assert.ok(a1Box.x > aBox.x + aBox.w);
});

test('兄弟子树在垂直方向不重叠', () => {
  const { map } = buildTree();
  const res = layoutTree(map.root, { measure });
  const byDepth = new Map();
  for (const box of res.boxes) {
    if (!byDepth.has(box.depth)) byDepth.set(box.depth, []);
    byDepth.get(box.depth).push(box);
  }
  for (const boxes of byDepth.values()) {
    boxes.sort((x, y) => x.y - y.y);
    for (let i = 1; i < boxes.length; i += 1) {
      const prev = boxes[i - 1];
      assert.ok(boxes[i].y >= prev.y + prev.h, '同层节点出现重叠');
    }
  }
});

test('父节点在子节点组的垂直中心附近', () => {
  const { map, a, a1, a2 } = buildTree();
  const res = layoutTree(map.root, { measure });
  const aBox = res.byId.get(a.id);
  const c1 = res.byId.get(a1.id);
  const c2 = res.byId.get(a2.id);
  const center = aBox.y + aBox.h / 2;
  const spanMid = (c1.y + c1.h / 2 + c2.y + c2.h / 2) / 2;
  assert.ok(Math.abs(center - spanMid) < 1);
});

test('折叠节点不参与布局，但记录被隐藏的子节点数', () => {
  const { map, a, a1 } = buildTree();
  a.collapsed = true;
  const res = layoutTree(map.root, { measure });
  assert.equal(res.boxes.length, 3); // 根 + A + B
  assert.equal(res.byId.has(a1.id), false);
  assert.equal(res.byId.get(a.id).hiddenChildren, 2);
});

test('列宽按同层最宽节点自适应', () => {
  const { map, b } = buildTree();
  const res = layoutTree(map.root, {
    measure: (node) => ({ w: node.id === b.id ? 340 : 160, h: 40 }),
  });
  const rootBox = res.byId.get(map.root.id);
  const bBox = res.byId.get(b.id);
  assert.equal(bBox.x, res.cols[0] + LAYOUT.gapX);
  assert.ok(rootBox.w <= 160);
});

test('空树不崩溃', () => {
  const res = layoutTree(null);
  assert.equal(res.boxes.length, 0);
  assert.equal(res.bounds.width, 0);
});

test('连线路径为合法 SVG 贝塞尔', () => {
  const from = { x: 0, y: 10, w: 100, h: 40 };
  const to = { x: 200, y: 80, w: 100, h: 40 };
  const d = edgePath(from, to);
  assert.match(d, /^M100,30 C/);
  assert.ok(d.endsWith('200,100'));
});

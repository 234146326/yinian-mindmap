/* 树布局：纵向紧凑排列 + 逐层列宽，保证兄弟节点不重叠 */

import { visibleChildren } from './model.js';

export const LAYOUT = {
  gapX: 64,
  gapY: 14,
};

/**
 * @param {object} root
 * @param {{measure?:(node:object)=>{w:number,h:number}, gapX?:number, gapY?:number}} opts
 * @returns {{boxes:Array, byId:Map, bounds:{minX,minY,maxX,maxY,width,height}, cols:Array}}
 */
export function layoutTree(root, opts = {}) {
  const gapX = opts.gapX ?? LAYOUT.gapX;
  const gapY = opts.gapY ?? LAYOUT.gapY;
  const measure = typeof opts.measure === 'function' ? opts.measure : () => ({ w: 220, h: 44 });

  const byId = new Map();
  const cols = [];

  if (!root) {
    return { boxes: [], byId, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }, cols };
  }

  // 1. 测量尺寸，自底向上计算子树高度
  const measureNode = (node, depth) => {
    const size = measure(node) || { w: 220, h: 44 };
    const box = {
      id: node.id,
      node,
      depth,
      w: Math.max(40, Math.round(size.w)),
      h: Math.max(28, Math.round(size.h)),
      subH: 0,
      x: 0,
      y: 0,
      hiddenChildren: node.collapsed ? (node.children || []).length : 0,
    };
    byId.set(node.id, box);
    cols[depth] = Math.max(cols[depth] || 0, box.w);

    const kids = visibleChildren(node);
    if (kids.length === 0) {
      box.subH = box.h;
    } else {
      let total = 0;
      kids.forEach((child, i) => {
        measureNode(child, depth + 1);
        total += byId.get(child.id).subH + (i > 0 ? gapY : 0);
      });
      box.subH = Math.max(box.h, total);
    }
    return box;
  };
  measureNode(root, 0);

  // 2. 列起始 x
  const colX = [];
  let x = 0;
  for (let d = 0; d < cols.length; d += 1) {
    colX[d] = x;
    x += cols[d] + gapX;
  }

  // 3. 自顶向下定位
  const place = (node, top) => {
    const box = byId.get(node.id);
    box.x = colX[box.depth];
    box.y = Math.round(top + (box.subH - box.h) / 2);
    const kids = visibleChildren(node);
    if (!kids.length) return;
    let total = 0;
    kids.forEach((c, i) => {
      total += byId.get(c.id).subH + (i > 0 ? gapY : 0);
    });
    let cursor = top + (box.subH - total) / 2;
    kids.forEach((c) => {
      const cb = byId.get(c.id);
      place(c, cursor);
      cursor += cb.subH + gapY;
    });
  };
  place(root, 0);

  // 4. 边界与连线
  const boxes = [...byId.values()];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!boxes.length) {
    minX = minY = maxX = maxY = 0;
  }

  const edges = [];
  for (const b of boxes) {
    for (const child of visibleChildren(b.node)) {
      const cb = byId.get(child.id);
      if (cb) edges.push({ from: b, to: cb });
    }
  }

  return {
    boxes,
    byId,
    edges,
    cols,
    bounds: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
  };
}

/** 生成柔和的横向贝塞尔路径 */
export function edgePath(from, to) {
  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const y2 = to.y + to.h / 2;
  const dx = Math.max(24, (x2 - x1) * 0.5);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

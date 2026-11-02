/* 画布视图：节点渲染、缩放平移、拖拽换父、内联编辑 */

import { flattenVisible, visibleChildren, isDescendant } from './model.js';
import { layoutTree, edgePath } from './layout.js';
import { clamp, escapeHtml } from './util.js';
import { icon } from './ui.js';

const MIN_SCALE = 0.2;
const MAX_SCALE = 2.4;
const FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

export class CanvasView {
  constructor({ stage, world, nodesLayer, edgeLayer, hooks }) {
    this.stage = stage;
    this.world = world;
    this.nodesLayer = nodesLayer;
    this.edgeLayer = edgeLayer;
    this.hooks = hooks || {};
    this.els = new Map();
    this.view = { x: 0, y: 0, k: 1 };
    this.map = null;
    this.layout = null;
    this.selectedId = null;
    this.editing = null;
    this.opts = {};
    this._measureCtx = document.createElement('canvas').getContext('2d');
    this._bindEvents();
  }

  /* ---------------- 渲染 ---------------- */

  render(map, opts = {}) {
    this.map = map;
    this.opts = opts;
    this.selectedId = opts.selectedId || null;
    const root = map.root;
    const items = flattenVisible(root);
    const visibleIds = new Set(items.map((it) => it.node.id));

    // 1. 同步节点 DOM
    for (const { node, depth } of items) {
      let el = this.els.get(node.id);
      if (!el) {
        el = this._createEl(node);
        this.nodesLayer.appendChild(el);
        this.els.set(node.id, el);
      }
      this._updateEl(el, node, depth);
    }
    for (const [id, el] of this.els) {
      if (!visibleIds.has(id)) {
        el.remove();
        this.els.delete(id);
      }
    }

    // 2. 宽度先落定（避免测量时反复回流）
    for (const { node } of items) {
      const el = this.els.get(node.id);
      el.style.width = `${this._estimateWidth(node)}px`;
    }

    // 3. 布局
    this.layout = layoutTree(root, {
      measure: (node) => {
        const el = this.els.get(node.id);
        return { w: el ? el.offsetWidth : 200, h: el ? el.offsetHeight : 40 };
      },
    });

    // 4. 定位
    for (const box of this.layout.boxes) {
      const el = this.els.get(box.id);
      if (!el) continue;
      el.style.transform = `translate(${box.x}px, ${box.y}px)`;
      el.style.zIndex = String(10 + box.depth);
    }

    // 5. 连线
    this._renderEdges(items);

    // 6. 视图
    if (opts.resetView) this.fit({ animate: false });
    else if (opts.centerOn) this.centerOn(opts.centerOn);
    this.applyView();
    this._applyFocus(items);
  }

  _createEl(node) {
    const el = document.createElement('div');
    el.className = 'node';
    el.dataset.id = node.id;
    el.innerHTML =
      '<div class="node-title" data-role="title"></div><div class="node-badges"></div>' +
      '<button class="node-handle" tabindex="-1" aria-label="折叠或展开子节点"></button>';
    return el;
  }

  _updateEl(el, node, depth) {
    el.className = `node depth-${depth}`;
    if (depth === 0) el.classList.add('is-root');
    if (node.children && node.children.length) el.classList.add('has-children');
    if (node.collapsed && node.children.length) el.classList.add('has-hidden');
    if (node.id === this.selectedId) el.classList.add('is-selected');
    if (this.editing && this.editing.id === node.id) el.classList.add('is-editing');
    if (node.color) {
      el.style.setProperty('--node-accent', node.color);
      el.classList.add('tag-tint');
    } else {
      el.style.removeProperty('--node-accent');
    }
    el.title = node.title;

    const titleEl = el.querySelector('[data-role="title"]');
    if (!this.editing || this.editing.id !== node.id) {
      titleEl.textContent = node.title;
    }
    el.querySelector('.node-badges').innerHTML = this._badges(node);

    const handle = el.querySelector('.node-handle');
    if (!node.children.length) {
      handle.style.display = 'none';
      handle.textContent = '';
    } else {
      handle.style.display = 'grid';
      handle.innerHTML = node.collapsed ? String(node.children.length) : icon('chevronRight', 'handle-icon');
    }
    el.setAttribute('aria-label', `${node.title}${node.children.length ? `，${node.children.length} 个子节点` : ''}`);
  }

  _badges(node) {
    const atts = node.attachments || [];
    const count = (kind) => atts.filter((a) => a.kind === kind).length;
    const parts = [];
    if (node.note && node.note.trim()) parts.push(`<span class="badge">${icon('note')}</span>`);
    for (const kind of ['image', 'video', 'link', 'ref']) {
      const n = count(kind);
      if (n) parts.push(`<span class="badge">${icon(kind)}${n > 1 ? n : ''}</span>`);
    }
    const data = node.data || {};
    const shots = Array.isArray(data.shots) ? data.shots.length : 0;
    if (shots) parts.push(`<span class="badge">分镜 ${shots}</span>`);
    if (data.synopsis && String(data.synopsis).trim()) parts.push('<span class="badge">梗概</span>');
    if (data.imageUrl) parts.push(`<span class="badge">${icon('image')}</span>`);
    if (data.videoUrl) parts.push(`<span class="badge">${icon('video')}</span>`);
    if (node.tags && node.tags.length) {
      parts.push(`<span class="badge">#${escapeHtml(node.tags[0])}${node.tags.length > 1 ? `+${node.tags.length - 1}` : ''}</span>`);
    }
    return parts.slice(0, 5).join('');
  }

  _renderEdges(items) {
    const visible = new Set(items.map((i) => i.node.id));
    const paths = [];
    for (const box of this.layout.boxes) {
      for (const child of visibleChildren(box.node)) {
        const cb = this.layout.byId.get(child.id);
        if (!cb || !visible.has(child.id)) continue;
        const active = child.id === this.selectedId || box.id === this.selectedId;
        paths.push(
          `<path class="edge${active ? ' is-active' : ''}" data-from="${box.id}" data-to="${child.id}" d="${edgePath(
            box,
            cb,
          )}"/>`,
        );
      }
    }
    this.edgeLayer.innerHTML = paths.join('');
  }

  _applyFocus(items) {
    const focusMode = !!this.opts.focusMode;
    const allowed = new Set();
    if (focusMode && this.selectedId && this.map) {
      const locate = (node, trail) => {
        if (node.id === this.selectedId) return trail.concat(node);
        for (const c of node.children || []) {
          const r = locate(c, trail.concat(node));
          if (r) return r;
        }
        return null;
      };
      const path = locate(this.map.root, []) || [];
      const collect = (node) => {
        allowed.add(node.id);
        (node.children || []).forEach(collect);
      };
      path.forEach((n) => allowed.add(n.id));
      const target = path[path.length - 1];
      if (target) collect(target);
    }
    for (const [id, el] of this.els) el.classList.toggle('is-dim', focusMode && !allowed.has(id));
    this.edgeLayer.querySelectorAll('.edge').forEach((p) => {
      p.classList.toggle('is-dim', focusMode && !allowed.has(p.dataset.to));
    });
  }

  _estimateWidth(node) {
    const isRoot = node.id === (this.map ? this.map.root.id : null);
    this._measureCtx.font = `${isRoot ? 600 : 500} ${isRoot ? 15 : 13.5}px ${FONT_FAMILY}`;
    const titleW = this._measureCtx.measureText(node.title || '').width;
    const badges = (node.note ? 1 : 0) + (node.attachments || []).length + (node.tags || []).length;
    const base = Math.max(titleW + 26, badges ? 132 : 108);
    return Math.round(clamp(base, 108, 300));
  }

  /* ---------------- 视图变换 ---------------- */

  applyView() {
    const { x, y, k } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    this.stage.style.backgroundSize = `${24 * k}px ${24 * k}px`;
    this.stage.style.backgroundPosition = `${x}px ${y}px`;
    if (this.hooks.onViewChange) this.hooks.onViewChange(this.view);
  }

  setView(view) {
    this.view = { ...this.view, ...view };
    this.applyView();
  }

  zoomAt(factor, cx, cy) {
    const rect = this.stage.getBoundingClientRect();
    const px = cx == null ? rect.width / 2 : cx - rect.left;
    const py = cy == null ? rect.height / 2 : cy - rect.top;
    const k0 = this.view.k;
    const k = clamp(k0 * factor, MIN_SCALE, MAX_SCALE);
    if (k === k0) return;
    this.view.x = px - ((px - this.view.x) * k) / k0;
    this.view.y = py - ((py - this.view.y) * k) / k0;
    this.view.k = k;
    this.applyView();
  }

  setZoom(k) {
    this.zoomAt(k / this.view.k);
  }

  fit({ animate = true } = {}) {
    if (!this.layout) return;
    const rect = this.stage.getBoundingClientRect();
    const b = this.layout.bounds;
    const padX = 64;
    const padY = 64;
    const availW = Math.max(100, rect.width - padX * 2);
    const availH = Math.max(100, rect.height - padY * 2);
    const k = clamp(Math.min(availW / Math.max(1, b.width), availH / Math.max(1, b.height)), MIN_SCALE, 1.15);
    this.view.k = k;
    this.view.x = (rect.width - b.width * k) / 2 - b.minX * k;
    this.view.y = (rect.height - b.height * k) / 2 - b.minY * k;
    this.applyView();
    if (animate && this.hooks.onAnimate) this.hooks.onAnimate();
  }

  centerOn(nodeId, { scale = null } = {}) {
    if (!this.layout) return;
    const box = this.layout.byId.get(nodeId);
    if (!box) return;
    const rect = this.stage.getBoundingClientRect();
    const k = scale == null ? clamp(this.view.k, 0.55, 1.25) : scale;
    this.view.k = k;
    this.view.x = rect.width / 2 - (box.x + box.w / 2) * k;
    this.view.y = rect.height / 2 - (box.y + box.h / 2) * k;
    this.applyView();
  }

  /* ---------------- 选择与编辑 ---------------- */

  select(id, { center = false } = {}) {
    this.selectedId = id;
    for (const [nid, el] of this.els) el.classList.toggle('is-selected', nid === id);
    this._renderEdges(flattenVisible(this.map.root));
    if (center && id) this.centerOn(id);
    if (this.hooks.onSelect) this.hooks.onSelect(id);
  }

  startEdit(id, { selectAll = true } = {}) {
    const el = this.els.get(id);
    if (!el) return;
    const titleEl = el.querySelector('[data-role="title"]');
    if (!titleEl) return;
    const node = this._nodeById(id);
    if (!node) return;
    this.editing = { id, original: node.title };
    el.classList.add('is-editing');
    titleEl.setAttribute('contenteditable', 'plaintext-only');
    titleEl.spellcheck = false;
    titleEl.textContent = node.title;
    titleEl.focus();
    if (selectAll) {
      const range = document.createRange();
      range.selectNodeContents(titleEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const onKey = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        this.commitEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancelEdit();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        this.commitEdit({ thenAddChild: true });
      }
    };
    const onBlur = () => {
      // 延迟，让点击其它节点的 mousedown 先处理
      setTimeout(() => {
        if (this.editing && this.editing.id === id) this.commitEdit();
      }, 120);
    };
    titleEl.addEventListener('keydown', onKey);
    titleEl.addEventListener('blur', onBlur);
    this.editing.cleanup = () => {
      titleEl.removeEventListener('keydown', onKey);
      titleEl.removeEventListener('blur', onBlur);
      titleEl.removeAttribute('contenteditable');
      el.classList.remove('is-editing');
    };
  }

  commitEdit({ thenAddChild = false } = {}) {
    if (!this.editing) return;
    const { id, cleanup } = this.editing;
    const el = this.els.get(id);
    const titleEl = el ? el.querySelector('[data-role="title"]') : null;
    const text = titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '';
    this.editing = null;
    if (cleanup) cleanup();
    if (this.hooks.onTitleCommit) this.hooks.onTitleCommit(id, text, { thenAddChild });
  }

  cancelEdit() {
    if (!this.editing) return;
    const { id, cleanup, original } = this.editing;
    const el = this.els.get(id);
    const titleEl = el ? el.querySelector('[data-role="title"]') : null;
    if (titleEl) titleEl.textContent = original;
    this.editing = null;
    if (cleanup) cleanup();
    if (this.hooks.onEditCancel) this.hooks.onEditCancel(id);
  }

  get isEditing() {
    return !!this.editing;
  }

  _nodeById(id) {
    if (!this.map) return null;
    let found = null;
    const step = (n) => {
      if (n.id === id) found = n;
      else (n.children || []).forEach((c) => {
        if (!found) step(c);
      });
    };
    step(this.map.root);
    return found;
  }

  pulse(id) {
    const el = this.els.get(id);
    if (!el) return;
    el.classList.remove('is-match');
    void el.offsetWidth;
    el.classList.add('is-match');
    setTimeout(() => el.classList.remove('is-match'), 3000);
  }

  /* ---------------- 事件 ---------------- */

  _bindEvents() {
    const stage = this.stage;

    // 平移
    let pan = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button === 1 || (e.button === 0 && !e.target.closest('.node') && !e.target.closest('.hud'))) {
        if (e.target.closest('.hud') || e.target.closest('.stage-tip') || e.target.closest('.stage-empty')) return;
        if (this.editing) this.commitEdit();
        pan = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
        stage.classList.add('is-panning');
        stage.setPointerCapture(e.pointerId);
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (pan) {
        this.view.x = pan.vx + (e.clientX - pan.x);
        this.view.y = pan.vy + (e.clientY - pan.y);
        this.applyView();
      }
    });
    const endPan = (e) => {
      if (pan) {
        pan = null;
        stage.classList.remove('is-panning');
        try {
          stage.releasePointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
      }
    };
    stage.addEventListener('pointerup', endPan);
    stage.addEventListener('pointercancel', endPan);

    // 缩放
    stage.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.zoomAt(e.deltaY < 0 ? 1.08 : 0.926, e.clientX, e.clientY);
        } else {
          e.preventDefault();
          this.view.x -= e.deltaX;
          this.view.y -= e.deltaY;
          this.applyView();
        }
      },
      { passive: false },
    );

    // 节点交互（事件委托）
    this.nodesLayer.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.node-handle');
      const nodeEl = e.target.closest('.node');
      if (!nodeEl) return;
      const id = nodeEl.dataset.id;
      if (handle) {
        e.stopPropagation();
        e.preventDefault();
        if (this.hooks.onToggleCollapse) this.hooks.onToggleCollapse(id);
        return;
      }
      if (e.target.closest('.node-title') && this.editing && this.editing.id === id) return;
      if (this.editing && this.editing.id !== id) this.commitEdit();
      e.stopPropagation();
      this.select(id);
      this._startDrag(e, id, nodeEl);
    });

    this.nodesLayer.addEventListener('dblclick', (e) => {
      const nodeEl = e.target.closest('.node');
      if (!nodeEl) return;
      e.stopPropagation();
      const id = nodeEl.dataset.id;
      if (this.editing && this.editing.id === id) return;
      if (this.editing) this.commitEdit();
      this.select(id);
      this.startEdit(id);
    });

    this.nodesLayer.addEventListener('contextmenu', (e) => {
      const nodeEl = e.target.closest('.node');
      if (!nodeEl) return;
      e.preventDefault();
      const id = nodeEl.dataset.id;
      this.select(id);
      if (this.hooks.onContextMenu) this.hooks.onContextMenu(id, e);
    });

    stage.addEventListener('dblclick', (e) => {
      if (e.target.closest('.node') || e.target.closest('.hud') || e.target.closest('.stage-tip')) return;
      if (this.hooks.onCanvasDblClick) this.hooks.onCanvasDblClick();
    });
  }

  _startDrag(e, id, nodeEl) {
    if (!this.map || id === this.map.root.id) return;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let target = null;
    let overEmpty = false;
    const fromSubtree = this._nodeById(id);

    const clearMarks = () => {
      this.nodesLayer.querySelectorAll('.node').forEach((n) => {
        n.classList.remove('drop-child', 'drop-before', 'drop-after');
      });
    };

    const onMove = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        dragging = true;
        nodeEl.classList.add('is-dragging');
      }
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const dropEl = under && under.closest ? under.closest('.node') : null;
      clearMarks();
      target = null;
      if (!dropEl) {
        const rect = this.stage.getBoundingClientRect();
        overEmpty =
          ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
        this.stage.classList.toggle('drop-root', overEmpty);
        if (this.hooks.onDragNearCanvas) this.hooks.onDragNearCanvas(overEmpty);
        return;
      }
      overEmpty = false;
      this.stage.classList.remove('drop-root');
      const tid = dropEl.dataset.id;
      if (tid === id || isDescendant(fromSubtree, tid)) return;
      const rect = dropEl.getBoundingClientRect();
      let intent;
      const relX = (ev.clientX - rect.left) / rect.width;
      if (relX > 0.55) intent = 'child';
      else intent = ev.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      if (tid === this.map.root.id && intent !== 'child') intent = 'child';
      target = { id: tid, intent };
      dropEl.classList.add(`drop-${intent}`);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      clearMarks();
      nodeEl.classList.remove('is-dragging');
      this.stage.classList.remove('drop-root');
      if (!dragging) return;
      if (target && this.hooks.onDrop) this.hooks.onDrop(id, target.id, target.intent);
      else if (overEmpty && this.hooks.onDropOut) this.hooks.onDropOut(id);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  /* ---------------- 键盘导航辅助 ---------------- */

  visibleItems() {
    if (!this.map) return [];
    return flattenVisible(this.map.root);
  }

  moveSelection(dir) {
    if (!this.map || !this.selectedId) return;
    const items = this.visibleItems();
    const idx = items.findIndex((i) => i.node.id === this.selectedId);
    if (idx < 0) return;
    const cur = items[idx];
    let nextId = null;
    if (dir === 'up') {
      for (let i = idx - 1; i >= 0; i -= 1) {
        if (items[i].depth <= cur.depth) {
          nextId = items[i].node.id;
          break;
        }
      }
    } else if (dir === 'down') {
      for (let i = idx + 1; i < items.length; i += 1) {
        if (items[i].depth <= cur.depth) {
          nextId = items[i].node.id;
          break;
        }
      }
    } else if (dir === 'left') {
      if (cur.parent) nextId = cur.parent.id;
    } else if (dir === 'right') {
      const k = visibleChildren(cur.node);
      if (k.length) nextId = k[0].id;
    }
    if (nextId) this.select(nextId, { center: true });
  }
}

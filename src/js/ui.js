/* 轻量 UI 基础设施：图标、提示、弹窗、菜单 */

import { escapeHtml } from './util.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const PATHS = {
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  rule: '<path d="M4 6h16M4 12h10M4 18h13"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  code: '<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12H8"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h6"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"/>',
  target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  focus: '<circle cx="12" cy="12" r="3.5"/><path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-1.8"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  note: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M4 17l5-5 4 4 3-3 4 4"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10.5 21 7v10l-5-3.5z"/>',
  link: '<path d="M10.5 13.5a4.5 4.5 0 0 0 6.4 0l2-2a4.5 4.5 0 0 0-6.4-6.4l-1.1 1.1"/><path d="M13.5 10.5a4.5 4.5 0 0 0-6.4 0l-2 2a4.5 4.5 0 0 0 6.4 6.4l1.1-1.1"/>',
  ref: '<path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z"/><path d="M8 3v18M12 7h4M12 11h4"/>',
  trash: '<path d="M4 7h16M9.5 7V4h5v3M6.5 7l1 13h9l1-13"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  cursor: '<path d="M4 3l7 17 2.6-6.4L20 11z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M12 9v5M12 17h.01"/><path d="M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  key: '<circle cx="8" cy="15" r="3.6"/><path d="M10.6 12.4 20 3l2 2-2 2-2-2-3 3"/>',
  database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
  eyeOff: '<path d="M2 12s3.6-6.5 10-6.5c1.7 0 3.2.4 4.5 1M22 12s-3.6 6.5-10 6.5c-1.7 0-3.2-.4-4.5-1"/><path d="M4 4l16 16"/>',
  expand: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
  collapse: '<path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7V3M8 21v-7h8v7"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
};

export function icon(name, extraClass = '') {
  const path = PATHS[name] || PATHS.info;
  return `<svg class="icon ${extraClass}" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
}

/** 把 [data-icon] 元素填充为 SVG（支持后续动态插入的节点） */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.dataset.iconHydrated === '1') return;
    const svg = icon(el.dataset.icon);
    el.insertAdjacentHTML('afterbegin', svg);
    el.dataset.iconHydrated = '1';
  });
}

export function startIconObserver() {
  hydrateIcons();
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.dataset && node.dataset.icon && node.dataset.iconHydrated !== '1') {
          node.insertAdjacentHTML('afterbegin', icon(node.dataset.icon));
          node.dataset.iconHydrated = '1';
        }
        hydrateIcons(node);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export function setIcon(el, name) {
  if (!el) return;
  const svg = el.querySelector('svg.icon');
  if (svg) svg.outerHTML = icon(name);
  else el.insertAdjacentHTML('afterbegin', icon(name));
}

/* ---------------- Toast ---------------- */
export function toast(message, opts = {}) {
  const root = $('#toasts');
  if (!root) return;
  const type = opts.type || 'info';
  const node = document.createElement('div');
  node.className = `toast${type === 'error' ? ' is-error' : type === 'ok' ? ' is-ok' : ''}`;
  const glyph = type === 'error' ? 'alert' : type === 'ok' ? 'check' : 'info';
  node.innerHTML = `${icon(glyph)}<span>${escapeHtml(message)}</span>`;
  root.appendChild(node);
  const ttl = opts.duration ?? (type === 'error' ? 4200 : 2400);
  setTimeout(() => {
    node.style.transition = 'opacity .2s, transform .2s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 220);
  }, ttl);
}

/* ---------------- 弹窗 ---------------- */
export function openModal({ title, body, footer = '', wide = false, onClose = null, closeOnBackdrop = true }) {
  const root = $('#modalRoot');
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3>${escapeHtml(title)}</h3>
        <button class="icon-btn small" data-close aria-label="关闭">${icon('close')}</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  root.appendChild(wrap);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey);
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  if (closeOnBackdrop) {
    wrap.querySelector('.modal-backdrop').addEventListener('click', close);
  }
  hydrateIcons(wrap);
  return { root: wrap, modal: wrap.querySelector('.modal'), body: wrap.querySelector('.modal-body'), close };
}

export function confirmDialog({
  title = '确认操作',
  message = '',
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const { modal, close } = openModal({
      title,
      body: `<div class="confirm-text">${message}</div>`,
      footer: `<button class="btn" data-close>${escapeHtml(cancelText)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm>${escapeHtml(confirmText)}</button>`,
      onClose: () => done(false),
    });
    modal.querySelector('[data-confirm]').addEventListener('click', () => {
      done(true);
      close();
    });
  });
}

/* ---------------- 菜单 ---------------- */
let activeMenu = null;

export function closeMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}

export function openMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = items
    .map((item, i) => {
      if (item.type === 'sep') return '<div class="menu-sep"></div>';
      return `<button class="menu-item${item.danger ? ' is-danger' : ''}" data-i="${i}">
        ${item.icon ? icon(item.icon) : ''}
        <span>${escapeHtml(item.label)}</span>
        ${item.shortcut ? `<span class="shortcut">${escapeHtml(item.shortcut)}</span>` : ''}
      </button>`;
    })
    .join('');
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.min(rect.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = rect.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  activeMenu = menu;

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('.menu-item');
    if (!btn) return;
    const item = items[Number(btn.dataset.i)];
    closeMenu();
    if (item && item.onClick) item.onClick();
  });
  setTimeout(() => {
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (activeMenu && !activeMenu.contains(e.target) && !anchor.contains(e.target)) closeMenu();
      },
      { once: true },
    );
  }, 0);
  return menu;
}

/* ---------------- 灯箱 ---------------- */
export function openLightbox(node, caption = '') {
  const box = $('#lightbox');
  const body = $('#lightboxBody');
  const cap = $('#lightboxCaption');
  body.innerHTML = '';
  body.appendChild(node);
  cap.textContent = caption || '';
  box.hidden = false;
}

export function closeLightbox() {
  const box = $('#lightbox');
  const body = $('#lightboxBody');
  box.hidden = true;
  body.querySelectorAll('video').forEach((v) => v.pause());
  body.innerHTML = '';
}

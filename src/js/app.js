/* 一念 · 应用主逻辑 */

import {
  createMap,
  createNode,
  createAttachment,
  addNode,
  removeNode,
  moveNode,
  locate,
  pathTo,
  cloneSubtree,
  countNodes,
  findMatches,
  outlineText,
  generateEpisodes,
  touch,
} from './model.js';
import {
  buildNodeExport,
  buildMapExport,
  buildBackup,
  parseImportText,
  adoptImportedMedia,
  collectMediaIds,
  exportFileName,
  ImportError,
} from './jsonio.js';
import { Store, isAuthConfig } from './store.js';
import { deriveMaterial } from './crypto.js';
import { normalizeProfile, matchesPassword, isStaleLocalProfile } from './authguard.js';
import { CanvasView } from './canvas.js';
import { createInspector, linkFormHTML, readLinkForm } from './inspector.js';
import { createRulePanel } from './rulepanel.js';
import {
  resolveRule,
  resolveDownRule,
  syncEpisodeField,
  allRules,
  writeField,
  normalizeRuleTemplate,
  RuleError,
} from './rules.js';
import { createFieldEditor } from './fields.js';
import { buildSvg, svgFileName } from './svg.js';
import {
  $,
  $$,
  icon,
  toast,
  openModal,
  confirmDialog,
  openMenu,
  closeMenu,
  openLightbox,
  closeLightbox,
  hydrateIcons,
  setIcon,
} from './ui.js';
import {
  nowISO,
  debounce,
  escapeHtml,
  download,
  formatDate,
  formatTime,
  byteSize,
} from './util.js';

const APP_VERSION = '1.0.0';
const AUTOSAVE_DELAY = 500;

const S = {
  store: new Store(),
  maps: [],
  currentMapId: null,
  selectedId: null,
  settings: {
    theme: 'light',
    autoLockMin: 30,
    focusMode: false,
    tipDismissed: false,
    customRules: [],
  },
  history: { undo: [], redo: [], lastKey: null, lastAt: 0 },
  locked: true,
  mode: 'unlock',
  fileAuth: null,
  fixedAuth: null,
  staleLocal: false,
  pendingSaves: new Set(),
  saveState: 'saved',
  mediaUrls: new Map(),
  search: { results: [], active: -1, query: '' },
  ready: false,
  freshNodeId: null,
};

let rulePanel = null;

/* ============================================================
   启动
   ============================================================ */

document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  applyTheme(S.settings.theme);
  // 构建时内嵌的固定密码配置（提供者指定）；不存在则退回访客自设密码
  S.fixedAuth = normalizeProfile(globalThis.__YINIAN_AUTH__);
  bindGlobalUI();
  try {
    await S.store.open();
    S.fileAuth = S.fixedAuth ? null : await loadAuthFile();
    const auth = await S.store.readAuth();
    if (S.fixedAuth) {
      enterFixedMode(auth);
    } else if (!auth) {
      enterSetupMode();
    } else {
      enterUnlockMode(auth);
    }
  } catch (err) {
    console.error(err);
    showLockError(`本地存储不可用：${err.message}`);
    $('#lockScreen').hidden = false;
  }
}

async function loadAuthFile() {
  try {
    const res = await fetch('auth.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return isAuthConfig(data) ? data : null;
  } catch {
    return null;
  }
}

/** 读取提供者分发的访问密钥文件（仅含 salt / 迭代次数 / 校验值，不含明文密码） */
function pickAuthFile() {
  if (S.fixedAuth) {
    toast('本页使用提供者固定的访问密码，无需导入密钥文件', { type: 'error' });
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = (input.files || [])[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!isAuthConfig(data)) throw new Error('不是有效的访问密钥文件');
      S.fileAuth = data;
      enterSetupMode();
      toast(`已载入访问密钥（指纹 ${data.fingerprint || '—'}），请输入提供者给你的密码`, { type: 'ok' });
    } catch (err) {
      toast(`密钥文件无法使用：${err.message}`, { type: 'error' });
    }
  });
  input.click();
}

/** 提供者换过密码时：本机旧数据无法用新密码解密，只能清空后重来 */
function resetLocalFromLock() {
  confirmDialog({
    title: '清空本机旧数据',
    message:
      '本机保存的导图是用<b>旧密码</b>加密的，新密码无法解密它们。<br><br>清空后这些内容会被永久删除、无法恢复。若你还记得旧密码，请先用旧版本页面登录并导出 JSON 备份。',
    confirmText: '我确认清空',
    danger: true,
  }).then(async (ok) => {
    if (!ok) return;
    await S.store.wipeAll();
    location.reload();
  });
}

function enterSetupMode() {
  S.mode = 'setup';
  S.locked = true;
  $('#lockScreen').hidden = false;
  $('#shell').hidden = true;
  $('#lockLabel').textContent = '设置访问密码';
  $('#lockSubmit').textContent = S.fileAuth ? '使用提供者密钥进入' : '创建并进入';
  $('#btnImportAuth').hidden = !!S.fileAuth;
  $('#confirmField').hidden = !!S.fileAuth;
  $('#btnResetLocal').hidden = true;
  $('#lockPassword').placeholder = '设置一个密码（至少 6 位）';
  $('#lockPassword').setAttribute('autocomplete', 'new-password');
  $('#lockHint').className = 'lock-hint';
  if (S.fileAuth) {
    $('#lockHint').textContent = `已检测到 auth.json（指纹 ${S.fileAuth.fingerprint || '—'}）。请输入该配置文件对应的密码。`;
    $('#lockFoot').textContent =
      '密码校验信息来自项目目录下的 auth.json，明文密码不会出现在任何静态资源中。';
  } else {
    $('#lockHint').textContent = '密码用于加密本地数据，忘记后无法找回，请务必记住。';
  }
  setTimeout(() => $('#lockPassword').focus(), 60);
}

function enterUnlockMode(auth) {
  S.mode = 'unlock';
  S.locked = true;
  $('#lockScreen').hidden = false;
  $('#shell').hidden = true;
  $('#lockLabel').textContent = '密码';
  $('#lockSubmit').textContent = '进入工作空间';
  $('#confirmField').hidden = true;
  $('#btnResetLocal').hidden = true;
  $('#lockPassword').value = '';
  $('#lockPassword').placeholder = '请输入密码';
  $('#lockPassword').setAttribute('autocomplete', 'current-password');
  lockHintReset(auth);
  setTimeout(() => $('#lockPassword').focus(), 60);
}

/**
 * 固定密码模式：密码由提供者指定（构建时内嵌校验值），访客不能自设、不能修改。
 * localAuth 是浏览器里已有的工作空间记录；若它与内嵌配置不一致，说明提供者换过密码。
 */
function enterFixedMode(localAuth) {
  S.mode = 'fixed';
  S.locked = true;
  S.staleLocal = isStaleLocalProfile(S.fixedAuth, localAuth);
  $('#lockScreen').hidden = false;
  $('#shell').hidden = true;
  $('#lockLabel').textContent = '访问密码';
  $('#lockSubmit').textContent = localAuth ? '进入工作空间' : '开始使用';
  $('#confirmField').hidden = true;
  $('#btnImportAuth').hidden = true;
  $('#btnResetLocal').hidden = !S.staleLocal;
  $('#lockPassword').value = '';
  $('#lockPassword').placeholder = '请输入提供者给你的密码';
  $('#lockPassword').setAttribute('autocomplete', 'current-password');
  const hint = $('#lockHint');
  hint.className = 'lock-hint';
  hint.textContent = S.staleLocal
    ? '密码配置已更新，本机旧数据是用旧密码加密的，无法再用新密码打开。'
    : '密码由提供者指定，无法在此修改或重置。';
  $('#lockFoot').textContent =
    `密钥 v${S.fixedAuth.version} · 密码由提供者指定。页面内只内嵌 PBKDF2 校验值（无明文），` +
    '内容以 AES-256-GCM 加密，仅保存在本机浏览器。';
  setTimeout(() => $('#lockPassword').focus(), 60);
}

function lockHintReset(auth) {
  const hint = $('#lockHint');
  hint.className = 'lock-hint';
  const created = auth && auth.createdAt ? formatDate(auth.createdAt).slice(0, 10) : '';
  hint.textContent = created ? `工作空间创建于 ${created} · AES-256-GCM 本地加密` : 'AES-256-GCM 本地加密';
}

function showLockError(message) {
  const hint = $('#lockHint');
  hint.className = 'lock-hint is-error';
  hint.textContent = message;
  const lock = $('#lockScreen');
  lock.classList.remove('is-shake');
  void lock.offsetWidth;
  lock.classList.add('is-shake');
}

async function handleLockSubmit(e) {
  e.preventDefault();
  const pass = $('#lockPassword').value;
  const pass2 = $('#lockPassword2').value;
  const btn = $('#lockSubmit');

  if (!pass) return showLockError('请输入密码');
  if (S.mode === 'setup') {
    if (pass.length < 6) return showLockError('密码至少 6 位，建议混合字母、数字与符号');
    if (!S.fileAuth && pass !== pass2) return showLockError('两次输入的密码不一致');
  }

  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '正在解锁…';
  try {
    if (S.mode === 'fixed') {
      const localAuth = await S.store.readAuth();
      const ok = await matchesPassword(S.fixedAuth, pass);
      if (!ok) {
        showLockError('密码不正确，请联系提供者获取访问密码');
        return;
      }
      if (!localAuth) {
        // 首次在干净浏览器打开：用固定密码的 salt/verifier 建立本地工作空间
        await S.store.setupPassword(pass, {
          salt: S.fixedAuth.salt,
          iterations: S.fixedAuth.iterations,
          verifier: S.fixedAuth.verifier,
          source: 'builtin',
        });
      } else if (isStaleLocalProfile(S.fixedAuth, localAuth)) {
        S.staleLocal = true;
        $('#btnResetLocal').hidden = false;
        showLockError('密码正确，但本机旧数据由旧密码加密，无法解密；请清空本机数据后重新开始');
        return;
      } else {
        await S.store.unlock(pass);
      }
      await enterWorkspace();
    } else if (S.mode === 'setup') {
      if (S.fileAuth) {
        const verify = await deriveMaterial(pass, S.fileAuth.pbkdf2.salt, S.fileAuth.pbkdf2.iterations);
        if (verify.verifier !== S.fileAuth.pbkdf2.verifier) {
          showLockError('密码与 auth.json 中的配置不一致');
          return;
        }
        await S.store.setupPassword(pass, {
          salt: S.fileAuth.pbkdf2.salt,
          iterations: S.fileAuth.pbkdf2.iterations,
          verifier: S.fileAuth.pbkdf2.verifier,
          source: 'auth.json',
        });
      } else {
        await S.store.setupPassword(pass);
      }
      await enterWorkspace();
    } else {
      await S.store.unlock(pass);
      await enterWorkspace();
    }
    $('#lockPassword').value = '';
    $('#lockPassword2').value = '';
    $('#lockScreen').hidden = true;
    $('#shell').hidden = false;
    S.locked = false;
    markActivity();
    startAutoLock();
    toast('已解锁，欢迎回来', { type: 'ok' });
  } catch (err) {
    console.error(err);
    if (err.code === 'BAD_PASSWORD') showLockError('密码不正确，请重试');
    else if (err.name === 'OperationError') showLockError('无法解密本地数据，密码可能不正确');
    else showLockError(err.message || '解锁失败');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function enterWorkspace() {
  const ws = await S.store.loadWorkspace();
  S.maps = ws.maps;
  S.settings = { ...S.settings, ...(ws.settings || {}) };
  applyTheme(S.settings.theme);

  if (!S.maps.length) {
    const welcome = buildWelcomeMap();
    S.maps.push(welcome);
    await S.store.saveMap(welcome);
    await S.store.saveWorkspace({ maps: S.maps, settings: S.settings, lastMapId: welcome.id });
  }

  S.currentMapId =
    (ws.lastMapId && S.maps.find((m) => m.id === ws.lastMapId)?.id) || S.maps[0].id;
  S.selectedId = currentMap().root.id;
  S.ready = true;
  renderAll({ resetView: true });

  if (ws.broken && ws.broken.length) {
    toast(`${ws.broken.length} 张导图未能解密，已跳过`, { type: 'error', duration: 6000 });
  }
  if (ws.rebuilt && S.maps.length > 1) {
    toast('已根据本地数据重建导图列表', { type: 'ok' });
  }
  requestPersistence();
  startAutoLock();
  if (S.settings.tipDismissed) $('#stageTip').hidden = true;
  updateUsage();
}

async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch {
    /* 忽略 */
  }
}

/* ============================================================
   欢迎导图 / 主题
   ============================================================ */

function buildWelcomeMap() {
  const map = createMap('欢迎使用一念');
  const root = map.root;
  root.note = `**这是你的本地思维空间。**\n\n所有内容只保存在当前浏览器中，并用密码加密。`;

  const a = addNode(
    root,
    createNode({
      title: '快速开始',
      note: '上手只需要记住三个键：\n\n- `Tab` 添加子节点\n- `Enter` 添加同级节点\n- `⌘K` 搜索一切\n\n拖拽节点可以改变从属关系。',
    }),
  );
  addNode(a, createNode({ title: '双击节点编辑文字' }));
  addNode(a, createNode({ title: '拖拽节点调整结构' }));
  addNode(a, createNode({ title: '⌘Z 撤销，⇧⌘Z 重做' }));

  const b = addNode(
    root,
    createNode({
      title: '节点能装什么',
      note: '节点不只是标题。它可以承载：\n\n1. Markdown 笔记\n2. 图片与视频（本地上传）\n3. 普通链接与参考资料\n4. 标签与颜色标记',
    }),
  );
  b.attachments.push(
    createAttachment({
      kind: 'link',
      title: 'Markdown 语法速查',
      url: 'https://commonmark.org/help/',
      note: '笔记区支持常用 Markdown 语法。',
    }),
  );
  addNode(b, createNode({ title: '笔记（支持 Markdown）' }));
  addNode(b, createNode({ title: '图片 / 视频预览' }));
  addNode(b, createNode({ title: '链接与参考资料' }));

  const c = addNode(
    root,
    createNode({
      title: '数据属于你',
      note: '导出为 JSON 后，可以自由备份、迁移、再导入。\n\n任意节点都能连同全部下级一起导出。',
    }),
  );
  addNode(c, createNode({ title: '导出任意节点子树' }));
  addNode(c, createNode({ title: '导入 JSON 继续编辑' }));
  addNode(c, createNode({ title: '全量备份与恢复' }));

  const d = addNode(
    root,
    createNode({
      title: '一个建议',
      note: '先随手记录，再慢慢整理。结构会随着思考自然长出来。',
      color: '#2E9E8F',
    }),
  );
  addNode(d, createNode({ title: '把这张欢迎导图改成你自己的' }));

  root.children.forEach((child) => {
    if (child.children.length > 0 && child.children.length <= 3) child.collapsed = false;
  });
  return map;
}

function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
}

/* ============================================================
   视图渲染
   ============================================================ */

let canvas = null;
let inspector = null;

function currentMap() {
  return S.maps.find((m) => m.id === S.currentMapId) || null;
}

function currentNode() {
  const map = currentMap();
  if (!map || !S.selectedId) return null;
  return locate(map.root, S.selectedId)?.node || null;
}

function nodeById(id) {
  const map = currentMap();
  return map ? locate(map.root, id)?.node || null : null;
}

function renderAll(opts = {}) {
  const map = currentMap();
  if (!map) return;
  const known = S.selectedId && locate(map.root, S.selectedId) ? S.selectedId : map.root.id;
  S.selectedId = known;

  syncEpisodeCounts(map.root);
  renderMapTitle();
  renderSidebar();
  canvas.render(map, {
    selectedId: S.selectedId,
    focusMode: S.settings.focusMode,
    resetView: !!opts.resetView,
  });
  renderInspector(!!opts.inspectorForce);
  renderRulePanel();
  updateUndoRedo();
  updateUsage();
  $('#stageEmpty').hidden = true;
}

/** 集数永远等于真实子节点数：结构变化后统一对齐一次（含手动增删） */
function syncEpisodeCounts(root) {
  const walk = (node) => {
    syncEpisodeField(node, S.settings.customRules);
    (node.children || []).forEach(walk);
  };
  if (root) walk(root);
}

function renderMapTitle() {
  const map = currentMap();
  const input = $('#mapTitle');
  if (input && document.activeElement !== input) input.value = map ? map.title : '';
  document.title = map ? `${map.title} · 一念` : '一念';
}

function renderSidebar() {
  $('#mapCount').textContent = `${S.maps.length} 张导图`;
  const list = $('#mapList');
  list.innerHTML = S.maps
    .map((m) => {
      const active = m.id === S.currentMapId;
      return `<div class="map-item${active ? ' is-active' : ''}" data-id="${m.id}" role="button" tabindex="0">
        <span class="mi-text">
          <span class="mi-title">${escapeHtml(m.title || '未命名导图')}</span>
          <span class="mi-meta">${countNodes(m.root)} 个节点 · ${formatDate(m.updatedAt).slice(5, 16)}</span>
        </span>
        <span class="mi-actions">
          <button class="icon-btn small" data-act="map-menu" data-id="${m.id}" title="更多">${icon('more')}</button>
        </span>
      </div>`;
    })
    .join('');

  renderOutline();
  renderRecent();

  const activeItem = list.querySelector('.map-item.is-active');
  if (activeItem) activeItem.scrollIntoView({ block: 'nearest' });
}

function renderOutline() {
  const map = currentMap();
  const box = $('#outlineList');
  if (!map) {
    box.innerHTML = '';
    return;
  }
  const rows = [];
  let budget = 400;
  const step = (node, depth) => {
    if (budget <= 0) return;
    budget -= 1;
    const hasKids = node.children && node.children.length;
    const active = node.id === S.selectedId;
    rows.push(`<div class="outline-row${active ? ' is-active' : ''}" data-id="${node.id}" style="padding-left:${
      4 + depth * 13
    }px">
      <button class="outline-toggle" data-toggle="${node.id}" title="${node.collapsed ? '展开' : '折叠'}">${
        hasKids ? icon(node.collapsed ? 'chevronRight' : 'chevronDown') : ''
      }</button>
      <span class="ol-title">${escapeHtml(node.title)}</span>
    </div>`);
    if (!node.collapsed) node.children.forEach((c) => step(c, depth + 1));
  };
  step(map.root, 0);
  box.innerHTML = rows.join('');
}

function renderRecent() {
  const box = $('#recentList');
  const sorted = [...S.maps].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  box.innerHTML = sorted
    .map(
      (m) => `<div class="recent-row" data-id="${m.id}">
        <span class="rr-title">${escapeHtml(m.title || '未命名导图')}</span>
        <span class="rr-time">${escapeHtml(formatDate(m.updatedAt).slice(5, 16))}</span>
      </div>`,
    )
    .join('') || '<div class="search-empty">还没有导图</div>';
}

function renderInspector(force = false) {
  const node = currentNode();
  const map = currentMap();
  if (!node) {
    inspector.render(null);
    return;
  }
  const trail = pathTo(map.root, node.id).map((n) => n.title);
  const crumb = trail.length > 3 ? `… / ${trail.slice(-2).join(' / ')}` : trail.join(' / ');
  inspector.render(node, {
    force,
    crumb,
    isRoot: node.id === map.root.id,
    mapTitle: map.title,
    rule: resolveRule(map.root, node.id, S.settings.customRules),
    downRule: resolveDownRule(node, S.settings.customRules),
  });
}

function updateUndoRedo() {
  $('#btnUndo').disabled = S.history.undo.length === 0;
  $('#btnRedo').disabled = S.history.redo.length === 0;
}

function setSaveState(state) {
  S.saveState = state;
  const el = $('#saveState');
  if (!el) return;
  el.className = 'save-state';
  if (state === 'dirty') {
    el.textContent = '未保存';
    el.classList.add('is-dirty');
  } else if (state === 'saving') {
    el.textContent = '保存中…';
  } else {
    el.textContent = `已保存 ${formatTime()}`;
    el.classList.add('is-saved');
  }
}

async function updateUsage() {
  const el = $('#usageInfo');
  if (!el) return;
  const map = currentMap();
  const usage = await S.store.usage();
  const nodes = map ? countNodes(map.root) : 0;
  const used = usage ? byteSize(usage.usage || 0) : '—';
  el.innerHTML = `<span>${nodes} 个节点</span><span>本地占用 ${escapeHtml(used)}</span>`;
}

/* ============================================================
   保存与历史
   ============================================================ */

async function persistNow() {
  const map = currentMap();
  if (!map || !S.store.unlocked) return;
  setSaveState('saving');
  try {
    await S.store.saveMap(map);
    await S.store.saveWorkspace({
      maps: S.maps,
      settings: S.settings,
      lastMapId: S.currentMapId,
    });
    setSaveState('saved');
  } catch (err) {
    console.error(err);
    setSaveState('dirty');
    toast(`保存失败：${err.message}`, { type: 'error' });
  }
}

const saveDebounced = debounce(persistNow, AUTOSAVE_DELAY);

function scheduleSave({ immediate = false } = {}) {
  setSaveState('dirty');
  if (immediate) {
    saveDebounced.cancel();
    return persistNow();
  }
  return saveDebounced();
}

async function flushNow() {
  saveDebounced.cancel();
  await persistNow();
}

function snapshotOf(map) {
  return JSON.stringify({ title: map.title, root: map.root });
}

function pushHistory(key = null, { coalesceMs = 900 } = {}) {
  const map = currentMap();
  if (!map) return;
  const now = Date.now();
  if (key && S.history.lastKey === key && now - S.history.lastAt < coalesceMs) {
    S.history.lastAt = now;
    return;
  }
  S.history.undo.push(snapshotOf(map));
  if (S.history.undo.length > 60) S.history.undo.shift();
  S.history.redo.length = 0;
  S.history.lastKey = key;
  S.history.lastAt = now;
  updateUndoRedo();
}

function applySnapshot(text) {
  const map = currentMap();
  if (!map) return;
  try {
    const data = JSON.parse(text);
    map.title = data.title;
    map.root = data.root;
    map.updatedAt = nowISO();
    if (!locate(map.root, S.selectedId)) S.selectedId = map.root.id;
    renderAll();
    scheduleSave({ immediate: true });
  } catch (err) {
    toast('历史快照已损坏', { type: 'error' });
  }
}

function undo() {
  if (!S.history.undo.length) return;
  const map = currentMap();
  S.history.redo.push(snapshotOf(map));
  const prev = S.history.undo.pop();
  S.history.lastKey = null;
  applySnapshot(prev);
  updateUndoRedo();
  toast('已撤销');
}

function redo() {
  if (!S.history.redo.length) return;
  const map = currentMap();
  S.history.undo.push(snapshotOf(map));
  const next = S.history.redo.pop();
  S.history.lastKey = null;
  applySnapshot(next);
  updateUndoRedo();
  toast('已重做');
}

/** 统一的修改入口：记录历史 → 修改 → 重渲染 → 保存 */
function mutate(fn, opts = {}) {
  const map = currentMap();
  if (!map) return;
  if (opts.history !== false) pushHistory(opts.historyKey || null, opts);
  const result = fn(map);
  map.updatedAt = nowISO();
  renderAll({ inspectorForce: opts.inspectorForce, resetView: opts.resetView });
  scheduleSave();
  return result;
}

/* ============================================================
   节点操作
   ============================================================ */

function selectNode(id, { center = false, openInspector = false } = {}) {
  if (!id) return;
  S.selectedId = id;
  const map = currentMap();
  if (map) {
    canvas.render(map, { selectedId: id, focusMode: S.settings.focusMode });
    if (center) canvas.centerOn(id);
  }
  renderInspector();
  renderRulePanel();
  renderOutline();
  if (openInspector || window.innerWidth <= 760) {
    $('#shell').classList.add('inspector-open');
  }
}

function addChild(parentId, { startEdit = true } = {}) {
  const map = currentMap();
  const parent = parentId ? nodeById(parentId) : currentNode() || map.root;
  if (!parent) return;
  const node = createNode({ title: '新节点' });
  mutate(() => {
    addNode(parent, node);
  });
  S.selectedId = node.id;
  S.freshNodeId = node.id;
  renderAll();
  setTimeout(() => {
    canvas.startEdit(node.id);
  }, 20);
  void startEdit;
}

function addSibling(id) {
  const map = currentMap();
  const hit = locate(map.root, id);
  if (!hit || !hit.parent) {
    addChild(id);
    return;
  }
  const node = createNode({ title: '新节点' });
  mutate(() => {
    addNode(hit.parent, node, hit.index + 1);
  });
  S.selectedId = node.id;
  S.freshNodeId = node.id;
  renderAll();
  setTimeout(() => canvas.startEdit(node.id), 20);
}

function deleteNodeById(id) {
  const map = currentMap();
  if (!map || id === map.root.id) {
    toast('根节点不能删除', { type: 'error' });
    return;
  }
  const hit = locate(map.root, id);
  if (!hit) return;
  const childCount = (hit.node.children || []).length;
  const doDelete = () => {
    const parentId = hit.parent.id;
    mutate(() => removeNode(map.root, id));
    S.selectedId = parentId;
    renderAll({ inspectorForce: true });
    toast('节点已删除，可 ⌘Z 撤销');
  };
  if (childCount > 0) {
    confirmDialog({
      title: '删除节点',
      message: `「${escapeHtml(hit.node.title)}」下还有 <b>${childCount}</b> 个直属节点，将一并删除（可撤销）。`,
      confirmText: '删除',
      danger: true,
    }).then((ok) => ok && doDelete());
  } else {
    doDelete();
  }
}

function duplicateNodeById(id) {
  const map = currentMap();
  const hit = locate(map.root, id);
  if (!hit) return;
  const copy = cloneSubtree(hit.node);
  mutate(() => {
    insertNode(hit.parent || map.root, copy, hit.index + 1);
  });
  S.selectedId = copy.id;
  renderAll();
  toast('已复制该子树', { type: 'ok' });
}

function toggleCollapse(id) {
  const node = nodeById(id);
  if (!node || !node.children.length) return;
  mutate(() => {
    node.collapsed = !node.collapsed;
    touch(node);
  });
}

function setNodeColor(id, color) {
  mutate(
    () => {
      const node = nodeById(id);
      node.color = color;
      touch(node);
    },
    { historyKey: `color:${id}` },
  );
}

function handleDrop(dragId, targetId, intent) {
  const map = currentMap();
  if (!map) return;
  const target = locate(map.root, targetId);
  if (!target) return;
  let parentId = targetId;
  let index = -1;
  if (intent === 'before' || intent === 'after') {
    parentId = target.parent ? target.parent.id : map.root.id;
    index = intent === 'before' ? target.index : target.index + 1;
  }
  const res = moveNode(map.root, dragId, parentId, index);
  if (!res.ok) {
    toast(res.reason, { type: 'error' });
    return;
  }
  S.selectedId = dragId;
  mutate(() => {}, { history: false });
}

/* ============================================================
   画布初始化
   ============================================================ */

function initCanvas() {
  canvas = new CanvasView({
    stage: $('#stage'),
    world: $('#world'),
    nodesLayer: $('#nodes'),
    edgeLayer: $('#edgeLayer'),
    hooks: {
      onSelect: (id) => {
        S.selectedId = id;
        renderInspector();
        renderOutline();
      },
      onToggleCollapse: (id) => toggleCollapse(id),
      onTitleCommit: (id, text, meta) => {
        const node = nodeById(id);
        if (!node) return;
        const next = text || node.title;
        const isFresh = S.freshNodeId === id;
        if (isFresh) S.freshNodeId = null;
        if (next !== node.title) {
          mutate(
            () => {
              node.title = next;
              touch(node);
            },
            // 刚创建的节点：改名并入创建那条历史，撤销一次即可回到创建前
            { historyKey: `title:${id}`, history: !isFresh },
          );
        } else {
          renderAll();
        }
        if (meta && meta.thenAddChild) addChild(id);
      },
      onEditCancel: () => renderAll(),
      onDrop: (dragId, targetId, intent) => handleDrop(dragId, targetId, intent),
      onDropOut: (dragId) => detachToNewMap(dragId),
      onCanvasDblClick: () => {
        const target = S.selectedId || (currentMap() && currentMap().root.id);
        addChild(target);
      },
      onContextMenu: (id, event) => showNodeMenu(id, event),
      onViewChange: (view) => {
        $('#zoomLabel').textContent = `${Math.round(view.k * 100)}%`;
      },
    },
  });

  inspector = createInspector({
    bodyEl: $('#inspectorBody'),
    crumbEl: $('#inspectorCrumb'),
    hooks: {
      updateNode: (id, patch, opts = {}) => {
        const node = nodeById(id);
        if (!node) return;
        mutate(
          () => {
            Object.assign(node, patch);
            touch(node);
          },
          { historyKey: `edit:${id}:${Object.keys(patch).join(',')}`, inspectorForce: !!opts.force },
        );
      },
      deleteNode: (id) => deleteNodeById(id),
      exportNode: (id) => {
        S.selectedId = id;
        openExportDialog({ range: 'node' });
      },
      copyOutline: (id) => {
        const node = nodeById(id);
        copyText(outlineText(node), '大纲已复制');
      },
      addChild: (id) => addChild(id),
      pickMedia: (id) => pickMediaForNode(id),
      addLinkDialog: (id) => openLinkDialog(id),
      openAttachment: (att) => openAttachment(att),
      removeAttachment: (nodeId, attId) => {
        mutate(() => {
          const node = nodeById(nodeId);
          node.attachments = (node.attachments || []).filter((a) => a.id !== attId);
          touch(node);
        }, { inspectorForce: true });
      },
      mediaUrl: (mediaId) => getMediaUrl(mediaId),
      copyText: (text, msg) => copyText(text, msg),
      renderFields: (node, ctx, host) => {
        if (!host) return;
        const rule = ctx.rule;
        // 内容字段与「子节点 / 集数」各自占用一个容器，避免互相覆盖
        host.innerHTML =
          '<div data-role="fields-slot"></div><div data-role="episodes-slot"></div>';
        const fieldsSlot = host.querySelector('[data-role="fields-slot"]');
        const episodesSlot = host.querySelector('[data-role="episodes-slot"]');
        host.hidden = false;
        const editor = createFieldEditor({
          container: fieldsSlot,
          hooks: {
            updateField: (id, field, value) => {
              const target = nodeById(id);
              if (!target) return;
              applyRuleEdit(target, () => writeField(target, field, value), `rule:${id}:${field.key}`);
            },
            updateData: (id, patch) => {
              const target = nodeById(id);
              if (!target) return;
              mutate(
                () => {
                  target.data = { ...(target.data || {}), ...patch };
                  touch(target);
                },
                { historyKey: `ruledata:${id}`, inspectorForce: true },
              );
            },
            pickMedia: () => pickMediaFile(),
            mediaUrl: (mediaId) => getMediaUrl(mediaId),
            openLightbox: (src, caption) => {
              const img = new Image();
              img.src = src;
              openLightbox(img, caption || '');
            },
            addAttachment: (id) => openLinkDialog(id),
            setEpisodes: (id, field, want) => setEpisodes(id, field, want),
          },
        });
        if (rule) editor.render(node, rule.template, { locked: false });
        else {
          fieldsSlot.innerHTML = '';
        }
        editor.renderEpisodes(episodesSlot, node, ctx.downRule ? ctx.downRule.template : null);
        host.hidden = !fieldsSlot.childElementCount && !episodesSlot.childElementCount;
      },
      openRule: (id) => {
        if (id && id !== S.selectedId) selectNode(id);
        toggleRulePanel(true);
      },
    },
  });
}

/* ============================================================
   规则层（左侧属性面板）
   ============================================================ */

function renderRulePanel() {
  if (!rulePanel) return;
  const map = currentMap();
  const node = currentNode();
  if (!map || !node) {
    rulePanel.setNode(null, null);
    return;
  }
  rulePanel.setNode(
    node,
    resolveDownRule(node, S.settings.customRules),
    resolveRule(map.root, node.id, S.settings.customRules),
  );
}

/** 集数：只补差额，不重建；填更小的数字不会删除已有子节点 */
function setEpisodes(id, field, want) {
  const node = nodeById(id);
  if (!node) return;
  const cur = (node.children || []).length;
  const target = Math.max(0, Math.min(999, Math.floor(Number(want) || 0)));
  if (target === cur) {
    toast(`当前就是 ${cur} 集，无需生成`);
    renderAll({ inspectorForce: true });
    return;
  }
  if (target < cur) {
    toast(`不会删除已有子节点：当前 ${cur} 集，已按实际数量记录`, { type: 'error' });
    renderAll({ inspectorForce: true });
    return;
  }
  const added = [];
  mutate(
    () => {
      added.push(...generateEpisodes(node, target));
      node.data = { ...(node.data || {}), [field.key]: (node.children || []).length };
      touch(node);
    },
    { historyKey: `episodes:${id}` },
  );
  renderAll({ inspectorForce: true });
  toast(`已补齐 ${added.length} 集（第 ${cur + 1}–${target} 集），共 ${target} 集；⌘Z 可整体撤销`, {
    type: 'ok',
    duration: 5000,
  });
}

/** 应用规则 JSON：内置模板会被复制成自定义模板，避免改动所有使用者 */
async function applyRuleJson(id, raw) {
  const node = nodeById(id);
  if (!node) return;
  const tpl = normalizeRuleTemplate(raw);
  const list = allRules(S.settings.customRules);
  const builtin = list.find((r) => r.id === tpl.id && !r.custom);
  let targetId = tpl.id;
  let note = '';

  if (builtin) {
    let n = 1;
    targetId = `${tpl.id}-custom`;
    while (list.some((r) => r.id === targetId)) {
      n += 1;
      targetId = `${tpl.id}-custom${n}`;
    }
    tpl.id = targetId;
    // 名字没改才加「副本」；用户已经改名就尊重他起的名字
    if (tpl.name === builtin.name) tpl.name = `${tpl.name}（副本）`;
    S.settings.customRules.push(tpl);
    note = `内置模板不会被改动，已复制成「${tpl.name}」`;
  } else {
    const existing = S.settings.customRules.find((r) => r.id === tpl.id);
    if (existing) {
      const users = ruleUsage(tpl.id);
      if (users > 1) {
        const ok = await confirmDialog({
          title: '这个规则已被多个节点使用',
          message: `当前有 <b>${users}</b> 个节点使用「${escapeHtml(
            existing.name,
          )}」，修改会同时影响它们。<br>只想改这一个节点，请改 JSON 里的 <code>id</code> 再应用。`,
          confirmText: '仍然修改',
        });
        if (!ok) return;
      }
      Object.assign(existing, tpl);
    } else {
      S.settings.customRules.push(tpl);
    }
  }

  Object.assign(tpl, { custom: true });
  mutate(
    () => {
      node.rule = { template: targetId, updatedAt: nowISO() };
      touch(node);
    },
    { inspectorForce: true },
  );
  scheduleSave({ immediate: true });
  toast(`规则已应用${note ? `，${note}` : ''}`, { type: 'ok', duration: 5000 });
}

function ruleUsage(templateId) {
  let n = 0;
  const walk = (node) => {
    if (node.rule && node.rule.template === templateId) n += 1;
    (node.children || []).forEach(walk);
  };
  for (const m of S.maps) walk(m.root);
  return n;
}

/** 只改数据、只重绘画布，避免左侧输入时被整体重渲染打断 */
function applyRuleEdit(node, fn, historyKey) {
  const map = currentMap();
  if (!map) return;
  pushHistory(historyKey);
  fn();
  touch(node);
  map.updatedAt = nowISO();
  canvas.render(map, { selectedId: S.selectedId, focusMode: S.settings.focusMode });
  scheduleSave();
}

function toggleRulePanel(force) {
  if (!rulePanel) return;
  const next = typeof force === 'boolean' ? force : !rulePanel.isOpen();
  if (next && !currentNode()) {
    const map = currentMap();
    if (map) {
      S.selectedId = map.root.id;
      renderAll();
    }
  }
  if (next) renderRulePanel();
  rulePanel.setOpen(next);
  $('#btnRuleToggle').classList.toggle('is-active', next);
}

function toggleInspector(force) {
  const shell = $('#shell');
  const collapsed = shell.classList.contains('inspector-collapsed');
  const show = typeof force === 'boolean' ? force : collapsed;
  shell.classList.toggle('inspector-collapsed', !show);
  shell.classList.toggle('inspector-open', show);
  $('#btnInspectorToggle').classList.toggle('is-active', show);
}

function pickMediaFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async () => {
      const file = (input.files || [])[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        const rec = await S.store.putMedia(file, { name: file.name });
        resolve({ id: rec.id, mime: rec.mime, name: rec.name });
      } catch (err) {
        toast(`写入失败：${err.message}`, { type: 'error' });
        resolve(null);
      }
    });
    input.click();
  });
}

function initRulePanel() {
  const el = $('#rulebar');
  if (!el) return;
  rulePanel = createRulePanel({
    el,
    hooks: {
      rules: () => allRules(S.settings.customRules),
      customRules: () => S.settings.customRules,
      updateField: (id, field, value) => {
        const node = nodeById(id);
        if (!node) return;
        applyRuleEdit(node, () => writeField(node, field, value), `rule:${id}:${field.key}`);
      },
      updateData: (id, patch) => {
        const node = nodeById(id);
        if (!node) return;
        mutate(
          () => {
            node.data = { ...(node.data || {}), ...patch };
            touch(node);
          },
          { historyKey: `ruledata:${id}` },
        );
      },
      setTemplate: async (id, templateId) => {
        const node = nodeById(id);
        if (!node) return;
        const kids = (node.children || []).length;
        if (kids > 0) {
          const tpl = allRules(S.settings.customRules).find((r) => r.id === templateId);
          const ok = await confirmDialog({
            title: '修改规则会影响子节点',
            message: `「${escapeHtml(node.title)}」下已有 <b>${kids}</b> 个子节点，它们都会改用「${escapeHtml(
              tpl ? tpl.name : templateId,
            )}」规则。<br>已有内容不会删除，但不再符合新规则的字段会被保留为未使用数据。`,
            confirmText: '确认修改',
          });
          if (!ok) {
            renderRulePanel();
            return;
          }
        }
        mutate(
          () => {
            node.rule = { template: templateId, updatedAt: nowISO() };
            touch(node);
          },
          { inspectorForce: true },
        );
        const tpl = allRules(S.settings.customRules).find((r) => r.id === templateId);
        toast(`规则已切换为「${tpl ? tpl.name : templateId}」，其下级节点一起继承`, { type: 'ok' });
      },
      pickMedia: () => pickMediaFile(),
      mediaUrl: (mediaId) => getMediaUrl(mediaId),
      openLightbox: (src, caption) => {
        const img = new Image();
        img.src = src;
        openLightbox(img, caption || '');
      },
      copyText: (text, msg) => copyText(text, msg),
      addAttachment: (id) => openLinkDialog(id),
      openNodeJson: (id, mode) => openNodeJsonDialog(id, mode),
      applyRuleJson: (id, raw) => applyRuleJson(id, raw),
      addCustomRule: (raw) => {
        const tpl = normalizeRuleTemplate(raw);
        if (allRules(S.settings.customRules).some((r) => r.id === tpl.id)) {
          throw new RuleError(`模板 id 已存在：${tpl.id}`);
        }
        S.settings.customRules.push(tpl);
        const node = currentNode();
        if (node) {
          mutate(() => {
            node.rule = { template: tpl.id };
            touch(node);
          });
        }
        scheduleSave({ immediate: true });
        toast(`已导入模板「${tpl.name}」，可在这里填写`, { type: 'ok' });
        if (node) renderAll();
      },
      onToggle: (isOpen) => $('#btnRuleToggle').classList.toggle('is-active', isOpen),
    },
  });
}

/* ---------------- 节点 JSON：临时模态框（可编辑 / 一键复制 / 导入） ---------------- */

async function openNodeJsonDialog(nodeId, mode = 'export') {
  const node = nodeById(nodeId);
  if (!node) {
    toast('请先选择一个节点', { type: 'error' });
    return;
  }
  const mediaMap = await collectMediaData(node);
  const payload = buildNodeExport(node, { resolveMedia: (id) => mediaMap.get(id) || null });
  const text = JSON.stringify(payload, null, 2);

  const { modal, close } = openModal({
    title: mode === 'import' ? `导入 JSON 到「${node.title}」` : `导出「${node.title}」` ,
    wide: true,
    body: `
      <p class="form-hint">这是当前节点及其完整下级的 JSON（含规则与字段值）。可以直接复制走，
      也可以就地修改后点「导入到当前节点」，用改过的内容替换这个节点。</p>
      <textarea class="json-area" id="nodeJsonText" rows="16" spellcheck="false">${escapeHtml(text)}</textarea>
      <p class="form-hint" id="nodeJsonHint">${countNodes(node)} 个节点 · ${byteSize(new Blob([text]).size)}</p>`,
    footer: `<button class="btn" data-close>取消</button>
      <button class="btn" data-copy>一键复制</button>
      <button class="btn btn-primary" data-ok>确定并导入</button>`,
  });

  if (mode === 'import') {
    modal.querySelector('#nodeJsonText').focus();
    modal.querySelector('#nodeJsonText').select();
  }

  modal.querySelector('[data-copy]').addEventListener('click', () => {
    copyText(modal.querySelector('#nodeJsonText').value, '已复制到剪贴板');
  });

  modal.querySelector('[data-ok]').addEventListener('click', async () => {
    const raw = modal.querySelector('#nodeJsonText').value;
    let parsed;
    try {
      parsed = parseImportText(raw);
    } catch (err) {
      toast(`无法解析：${err.message}`, { type: 'error' });
      return;
    }
    try {
      const media = await adoptImportedMedia(parsed.node, parsed.media || {}, (blob, info) =>
        S.store.putMedia(blob, info),
      );
      const target = nodeById(nodeId);
      if (!target) return;
      pushHistory();
      const src = parsed.node;
      target.title = src.title;
      target.note = src.note;
      target.tags = src.tags;
      target.color = src.color;
      target.attachments = src.attachments;
      target.rule = src.rule;
      target.data = src.data;
      target.children = src.children;
      touch(target);
      renderAll({ inspectorForce: true });
      scheduleSave({ immediate: true });
      close();
      toast(
        `已导入 ${countNodes(target)} 个节点${media.missing && media.missing.length ? `，${media.missing.length} 个媒体缺失` : ''}`,
        { type: 'ok' },
      );
    } catch (err) {
      console.error(err);
      toast(`导入失败：${err.message}`, { type: 'error' });
    }
  });
}

/* ---------------- SVG 查看与导出 ---------------- */

function svgScopeNode() {
  const map = currentMap();
  if (!map) return null;
  const node = currentNode();
  return node && node.id !== map.root.id ? node : map.root;
}

function openSvgDialog() {
  const map = currentMap();
  const scope = svgScopeNode();
  if (!map || !scope) return;
  const dark = S.settings.theme === 'dark';
  const { svg, width, height } = buildSvg(scope, { dark, title: scope.title });
  const blobUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const isWhole = scope.id === map.root.id;
  const { modal, close } = openModal({
    title: 'SVG 预览',
    wide: true,
    body: `<div class="svg-wrap"><div class="svg-frame" id="svgFrame">${svg}</div></div>
      <p class="form-hint">${isWhole ? '整张导图' : `节点「${escapeHtml(scope.title)}」及其下级`} ·
      ${width} × ${height} · 矢量图，放大不会糊，可直接放进文档或设计工具</p>`,
    footer: `<button class="btn" data-close>关闭</button>
      <button class="btn" data-new>新窗口打开</button>
      <button class="btn btn-primary" data-save>导出 SVG</button>`,
  });
  const cleanup = () => {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    close();
  };
  modal.querySelector('[data-new]').addEventListener('click', () => {
    window.open(blobUrl, '_blank');
  });
  modal.querySelector('[data-save]').addEventListener('click', () => {
    download(svgFileName(scope.title), svg, 'image/svg+xml');
    toast('SVG 已导出', { type: 'ok' });
    void cleanup;
  });
}

async function exportAuthKeyFile() {
  if (S.fixedAuth) {
    toast('本页的访问密码由提供者固定，无需分发密钥文件', { type: 'error' });
    return;
  }
  try {
    const cfg = await S.store.exportAuthConfig();
    download('auth.json', JSON.stringify(cfg, null, 2));
    toast('访问密钥文件已导出，可交给使用者导入', { type: 'ok', duration: 5000 });
  } catch (err) {
    toast(`导出失败：${err.message}`, { type: 'error' });
  }
}

function exportSvgFile() {
  const scope = svgScopeNode();
  if (!scope) return;
  const { svg } = buildSvg(scope, { dark: S.settings.theme === 'dark', title: scope.title });
  download(svgFileName(scope.title), svg, 'image/svg+xml');
  toast('SVG 已导出', { type: 'ok' });
}

/* ---------------- 拖到空白处：分离为独立导图的根节点 ---------------- */

function detachToNewMap(id) {
  const map = currentMap();
  if (!map || id === map.root.id) return;
  const hit = locate(map.root, id);
  if (!hit || !hit.parent) return;
  confirmDialog({
    title: '分离为独立导图',
    message: `把「${escapeHtml(hit.node.title)}」从当前导图分离，成为一张新导图的根节点。<br>它的内容、规则、媒体与下级节点都会完整保留。`,
    confirmText: '分离',
  }).then((ok) => {
    if (!ok) return;
    pushHistory();
    const carried = resolveRule(map.root, id, S.settings.customRules);
    const node = removeNode(map.root, id);
    if (!node) return;
    if (carried && carried.inherited) {
      node.ruleInherited = {
        template: carried.template.id,
        from: carried.sourceId || null,
        fromTitle: carried.sourceTitle || null,
        at: nowISO(),
        version: 1,
      };
    }
    const newMap = createMap(node.title || '独立导图');
    newMap.root = node;
    S.maps.push(newMap);
    S.store.saveMap(newMap).catch((err) => console.error(err));
    S.selectedId = map.root.id;
    renderAll();
    scheduleSave({ immediate: true });
    toast(`已分离为独立导图「${newMap.title}」，可在左侧导图列表打开`, { type: 'ok', duration: 5000 });
  });
}

/* ============================================================
   媒体
   ============================================================ */

async function getMediaUrl(mediaId) {
  if (!mediaId) return null;
  if (S.mediaUrls.has(mediaId)) return S.mediaUrls.get(mediaId);
  try {
    const blob = await S.store.getMediaBlob(mediaId);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    S.mediaUrls.set(mediaId, url);
    return url;
  } catch (err) {
    console.error('读取媒体失败', err);
    return null;
  }
}

function revokeMediaUrls() {
  for (const url of S.mediaUrls.values()) URL.revokeObjectURL(url);
  S.mediaUrls.clear();
}

async function pickMediaForNode(nodeId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,video/*';
  input.multiple = true;
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    await addFilesToNode(nodeId, files);
  });
  input.click();
}

async function addFilesToNode(nodeId, files) {
  const node = nodeById(nodeId);
  if (!node) return;
  const accepted = files.filter((f) => /^(image|video)\//.test(f.type));
  const rejected = files.length - accepted.length;
  if (!accepted.length) {
    toast('仅支持图片或视频文件', { type: 'error' });
    return;
  }
  const big = accepted.find((f) => f.size > 40 * 1024 * 1024);
  if (big) {
    toast(`「${big.name}」超过 40MB，可能影响性能`, { type: 'error', duration: 4000 });
  }
  pushHistory();
  const t = toast('正在写入本地存储…', { duration: 60000 });
  try {
    for (const file of accepted) {
      const rec = await S.store.putMedia(file, { name: file.name });
      node.attachments = node.attachments || [];
      node.attachments.push(
        createAttachment({
          kind: file.type.startsWith('image/') ? 'image' : 'video',
          title: file.name.replace(/\.[^.]+$/, ''),
          mediaId: rec.id,
          mime: rec.mime,
          size: rec.size,
          name: rec.name,
        }),
      );
    }
    touch(node);
    renderAll({ inspectorForce: true });
    scheduleSave();
    toast(`已添加 ${accepted.length} 个媒体文件`, { type: 'ok' });
    if (rejected) toast(`${rejected} 个非图片/视频文件已跳过`, { type: 'error' });
  } catch (err) {
    console.error(err);
    toast(`写入失败：${err.message}`, { type: 'error' });
  } finally {
    if (t && t.remove) t.remove();
    $$('#toasts .toast').forEach((el) => {
      if (el.textContent.includes('正在写入')) el.remove();
    });
  }
}

function openLinkDialog(nodeId) {
  const { modal, close } = openModal({
    title: '添加链接 / 参考资料',
    body: linkFormHTML('link'),
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" data-ok>添加</button>`,
  });
  modal.querySelectorAll('.radio-item input').forEach((radio) => {
    radio.addEventListener('change', () => {
      modal.querySelectorAll('.radio-item').forEach((item) => {
        item.classList.toggle('is-active', item.querySelector('input').checked);
      });
    });
  });
  const submit = () => {
    const data = readLinkForm(modal);
    if (!data.url) {
      toast('请填写链接地址', { type: 'error' });
      return;
    }
    if (!/^https?:\/\//i.test(data.url)) {
      toast('链接必须以 http:// 或 https:// 开头', { type: 'error' });
      return;
    }
    mutate(
      () => {
        const node = nodeById(nodeId);
        node.attachments = node.attachments || [];
        node.attachments.push(
          createAttachment({
            kind: data.kind,
            title: data.title || data.url.replace(/^https?:\/\//, '').slice(0, 60),
            url: data.url,
            note: data.note,
          }),
        );
        touch(node);
      },
      { inspectorForce: true },
    );
    close();
    toast('已添加', { type: 'ok' });
  };
  modal.querySelector('[data-ok]').addEventListener('click', submit);
  modal.querySelectorAll('input,textarea').forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
    });
  });
  const urlInput = modal.querySelector('[data-role="att-url"]');
  if (urlInput) urlInput.focus();
}

async function openAttachment(att) {
  if (att.mediaId) {
    const url = await getMediaUrl(att.mediaId);
    if (!url) {
      toast('媒体文件缺失', { type: 'error' });
      return;
    }
    if (att.kind === 'image') {
      const img = document.createElement('img');
      img.src = url;
      img.alt = att.title || '';
      openLightbox(img, att.title || att.name || '');
    } else {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.autoplay = true;
      openLightbox(video, att.title || att.name || '');
    }
    return;
  }
  if (att.url) {
    if (/^https?:\/\//i.test(att.url)) {
      window.open(att.url, '_blank', 'noopener,noreferrer');
    } else {
      toast('无效的链接地址', { type: 'error' });
    }
    return;
  }
  toast('该附件没有可预览的内容', { type: 'error' });
}

/* ============================================================
   剪贴板
   ============================================================ */

async function copyText(text, message = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message, { type: 'ok' });
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(message, { type: 'ok' });
    } catch {
      toast('复制失败，请手动选择文本', { type: 'error' });
    }
    ta.remove();
  }
}

/* ============================================================
   搜索
   ============================================================ */

const runSearch = debounce(() => {
  const q = $('#searchInput').value.trim();
  S.search.query = q;
  const panel = $('#searchPanel');
  $('#searchBox').classList.toggle('has-value', !!q);
  if (!q) {
    panel.hidden = true;
    S.search.results = [];
    return;
  }
  const results = [];
  for (const map of S.maps) {
    const hits = findMatches(map.root, q, 40);
    for (const hit of hits) {
      results.push({ ...hit, mapId: map.id, mapTitle: map.title });
    }
  }
  results.sort((a, b) => b.score - a.score);
  S.search.results = results.slice(0, 60);
  S.search.active = S.search.results.length ? 0 : -1;
  renderSearchPanel();
  panel.hidden = false;
}, 130);

function highlight(text, q) {
  const safe = escapeHtml(text);
  if (!q) return safe;
  const pattern = escapeRegExp(q);
  return safe.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderSearchPanel() {
  const panel = $('#searchPanel');
  const q = S.search.query;
  if (!S.search.results.length) {
    panel.innerHTML = `<div class="search-empty">没有找到「${escapeHtml(q)}」相关节点</div>`;
    return;
  }
  const groups = new Map();
  for (const r of S.search.results) {
    if (!groups.has(r.mapId)) groups.set(r.mapId, []);
    groups.get(r.mapId).push(r);
  }
  let idx = -1;
  const html = [];
  for (const [mapId, items] of groups) {
    html.push(`<div class="search-group-label">${escapeHtml(items[0].mapTitle)}</div>`);
    for (const r of items) {
      idx += 1;
      const noteSnippet = r.inBody
        ? `<div class="si-sub">${highlight(String(r.node.note || '').slice(0, 80), q)}</div>`
        : `<div class="si-sub">${escapeHtml(
            (r.parent ? r.parent.title : '根节点') + ` · 第 ${r.depth + 1} 层`,
          )}</div>`;
      html.push(`<div class="search-item${idx === S.search.active ? ' is-active' : ''}" data-i="${idx}" data-map="${mapId}" data-node="${r.node.id}">
        <div class="si-main">
          <div class="si-title">${highlight(r.node.title, q)}</div>
          ${noteSnippet}
        </div>
      </div>`);
    }
  }
  panel.innerHTML = html.join('');
}

function jumpToResult(index) {
  const r = S.search.results[index];
  if (!r) return;
  if (r.mapId !== S.currentMapId) {
    S.currentMapId = r.mapId;
    S.selectedId = r.node.id;
    const map = currentMap();
    // 展开祖先，确保目标可见
    const path = pathTo(map.root, r.node.id);
    path.slice(0, -1).forEach((n) => {
      n.collapsed = false;
    });
    renderAll({ resetView: true });
    scheduleSave();
  } else {
    const map = currentMap();
    pathTo(map.root, r.node.id).slice(0, -1).forEach((n) => {
      n.collapsed = false;
    });
    S.selectedId = r.node.id;
    renderAll();
  }
  canvas.centerOn(r.node.id, { scale: Math.max(0.75, Math.min(1, canvas.view.k)) });
  canvas.pulse(r.node.id);
  $('#searchPanel').hidden = true;
  renderInspector();
}

/* ============================================================
   导出 / 导入 / 备份
   ============================================================ */

async function collectMediaData(node) {
  const ids = [...new Set(collectMediaIds(node))];
  const map = new Map();
  for (const id of ids) {
    const dataUrl = await S.store.getMediaDataURL(id);
    if (dataUrl) map.set(id, { dataUrl });
  }
  return map;
}

function openExportDialog(preset = {}) {
  const map = currentMap();
  const node = currentNode();
  let range = preset.range || (node && node.id !== map.root.id ? 'node' : 'map');
  let embed = true;

  const { modal, close } = openModal({
    title: '导出 JSON',
    body: `
      <div class="form-row">
        <span class="form-label">导出范围</span>
        <div class="radio-list" data-role="range">
          <label class="radio-item ${range === 'node' ? 'is-active' : ''}">
            <input type="radio" name="range" value="node" ${range === 'node' ? 'checked' : ''}/>
            <span><span class="ri-title">当前节点及其完整子树</span>
            <span class="ri-desc">${escapeHtml(node ? node.title : '未选择')}${node ? ` · ${countNodes(node)} 个节点` : ''}</span></span>
          </label>
          <label class="radio-item ${range === 'map' ? 'is-active' : ''}">
            <input type="radio" name="range" value="map" ${range === 'map' ? 'checked' : ''}/>
            <span><span class="ri-title">整张导图</span>
            <span class="ri-desc">${escapeHtml(map.title)} · ${countNodes(map.root)} 个节点</span></span>
          </label>
          <label class="radio-item">
            <input type="radio" name="range" value="backup"/>
            <span><span class="ri-title">全部数据备份</span>
            <span class="ri-desc">${S.maps.length} 张导图，可用于换设备或重装后恢复</span></span>
          </label>
        </div>
      </div>
      <div class="form-row">
        <span class="form-label">媒体文件</span>
        <label class="switch-row" style="padding:0;border:none">
          <span>
            <span class="sr-label">内嵌图片与视频</span>
            <span class="sr-desc" style="display:block">开启后 JSON 自包含，文件更大但可脱离原环境恢复。</span>
          </span>
          <span class="switch"><input type="checkbox" data-role="embed" checked/><span></span></span>
        </label>
      </div>
      <p class="form-hint">导出的 JSON 为明文，若包含敏感内容请注意存放位置。</p>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" data-ok>导出</button>`,
  });

  modal.querySelectorAll('input[name="range"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      range = radio.value;
      modal.querySelectorAll('[data-role="range"] .radio-item').forEach((item) => {
        item.classList.toggle('is-active', item.querySelector('input').checked);
      });
    });
  });
  modal.querySelector('[data-role="embed"]').addEventListener('change', (e) => {
    embed = e.target.checked;
  });

  modal.querySelector('[data-ok]').addEventListener('click', async () => {
    const btn = modal.querySelector('[data-ok]');
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const selectedNode = currentNode() || map.root;
      const resolverFor = (mediaMap) => (id) => mediaMap.get(id) || null;
      let payload;
      let title;
      let kind;
      if (range === 'node') {
        const mediaMap = embed ? await collectMediaData(selectedNode) : new Map();
        payload = buildNodeExport(selectedNode, { resolveMedia: resolverFor(mediaMap) });
        title = selectedNode.title;
        kind = 'node';
      } else if (range === 'map') {
        const mediaMap = embed ? await collectMediaData(map.root) : new Map();
        payload = buildMapExport(map, { resolveMedia: resolverFor(mediaMap) });
        title = map.title;
        kind = 'map';
      } else {
        let mediaMap = new Map();
        if (embed) {
          for (const m of S.maps) {
            const part = await collectMediaData(m.root);
            part.forEach((v, k) => mediaMap.set(k, v));
          }
        }
        payload = buildBackup(S.maps, { resolveMedia: resolverFor(mediaMap) });
        title = '全部数据';
        kind = 'backup';
      }
      const text = JSON.stringify(payload, null, 2);
      download(exportFileName(kind, title), text);
      close();
      toast(`已导出 ${byteSize(new Blob([text]).size)} JSON`, { type: 'ok' });
    } catch (err) {
      console.error(err);
      toast(`导出失败：${err.message}`, { type: 'error' });
      btn.disabled = false;
      btn.textContent = '导出';
    }
  });
}

function openImportDialog(prefill = null) {
  let parsed = null;
  let target = 'auto';
  let source = 'file';

  const { modal, close } = openModal({
    title: '导入 JSON',
    wide: true,
    body: `
      <div class="drop-zone" data-role="drop">
        <strong>选择文件</strong> 或拖拽 JSON 到这里
        <div class="form-hint">支持：节点子树、整张导图、全量备份，以及常见的 title/children 结构</div>
        <input type="file" accept="application/json,.json" hidden data-role="file" />
      </div>
      <div class="form-row" style="margin-top:14px">
        <span class="form-label">或直接粘贴 JSON</span>
        <textarea class="insp-textarea" data-role="text" placeholder='{"title": "根节点", "children": []}' style="min-height:96px;font-family:var(--font-mono);font-size:12px"></textarea>
        <button class="btn btn-sm" data-role="parse" style="margin-top:8px">解析粘贴内容</button>
      </div>
      <div data-role="preview"></div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" data-ok disabled>导入</button>`,
  });

  const preview = modal.querySelector('[data-role="preview"]');
  const okBtn = modal.querySelector('[data-ok]');
  const fileInput = modal.querySelector('[data-role="file"]');
  const drop = modal.querySelector('[data-role="drop"]');

  const showPreview = () => {
    if (!parsed) return;
    const s = parsed.summary || {};
    const issues = parsed.issues || [];
    const targets =
      parsed.kind === 'backup'
        ? `<label class="radio-item ${target === 'replace' ? 'is-active' : ''}"><input type="radio" name="target" value="replace" ${
            target === 'replace' ? 'checked' : ''
          }/><span><span class="ri-title">替换当前全部数据</span><span class="ri-desc">适合恢复到本机；会先自动创建快照</span></span></label>
           <label class="radio-item ${target === 'append' ? 'is-active' : ''}"><input type="radio" name="target" value="append" ${
             target === 'append' ? 'checked' : ''
           }/><span><span class="ri-title">追加为多张导图</span><span class="ri-desc">保留现有导图，导入内容作为新导图加入</span></span></label>`
        : parsed.kind === 'map'
          ? `<label class="radio-item ${target === 'new-map' ? 'is-active' : ''}"><input type="radio" name="target" value="new-map" ${
              target === 'new-map' ? 'checked' : ''
            }/><span><span class="ri-title">作为新导图导入</span><span class="ri-desc">推荐</span></span></label>
             <label class="radio-item ${target === 'under' ? 'is-active' : ''}"><input type="radio" name="target" value="under" ${
               target === 'under' ? 'checked' : ''
             }/><span><span class="ri-title">并入当前选中节点之下</span><span class="ri-desc">把这张导图挂到当前节点</span></span></label>`
          : `<label class="radio-item ${target === 'under' ? 'is-active' : ''}"><input type="radio" name="target" value="under" ${
              target === 'under' ? 'checked' : ''
            }/><span><span class="ri-title">插入到当前选中节点之下</span><span class="ri-desc">${escapeHtml(
              currentNode() ? currentNode().title : '根节点',
            )}</span></span></label>
             <label class="radio-item ${target === 'new-map' ? 'is-active' : ''}"><input type="radio" name="target" value="new-map" ${
               target === 'new-map' ? 'checked' : ''
             }/><span><span class="ri-title">作为新导图导入</span><span class="ri-desc">导入的节点成为根节点</span></span></label>`;

    preview.innerHTML = `
      <div class="summary-card" style="margin-top:14px">
        <div class="sc-row"><span>识别结果</span><b>${kindLabel(parsed.kind)}</b></div>
        <div class="sc-row"><span>标题</span><b>${escapeHtml(s.title || '—')}</b></div>
        <div class="sc-row"><span>节点数量</span><b>${s.nodeCount ?? 0}</b></div>
        <div class="sc-row"><span>内嵌媒体</span><b>${s.mediaCount ?? 0}${
          s.missingMedia ? ` · 缺失 ${s.missingMedia}` : ''
        }</b></div>
      </div>
      ${issues.length ? `<ul class="issue-list">${issues.slice(0, 8).map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
      <div class="form-row" style="margin-top:14px"><span class="form-label">导入方式</span>
        <div class="radio-list" data-role="target">${targets}</div>
      </div>`;
    okBtn.disabled = false;

    preview.querySelectorAll('input[name="target"]').forEach((r) => {
      r.addEventListener('change', () => {
        target = r.value;
        preview.querySelectorAll('[data-role="target"] .radio-item').forEach((item) => {
          item.classList.toggle('is-active', item.querySelector('input').checked);
        });
      });
    });
  };

  const handleText = (text, from) => {
    try {
      parsed = parseImportText(text);
      source = from;
      target = parsed.kind === 'backup' ? 'replace' : parsed.kind === 'map' ? 'new-map' : 'under';
      showPreview();
      if (from === 'text') toast(`已解析：${parsed.summary.nodeCount} 个节点`, { type: 'ok' });
    } catch (err) {
      parsed = null;
      okBtn.disabled = true;
      preview.innerHTML = `<div class="summary-card" style="border-color:var(--danger);color:var(--danger)">${
        err instanceof ImportError ? escapeHtml(err.message) : escapeHtml(err.message || '解析失败')
      }</div>`;
    }
  };

  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (file.size > 120 * 1024 * 1024) {
      toast('文件超过 120MB，请拆分后再导入', { type: 'error' });
      return;
    }
    const text = await file.text();
    drop.innerHTML = `<strong>${escapeHtml(file.name)}</strong><div class="form-hint">${byteSize(file.size)}</div>`;
    handleText(text, 'file');
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const text = await file.text();
    drop.innerHTML = `<strong>${escapeHtml(file.name)}</strong><div class="form-hint">${byteSize(file.size)}</div>`;
    handleText(text, 'file');
  });
  modal.querySelector('[data-role="parse"]').addEventListener('click', () => {
    const text = modal.querySelector('[data-role="text"]').value;
    if (!text.trim()) {
      toast('请先粘贴 JSON 内容', { type: 'error' });
      return;
    }
    handleText(text, 'text');
  });

  okBtn.addEventListener('click', async () => {
    if (!parsed) return;
    okBtn.disabled = true;
    okBtn.textContent = '导入中…';
    try {
      await applyImport(parsed, target);
      close();
    } catch (err) {
      console.error(err);
      toast(`导入失败：${err.message}`, { type: 'error' });
      okBtn.disabled = false;
      okBtn.textContent = '导入';
    }
  });

  if (prefill) {
    if (prefill.text) handleText(prefill.text, 'file');
  }
  void source;
}

function kindLabel(kind) {
  return kind === 'backup' ? '全量备份' : kind === 'map' ? '整张导图' : '节点子树';
}

async function applyImport(parsed, target) {
  const map = currentMap();
  await S.store.createSnapshot('导入前快照', S.maps, { kind: 'pre-import' });

  if (parsed.kind === 'backup') {
    if (target === 'replace') {
      for (const m of parsed.maps) {
        const res = await adoptImportedMedia(m.root, parsed.media || {}, (blob, info) =>
          S.store.putMedia(blob, info),
        );
        if (res.missing.length) toast(`有 ${res.missing.length} 个媒体文件缺失`, { type: 'error' });
      }
      const keepIds = new Set(parsed.maps.map((m) => m.id));
      const staleIds = S.maps.filter((m) => !keepIds.has(m.id)).map((m) => m.id);
      S.maps = parsed.maps;
      S.currentMapId = S.maps[0].id;
      S.selectedId = S.maps[0].root.id;
      S.history.undo.length = 0;
      S.history.redo.length = 0;
      for (const id of staleIds) await S.store.deleteMap(id);
      for (const m of S.maps) await S.store.saveMap(m);
      await S.store.saveWorkspace({ maps: S.maps, settings: S.settings, lastMapId: S.currentMapId });
      renderAll({ resetView: true, inspectorForce: true });
      toast(`已恢复 ${S.maps.length} 张导图`, { type: 'ok' });
      return;
    }
    for (const m of parsed.maps) {
      const res = await adoptImportedMedia(m.root, parsed.media || {}, (blob, info) =>
        S.store.putMedia(blob, info),
      );
      if (res.missing.length) toast(`有 ${res.missing.length} 个媒体文件缺失`, { type: 'error' });
      S.maps.push(m);
      await S.store.saveMap(m);
    }
    S.currentMapId = S.maps[S.maps.length - 1].id;
    S.selectedId = currentMap().root.id;
    scheduleSave({ immediate: true });
    renderAll({ resetView: true, inspectorForce: true });
    toast(`已追加 ${parsed.maps.length} 张导图`, { type: 'ok' });
    return;
  }

  if (parsed.kind === 'map') {
    const res = await adoptImportedMedia(parsed.map.root, parsed.media || {}, (blob, info) =>
      S.store.putMedia(blob, info),
    );
    if (target === 'under' && map) {
      const parent = currentNode() || map.root;
      pushHistory();
      const { root } = parsed.map;
      addNode(parent, root);
      map.updatedAt = nowISO();
      S.selectedId = root.id;
      renderAll({ inspectorForce: true });
      scheduleSave({ immediate: true });
    } else {
      S.maps.push(parsed.map);
      await S.store.saveMap(parsed.map);
      S.currentMapId = parsed.map.id;
      S.selectedId = parsed.map.root.id;
      scheduleSave({ immediate: true });
      renderAll({ resetView: true, inspectorForce: true });
    }
    if (res.missing.length) toast(`有 ${res.missing.length} 个媒体文件缺失`, { type: 'error' });
    toast(`已导入「${parsed.map.title}」`, { type: 'ok' });
    return;
  }

  // 节点
  const res = await adoptImportedMedia(parsed.node, parsed.media || {}, (blob, info) =>
    S.store.putMedia(blob, info),
  );
  if (!map) return;
  if (target === 'new-map') {
    const newMap = createMap(parsed.node.title || '导入的导图');
    newMap.root = parsed.node;
    S.maps.push(newMap);
    await S.store.saveMap(newMap);
    S.currentMapId = newMap.id;
    S.selectedId = newMap.root.id;
    scheduleSave();
    renderAll({ resetView: true, inspectorForce: true });
  } else {
    const parent = currentNode() || map.root;
    pushHistory();
    addNode(parent, parsed.node);
    map.updatedAt = nowISO();
    S.selectedId = parsed.node.id;
    renderAll();
    scheduleSave({ immediate: true });
  }
  if (res.missing.length) toast(`有 ${res.missing.length} 个媒体文件缺失`, { type: 'error' });
  toast(`已导入 ${countNodes(parsed.node)} 个节点`, { type: 'ok' });
}

/* ============================================================
   导图管理
   ============================================================ */

async function switchMap(id) {
  if (id === S.currentMapId) return;
  await flushNow();
  S.currentMapId = id;
  const map = currentMap();
  S.selectedId = map.root.id;
  S.history.undo.length = 0;
  S.history.redo.length = 0;
  closeMenu();
  renderAll({ resetView: true, inspectorForce: true });
  scheduleSave();
  if (window.innerWidth <= 760) $('#shell').classList.remove('sidebar-open');
}

function createNewMap() {
  const map = createMap('未命名导图');
  map.root.note = '';
  S.maps.unshift(map);
  S.currentMapId = map.id;
  S.selectedId = map.root.id;
  S.history.undo.length = 0;
  S.history.redo.length = 0;
  S.store.saveMap(map);
  renderAll({ resetView: true, inspectorForce: true });
  scheduleSave();
  const input = $('#mapTitle');
  input.focus();
  input.select();
}

function deleteMapById(id) {
  if (S.maps.length <= 1) {
    toast('至少保留一张导图', { type: 'error' });
    return;
  }
  const map = S.maps.find((m) => m.id === id);
  if (!map) return;
  confirmDialog({
    title: '删除导图',
    message: `确定删除「${escapeHtml(map.title)}」及其 <b>${countNodes(map.root)}</b> 个节点吗？<br><br>删除前会自动创建快照，可在「设置 → 数据快照」中恢复。`,
    confirmText: '删除',
    danger: true,
  }).then(async (ok) => {
    if (!ok) return;
    await S.store.createSnapshot(`删除导图前：${map.title}`, S.maps, { kind: 'pre-delete' });
    S.maps = S.maps.filter((m) => m.id !== id);
    await S.store.deleteMap(id);
    if (S.currentMapId === id) {
      S.currentMapId = S.maps[0].id;
      S.selectedId = S.maps[0].root.id;
    }
    renderAll({ resetView: true, inspectorForce: true });
    scheduleSave();
    toast('导图已删除', { type: 'ok' });
  });
}

function showMapMenu(id, anchor) {
  openMenu(anchor, [
    { label: '打开', icon: 'arrowRight', onClick: () => switchMap(id) },
    { label: '重命名', icon: 'edit', onClick: () => renameMap(id) },
    { label: '复制导图', icon: 'copy', onClick: () => duplicateMap(id) },
    { type: 'sep' },
    { label: '导出 JSON', icon: 'download', onClick: () => exportMapById(id) },
    { label: '删除', icon: 'trash', danger: true, onClick: () => deleteMapById(id) },
  ]);
}

function renameMap(id) {
  const map = S.maps.find((m) => m.id === id);
  if (!map) return;
  const { modal, close } = openModal({
    title: '重命名导图',
    body: `<input class="insp-input insp-title-input" data-role="name" value="${escapeHtml(map.title)}" />`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" data-ok>保存</button>`,
  });
  const input = modal.querySelector('[data-role="name"]');
  input.focus();
  input.select();
  const submit = () => {
    const value = input.value.trim();
    if (!value) return;
    map.title = value;
    map.updatedAt = nowISO();
    S.store.saveMap(map);
    renderAll();
    scheduleSave();
    close();
  };
  modal.querySelector('[data-ok]').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

async function duplicateMap(id) {
  const map = S.maps.find((m) => m.id === id);
  if (!map) return;
  const copy = {
    id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: `${map.title} 副本`,
    root: cloneSubtree(map.root),
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  copy.root.title = copy.title;
  S.maps.splice(S.maps.indexOf(map) + 1, 0, copy);
  await S.store.saveMap(copy);
  S.currentMapId = copy.id;
  S.selectedId = copy.root.id;
  renderAll({ resetView: true, inspectorForce: true });
  scheduleSave();
  toast('已创建副本', { type: 'ok' });
}

async function exportMapById(id) {
  const map = S.maps.find((m) => m.id === id);
  if (!map) return;
  const mediaMap = await collectMediaData(map.root);
  const payload = buildMapExport(map, { resolveMedia: (mid) => mediaMap.get(mid) || null });
  download(exportFileName('map', map.title), JSON.stringify(payload, null, 2));
  toast('导图已导出', { type: 'ok' });
}

/* ============================================================
   节点右键菜单
   ============================================================ */

function showNodeMenu(id, event) {
  const map = currentMap();
  const node = nodeById(id);
  if (!node) return;
  const isRoot = id === map.root.id;
  openMenu(
    {
      getBoundingClientRect: () => ({ left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY }),
      contains: () => false,
    },
    [
      { label: '编辑标题', icon: 'edit', shortcut: 'F2', onClick: () => canvas.startEdit(id) },
      { label: '添加子节点', icon: 'plus', shortcut: 'Tab', onClick: () => addChild(id) },
      ...(isRoot ? [] : [{ label: '添加同级节点', icon: 'plus', shortcut: 'Enter', onClick: () => addSibling(id) }]),
      { label: node.collapsed ? '展开子节点' : '折叠子节点', icon: node.collapsed ? 'expand' : 'collapse', onClick: () => toggleCollapse(id) },
      { type: 'sep' },
      { label: '复制该子树', icon: 'copy', onClick: () => duplicateNodeById(id) },
      { label: '导出该节点 JSON', icon: 'download', onClick: () => { S.selectedId = id; openExportDialog({ range: 'node' }); } },
      { label: '复制大纲文本', icon: 'note', onClick: () => copyText(outlineText(node), '大纲已复制') },
      { type: 'sep' },
      { label: '删除节点', icon: 'trash', danger: true, onClick: () => deleteNodeById(id) },
    ],
  );
}

/* ============================================================
   设置 / 快捷键
   ============================================================ */

function openSettings() {
  const autoLockOptions = [
    [0, '不自动锁定'],
    [5, '5 分钟'],
    [15, '15 分钟'],
    [30, '30 分钟'],
    [60, '1 小时'],
  ];
  const { modal, close } = openModal({
    title: '设置',
    wide: true,
    body: `
      <div class="form-row">
        <span class="form-label">外观</span>
        <div class="switch-row">
          <span><span class="sr-label">深色模式</span><span class="sr-desc" style="display:block">跟随你的阅读偏好</span></span>
          <span class="switch"><input type="checkbox" data-role="dark" ${S.settings.theme === 'dark' ? 'checked' : ''}/><span></span></span>
        </div>
        <div class="switch-row">
          <span><span class="sr-label">专注模式</span><span class="sr-desc" style="display:block">只高亮选中节点及其子树</span></span>
          <span class="switch"><input type="checkbox" data-role="focus" ${S.settings.focusMode ? 'checked' : ''}/><span></span></span>
        </div>
      </div>
      <div class="form-row">
        <span class="form-label">安全</span>
        <div class="switch-row">
          <span><span class="sr-label">闲置后自动锁定</span><span class="sr-desc" style="display:block">离开电脑时保护你的内容</span></span>
          <select class="insp-input" style="width:auto" data-role="autolock">
            ${autoLockOptions
              .map(([v, l]) => `<option value="${v}" ${Number(S.settings.autoLockMin) === v ? 'selected' : ''}>${l}</option>`)
              .join('')}
          </select>
        </div>
        ${
          S.fixedAuth
            ? `<p class="form-hint">访问密码由提供者指定并内嵌在页面里，本地无法修改。如需更换，请让提供者重新构建页面。</p>`
            : `<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn btn-sm" data-role="change-pass">${icon('key')}修改密码</button>
          <button class="btn btn-sm" data-role="export-auth">${icon('download')}导出密码配置 auth.json</button>
        </div>
        <p class="form-hint">修改密码会重新加密全部本地数据；导出的 auth.json 只含校验信息，不含明文密码。</p>`
        }
      </div>
      <div class="form-row">
        <span class="form-label">数据快照</span>
        <div class="snapshot-list" data-role="snapshots"><div class="form-hint">加载中…</div></div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-sm" data-role="snap-now">${icon('save')}立即创建快照</button>
        </div>
      </div>
      <div class="form-row">
        <span class="form-label">危险操作</span>
        <button class="btn btn-sm btn-danger" data-role="wipe">${icon('trash')}清空本机全部数据</button>
        <p class="form-hint">清空后无法恢复，请先导出备份。</p>
      </div>`,
    footer: `<button class="btn btn-primary" data-close>完成</button>`,
  });

  modal.querySelector('[data-role="dark"]').addEventListener('change', (e) => {
    S.settings.theme = e.target.checked ? 'dark' : 'light';
    applyTheme(S.settings.theme);
    scheduleSave();
  });
  modal.querySelector('[data-role="focus"]').addEventListener('change', (e) => {
    S.settings.focusMode = e.target.checked;
    $('#btnFocus').classList.toggle('is-on', S.settings.focusMode);
    renderAll();
    scheduleSave();
  });
  modal.querySelector('[data-role="autolock"]').addEventListener('change', (e) => {
    S.settings.autoLockMin = Number(e.target.value);
    startAutoLock();
    scheduleSave();
  });
  modal.querySelector('[data-role="change-pass"]')?.addEventListener('click', () => {
    close();
    openChangePassword();
  });
  modal.querySelector('[data-role="export-auth"]')?.addEventListener('click', async () => {
    const cfg = await S.store.exportAuthConfig();
    download('auth.json', JSON.stringify(cfg, null, 2));
    toast('已导出密码配置文件', { type: 'ok' });
  });
  modal.querySelector('[data-role="snap-now"]').addEventListener('click', async () => {
    await S.store.createSnapshot('手动快照', S.maps, { kind: 'manual' });
    toast('快照已创建', { type: 'ok' });
    loadSnapshotList(modal);
  });
  modal.querySelector('[data-role="wipe"]').addEventListener('click', () => {
    confirmDialog({
      title: '清空全部数据',
      message:
        '这会删除本机浏览器中的<b>所有导图、媒体与快照</b>，且无法恢复。<br><br>请确认你已经导出过备份。',
      confirmText: '我确认清空',
      danger: true,
    }).then(async (ok) => {
      if (!ok) return;
      await S.store.wipeAll();
      close();
      location.reload();
    });
  });
  loadSnapshotList(modal);
}

async function loadSnapshotList(modal) {
  const box = modal.querySelector('[data-role="snapshots"]');
  try {
    const list = await S.store.listSnapshots();
    if (!list.length) {
      box.innerHTML = `<div class="form-hint">暂无快照。导入、删除导图等操作前会自动创建。</div>`;
      return;
    }
    box.innerHTML = list
      .map(
        (s) => `<div class="snapshot-row">
          <span>${escapeHtml(s.label || '快照')}<br><span class="sr-time">${escapeHtml(
            formatDate(new Date(s.ts).toISOString()),
          )}</span></span>
          <span style="display:flex;gap:6px">
            <button class="btn btn-sm" data-restore="${s.id}">恢复</button>
            <button class="icon-btn small" data-del="${s.id}" title="删除快照">${icon('trash')}</button>
          </span>
        </div>`,
      )
      .join('');
    box.querySelectorAll('[data-restore]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: '恢复快照',
          message: '当前数据会被快照内容替换。恢复前会再创建一次当前状态快照。',
          confirmText: '恢复',
          danger: true,
        });
        if (!ok) return;
        try {
          await S.store.createSnapshot('恢复前自动快照', S.maps, { kind: 'pre-restore' });
          const payload = await S.store.readSnapshot(btn.dataset.restore);
          S.maps = payload.maps;
          S.currentMapId = S.maps[0].id;
          S.selectedId = S.maps[0].root.id;
          for (const m of S.maps) await S.store.saveMap(m);
          await S.store.saveWorkspace({ maps: S.maps, settings: S.settings, lastMapId: S.currentMapId });
          renderAll({ resetView: true, inspectorForce: true });
          toast('已恢复到快照', { type: 'ok' });
          loadSnapshotList(modal);
        } catch (err) {
          toast(`恢复失败：${err.message}`, { type: 'error' });
        }
      });
    });
    box.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await S.store.deleteSnapshot(btn.dataset.del);
        loadSnapshotList(modal);
      });
    });
  } catch (err) {
    box.innerHTML = `<div class="form-hint">读取快照失败：${escapeHtml(err.message)}</div>`;
  }
}

function openChangePassword() {
  if (S.fixedAuth) {
    toast('访问密码由提供者固定，不能在本机修改', { type: 'error' });
    return;
  }
  const { modal, close } = openModal({
    title: '修改密码',
    body: `
      <div class="form-row"><span class="form-label">当前密码</span>
        <input class="insp-input" type="password" data-role="old" autocomplete="current-password"/></div>
      <div class="form-row"><span class="form-label">新密码</span>
        <input class="insp-input" type="password" data-role="new" autocomplete="new-password"/>
        <div class="form-hint">至少 6 位。修改后所有本地数据会用新密码重新加密，请务必记住新密码。</div></div>
      <div class="form-row"><span class="form-label">确认新密码</span>
        <input class="insp-input" type="password" data-role="new2" autocomplete="new-password"/></div>
      <p class="form-hint" data-role="msg"></p>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" data-ok>修改</button>`,
  });
  const msg = modal.querySelector('[data-role="msg"]');
  modal.querySelector('[data-ok]').addEventListener('click', async () => {
    const oldPass = modal.querySelector('[data-role="old"]').value;
    const newPass = modal.querySelector('[data-role="new"]').value;
    const new2 = modal.querySelector('[data-role="new2"]').value;
    if (!oldPass) {
      msg.textContent = '请输入当前密码';
      msg.style.color = 'var(--danger)';
      return;
    }
    if (newPass.length < 6) {
      msg.textContent = '新密码至少 6 位';
      msg.style.color = 'var(--danger)';
      return;
    }
    if (newPass !== new2) {
      msg.textContent = '两次输入的新密码不一致';
      msg.style.color = 'var(--danger)';
      return;
    }
    msg.textContent = '正在重新加密本地数据…';
    msg.style.color = 'var(--ink-3)';
    try {
      await S.store.createSnapshot('修改密码前快照', S.maps, { kind: 'pre-password' });
      await S.store.changePassword(oldPass, newPass);
      close();
      toast('密码已更新', { type: 'ok' });
    } catch (err) {
      msg.textContent = err.code === 'BAD_PASSWORD' ? '当前密码不正确' : `修改失败：${err.message}`;
      msg.style.color = 'var(--danger)';
    }
  });
}

function openShortcuts() {
  const rows = [
    ['添加子节点', 'Tab'],
    ['添加同级节点', 'Enter'],
    ['编辑选中节点', 'F2 / 双击'],
    ['删除节点', 'Delete'],
    ['折叠 / 展开', 'Space'],
    ['在节点间移动', '↑ ↓ ← →'],
    ['撤销 / 重做', '⌘Z / ⇧⌘Z'],
    ['搜索', '⌘K / ⌘F'],
    ['适应窗口', '⌘0'],
    ['放大 / 缩小', '⌘+ / ⌘-'],
    ['保存（立即）', '⌘S'],
    ['取消选择', 'Esc'],
  ];
  openModal({
    title: '键盘快捷键',
    body: `<div class="kbd-grid">${rows
      .map(([label, key]) => `<div class="kbd-row"><span>${label}</span><kbd>${key}</kbd></div>`)
      .join('')}</div>
      <p class="form-hint" style="margin-top:14px">提示：拖拽节点到其它节点右侧可设为子节点，拖到上下方可调整同级顺序。</p>`,
    footer: `<button class="btn btn-primary" data-close>知道了</button>`,
  });
}

/* ============================================================
   锁定
   ============================================================ */

let autoLockTimer = null;

function startAutoLock() {
  if (autoLockTimer) clearInterval(autoLockTimer);
  const minutes = Number(S.settings.autoLockMin) || 0;
  if (!minutes) return;
  autoLockTimer = setInterval(() => {
    if (!S.ready || S.locked) return;
    if (Date.now() - lastActivity > minutes * 60 * 1000) lockNow();
  }, 20000);
}

let lastActivity = Date.now();
function markActivity() {
  lastActivity = Date.now();
}

async function lockNow({ silent = false } = {}) {
  if (S.locked) return;
  await flushNow();
  revokeMediaUrls();
  S.store.lock();
  S.locked = true;
  S.ready = false;
  S.maps = [];
  S.selectedId = null;
  S.history.undo.length = 0;
  S.history.redo.length = 0;
  closeMenu();
  closeLightbox();
  $('#shell').hidden = true;
  const auth = await S.store.readAuth();
  if (S.fixedAuth) enterFixedMode(auth);
  else enterUnlockMode(auth);
  if (!silent) toast('已锁定', { type: 'ok' });
}

/* ============================================================
   全局事件绑定
   ============================================================ */

function bindGlobalUI() {
  $('#lockForm').addEventListener('submit', handleLockSubmit);
  $('#togglePass').addEventListener('click', () => {
    const input = $('#lockPassword');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    setIcon($('#togglePass'), show ? 'eyeOff' : 'eye');
    input.focus();
  });

  $('#btnSidebar').addEventListener('click', () => {
    const shell = $('#shell');
    if (window.innerWidth <= 760) shell.classList.toggle('sidebar-open');
    else shell.classList.toggle('sidebar-collapsed');
  });
  $('#brandBtn').addEventListener('click', () => {
    const map = currentMap();
    if (!map) return;
    S.selectedId = map.root.id;
    renderAll();
    canvas.centerOn(map.root.id);
  });
  $('#btnImportAuth').addEventListener('click', pickAuthFile);
  $('#btnResetLocal').addEventListener('click', resetLocalFromLock);
  $('#btnInspectorClose').addEventListener('click', () => toggleInspector(false));
  $('#btnInspectorToggle').addEventListener('click', () => toggleInspector());
  $('#btnRuleToggle').addEventListener('click', () => toggleRulePanel());

  $('#mapTitle').addEventListener('input', () => {
    const map = currentMap();
    if (!map) return;
    map.title = $('#mapTitle').value;
    map.updatedAt = nowISO();
    document.title = `${map.title} · 一念`;
    renderSidebar();
    scheduleSave();
  });
  $('#mapTitle').addEventListener('blur', () => {
    const map = currentMap();
    if (!map) return;
    if (!map.title.trim()) {
      map.title = '未命名导图';
      renderMapTitle();
      scheduleSave();
    }
  });
  $('#mapTitle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#mapTitle').blur();
  });

  $('#btnNewMap').addEventListener('click', createNewMap);
  $('#mapList').addEventListener('click', (e) => {
    const menuBtn = e.target.closest('[data-act="map-menu"]');
    if (menuBtn) {
      e.stopPropagation();
      showMapMenu(menuBtn.dataset.id, menuBtn);
      return;
    }
    const item = e.target.closest('.map-item');
    if (item) switchMap(item.dataset.id);
  });
  $('#recentList').addEventListener('click', (e) => {
    const row = e.target.closest('.recent-row');
    if (row) switchMap(row.dataset.id);
  });
  $('#outlineList').addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      e.stopPropagation();
      toggleCollapse(toggle.dataset.toggle);
      return;
    }
    const row = e.target.closest('.outline-row');
    if (row) {
      selectNode(row.dataset.id, { center: true });
      if (window.innerWidth <= 760) $('#shell').classList.remove('sidebar-open');
    }
  });
  $('#btnOutlineExpand').addEventListener('click', () => {
    const map = currentMap();
    if (!map) return;
    mutate(() => {
      const walk = (n) => {
        n.collapsed = false;
        (n.children || []).forEach(walk);
      };
      walk(map.root);
    });
  });

  $$('.side-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.side-tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      $$('.side-pane').forEach((pane) => {
        pane.hidden = pane.dataset.pane !== tab.dataset.tab;
      });
    });
  });

  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
  $('#btnImport').addEventListener('click', () => openImportDialog());
  $('#btnExport').addEventListener('click', () => openExportDialog());
  $('#btnLock').addEventListener('click', () => lockNow());
  $('#btnMore').addEventListener('click', () => {
    openMenu($('#btnMore'), [
      { label: '新建导图', icon: 'plus', onClick: createNewMap },
      { label: '导入 JSON', icon: 'upload', onClick: () => openImportDialog() },
      { label: '导出当前导图', icon: 'download', onClick: () => openExportDialog({ range: 'map' }) },
      { label: '备份全部数据', icon: 'database', onClick: () => openExportDialog({ range: 'backup' }) },
      ...(S.fixedAuth
        ? []
        : [
            { type: 'sep' },
            { label: '生成访问密钥文件', icon: 'key', onClick: exportAuthKeyFile },
          ]),
      { type: 'sep' },
      { label: '查看 SVG', icon: 'image', onClick: openSvgDialog },
      { label: '导出 SVG', icon: 'download', onClick: exportSvgFile },
      { type: 'sep' },
      { label: '键盘快捷键', icon: 'keyboard', shortcut: '?', onClick: openShortcuts },
      { label: '设置', icon: 'settings', onClick: openSettings },
      { type: 'sep' },
      { label: '锁定工作空间', icon: 'lock', onClick: () => lockNow() },
    ]);
  });

  $('#btnZoomIn').addEventListener('click', () => canvas.zoomAt(1.15));
  $('#btnZoomOut').addEventListener('click', () => canvas.zoomAt(0.87));
  $('#btnFit').addEventListener('click', () => canvas.fit());
  $('#btnCenter').addEventListener('click', () => {
    if (S.selectedId) canvas.centerOn(S.selectedId);
  });
  $('#btnFocus').addEventListener('click', () => {
    S.settings.focusMode = !S.settings.focusMode;
    $('#btnFocus').classList.toggle('is-on', S.settings.focusMode);
    renderAll();
    scheduleSave();
  });
  $('#btnTipClose').addEventListener('click', () => {
    $('#stageTip').hidden = true;
    S.settings.tipDismissed = true;
    scheduleSave();
  });
  $('#lightboxClose').addEventListener('click', closeLightbox);
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox' || e.target.id === 'lightboxBody') closeLightbox();
  });

  // 搜索
  const searchInput = $('#searchInput');
  searchInput.addEventListener('input', runSearch);
  searchInput.addEventListener('focus', () => {
    if (S.search.results.length && searchInput.value.trim()) $('#searchPanel').hidden = false;
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!S.search.results.length) return;
      S.search.active =
        (S.search.active + (e.key === 'ArrowDown' ? 1 : -1) + S.search.results.length) %
        S.search.results.length;
      renderSearchPanel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (S.search.active >= 0) jumpToResult(S.search.active);
    } else if (e.key === 'Escape') {
      $('#searchPanel').hidden = true;
      searchInput.blur();
    }
  });
  $('#searchClear').addEventListener('click', () => {
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input'));
    searchInput.focus();
  });
  $('#searchPanel').addEventListener('click', (e) => {
    const item = e.target.closest('.search-item');
    if (item) jumpToResult(Number(item.dataset.i));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#searchBox')) $('#searchPanel').hidden = true;
  });

  // 键盘
  document.addEventListener('keydown', onGlobalKey);
  document.addEventListener('pointerdown', markActivity, { passive: true });
  document.addEventListener('keydown', markActivity, { passive: true });

  // 拖拽文件导入
  const overlay = $('#dragOverlay');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!S.ready) return;
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    dragDepth += 1;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    if (!S.ready) return;
    dragDepth = 0;
    overlay.hidden = true;
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    if (!/\.json$/i.test(file.name)) {
      toast('请拖入 .json 文件', { type: 'error' });
      return;
    }
    const text = await file.text();
    openImportDialog({ text });
  });

  // 页面隐藏 / 关闭前保存
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.ready) flushNow();
  });
  window.addEventListener('pagehide', () => {
    if (S.ready) flushNow();
  });
}

function isTypingTarget(target) {
  if (!target) return false;
  const el = target.closest ? target.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]') : null;
  return !!el;
}

function onGlobalKey(e) {
  if (!S.ready) return;
  const mod = e.metaKey || e.ctrlKey;

  if (mod && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    $('#searchInput').focus();
    $('#searchInput').select();
    return;
  }
  if (mod && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    $('#searchInput').focus();
    $('#searchInput').select();
    return;
  }
  if (mod && (e.key === 'e' || e.key === 'E')) {
    e.preventDefault();
    openExportDialog();
    return;
  }
  if (mod && e.key === 's') {
    e.preventDefault();
    flushNow().then(() => toast('已保存到本机', { type: 'ok' }));
    return;
  }
  if (mod && e.key === '0') {
    e.preventDefault();
    canvas.fit();
    return;
  }
  if (mod && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    canvas.zoomAt(1.15);
    return;
  }
  if (mod && e.key === '-') {
    e.preventDefault();
    canvas.zoomAt(0.87);
    return;
  }
  if (mod && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }

  if (isTypingTarget(e.target)) return;
  if (!currentMap()) return;
  if (e.target.closest && e.target.closest('.modal-wrap')) return;

  if (e.key === 'Tab') {
    e.preventDefault();
    addChild(S.selectedId);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (S.selectedId) addSibling(S.selectedId);
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!S.selectedId) return;
    e.preventDefault();
    deleteNodeById(S.selectedId);
    return;
  }
  if (e.key === 'F2') {
    e.preventDefault();
    canvas.startEdit(S.selectedId);
    return;
  }
  if (e.key === ' ') {
    e.preventDefault();
    if (S.selectedId) toggleCollapse(S.selectedId);
    return;
  }
  if (e.key === 'Escape') {
    closeMenu();
    $('#searchPanel').hidden = true;
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    openShortcuts();
    return;
  }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    canvas.moveSelection(dir);
  }
}

/* ============================================================
   启动画布
   ============================================================ */

// 自测钩子：仅在 ?test=1 时暴露内部状态，便于端到端测试驱动真实流程
if (new URLSearchParams(location.search).has('test')) {
  window.__yinian = {
    S,
    store: S.store,
    get canvas() {
      return canvas;
    },
    get inspector() {
      return inspector;
    },
    currentMap,
    currentNode,
    nodeById,
    renderAll,
    scheduleSave,
    flushNow,
    addChild,
    addSibling,
    deleteNodeById,
    selectNode,
    switchMap,
    createNewMap,
    mutate,
    pushHistory,
    applyImport,
    openExportDialog,
    openImportDialog,
    buildNodeExport,
    buildMapExport,
    buildBackup,
    parseImportText,
    adoptImportedMedia,
    addFilesToNode,
    locate,
    countNodes,
    pathTo,
    findMatches,
    outlineText,
    toggleRulePanel,
    toggleInspector,
    openNodeJsonDialog,
    openSvgDialog,
    exportSvgFile,
    exportAuthKeyFile,
    pickAuthFile,
    buildSvg,
    detachToNewMap,
    resolveRule,
    resolveDownRule,
    renderRulePanel,
    setEpisodes,
    applyRuleJson,
    undo,
    redo,
    generateEpisodes,
    version: APP_VERSION,
  };
}

initCanvas();
initRulePanel();
window.addEventListener('resize', () => {
  if (canvas && S.ready && currentMap()) canvas.applyView();
});
window.addEventListener('beforeunload', () => {
  if (S.ready) flushNow();
});
if (S.settings.theme) applyTheme(S.settings.theme);
hydrateIcons();

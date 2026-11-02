/* 端到端测试：用真实 Chrome 打开单文件应用，验证完整闭环
 * 运行：node tools/e2e.mjs（仅开发期使用，应用本身不需要 Node）
 */

import { launch, Page, sleep } from './cdp.mjs';
import { readdir, readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const BASE = process.env.BASE_URL || new URL('../思维导图.html', import.meta.url).href;
const DOWNLOAD_DIR = '/tmp/yinian-downloads';
const PASSWORD = 'Test-1234';
// 应用就绪：内部钩子可用，且锁屏或工作区已经显示
const READY =
  "(function(){const l=document.querySelector('#lockScreen'),s=document.querySelector('#shell');return !!window.__yinian && ((l&&!l.hidden)||(s&&!s.hidden));})()";

const results = [];
let page;
let currentMapId = null;
let nodes = {};

function ok(name) {
  results.push({ name, pass: true });
  console.log(`  ✓ ${name}`);
}
function fail(name, err) {
  results.push({ name, pass: false, error: err.message || String(err) });
  console.log(`  ✗ ${name}\n      ${(err.message || err).split('\n')[0]}`);
}
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
}

async function clearDownloads() {
  await rm(DOWNLOAD_DIR, { recursive: true, force: true });
  await mkdir(DOWNLOAD_DIR, { recursive: true });
}

async function waitForDownload(namePart, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const files = await readdir(DOWNLOAD_DIR).catch(() => []);
    const hit = files.find((f) => f.includes(namePart) && f.endsWith('.json'));
    if (hit) {
      await sleep(80);
      const text = await readFile(`${DOWNLOAD_DIR}/${hit}`, 'utf8');
      try {
        return { file: hit, json: JSON.parse(text), text };
      } catch {
        await sleep(120);
      }
    }
    await sleep(120);
  }
  throw new Error(`等待下载超时: ${namePart}`);
}

async function main() {
  await clearDownloads();

  // 使用独立的用户目录，保证每个测试进程从干净状态开始
  const profile = `/tmp/yinian-e2e-${Date.now()}`;
  const cdp = await launch({ port: 9400 + (process.pid % 100), userDataDir: profile });
  page = new Page(cdp);
  await page.init({ downloadPath: DOWNLOAD_DIR });

  console.log('\n[1] 启动与初始化');
  await page.goto(`${BASE}?test=1`, { waitFor: READY });

  await check('首次访问进入"设置密码"模式', async () => {
    const state = await page.eval(`
      return {
        lockVisible: !document.querySelector('#lockScreen').hidden,
        confirmVisible: !document.querySelector('#confirmField').hidden,
        submit: document.querySelector('#lockSubmit').textContent.trim(),
      };`);
    assert(state.lockVisible, '锁屏不可见');
    assert(state.confirmVisible, '首次设置应显示确认密码输入框');
    assert(state.submit.includes('创建'), `提交按钮文案异常: ${state.submit}`);
  });

  // 清空历史数据，保证干净
  await page.eval(`await __yinian.store.wipeAll(); return true;`);
  await page.reload({ waitFor: READY });

  console.log('\n[2] 解锁与首次进入');
  await check('密码长度不足时拒绝创建', async () => {
    await page.fill('#lockPassword', '123');
    await page.fill('#lockPassword2', '123');
    await page.click('#lockSubmit');
    await sleep(150);
    const hint = await page.text('#lockHint');
    assert(hint.includes('6 位'), `未提示密码长度: ${hint}`);
    assert(await page.eval(`return document.querySelector('#shell').hidden;`), '不应进入工作区');
  });

  await check('设置密码后进入工作区（本地加密）', async () => {
    await page.fill('#lockPassword', PASSWORD);
    await page.fill('#lockPassword2', PASSWORD);
    await page.click('#lockSubmit');
    await page.waitFor(`!document.querySelector('#shell').hidden && __yinian.S.ready`, { timeout: 12000 });
    const info = await page.eval(`
      return {
        maps: __yinian.S.maps.length,
        auth: await __yinian.store.readAuth().then(a => a ? { hasVerifier: !!a.verifier, iter: a.iterations } : null),
        unlocked: __yinian.store.unlocked,
        nodes: __yinian.S.maps[0] ? __yinian.countNodes(__yinian.S.maps[0].root) : 0,
        rendered: document.querySelectorAll('.node').length,
      };`);
    assertEqual(info.maps, 1, '应自动创建一张欢迎导图');
    assert(info.auth && info.auth.hasVerifier, '未写入密码校验信息');
    assert(info.auth.iter >= 100000, 'PBKDF2 迭代次数过低');
    assert(info.unlocked, '存储处于锁定状态');
    assert(info.nodes > 5, '欢迎导图节点过少');
    assert(info.rendered > 5, `画布渲染节点数异常: ${info.rendered}`);
  });

  await check('明文密码不落盘（IndexedDB 中无明文）', async () => {
    const found = await page.eval(`
      const dbs = await indexedDB.databases();
      const db = await new Promise((res, rej) => { const r = indexedDB.open('yinian-v1'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const stores = ['meta','maps','media','snapshots'];
      const hits = [];
      for (const s of stores) {
        const all = await new Promise((res, rej) => { const t = db.transaction(s).objectStore(s).getAll(); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
        const text = JSON.stringify(all);
        if (text.includes(${JSON.stringify(PASSWORD)})) hits.push(s);
      }
      db.close();
      return { hits, dbCount: dbs.length };`);
    assertEqual(found.hits.length, 0, `以下存储中存在明文密码: ${found.hits.join(',')}`);
    assert(found.dbCount > 0, '未创建本地数据库');
  });

  console.log('\n[3] 创建导图与节点编辑');
  await check('新建导图并可修改标题', async () => {
    await page.click('#btnNewMap');
    await page.waitFor(`__yinian.S.maps.length === 2`);
    await page.fill('#mapTitle', '端到端测试导图');
    await page.click('#stage');
    await sleep(300);
    const title = await page.eval(`return __yinian.currentMap().title;`);
    assertEqual(title, '端到端测试导图', '导图标题未生效');
    currentMapId = await page.eval(`return __yinian.S.currentMapId;`);
  });

  await check('Tab 添加子节点并输入标题', async () => {
    await page.eval(`__yinian.selectNode(__yinian.currentMap().root.id); return true;`);
    await page.key('Tab');
    await page.waitFor(`__yinian.canvas.isEditing`);
    await page.type('想法 A');
    await page.key('Enter');
    await sleep(200);
    const titles = await page.eval(`return __yinian.currentMap().root.children.map(c => c.title);`);
    assertEqual(titles[0], '想法 A', '子节点标题不正确');
  });

  await check('Enter 添加同级节点', async () => {
    await page.key('Enter');
    await page.waitFor(`__yinian.canvas.isEditing`);
    await page.type('想法 B');
    await page.key('Enter');
    await sleep(200);
    const titles = await page.eval(`return __yinian.currentMap().root.children.map(c => c.title);`);
    assertEqual(titles.join(','), '想法 A,想法 B', `同级节点创建异常: ${titles}`);
  });

  await check('双击节点进入编辑并改名', async () => {
    const id = await page.eval(`
      const n = __yinian.currentMap().root.children.find(c => c.title === '想法 B');
      return n.id;`);
    const box = await page.$(`.node[data-id="${id}"]`);
    assert(box, '画布上找不到节点');
    await page.dblclick(`.node[data-id="${id}"]`);
    await sleep(150);
    await page.type('想法 B2');
    await page.key('Enter');
    await sleep(200);
    const title = await page.eval(`return __yinian.nodeById(${JSON.stringify(id)}).title;`);
    assertEqual(title, '想法 B2', '双击编辑未生效');
  });

  await check('方向键在节点间移动选择', async () => {
    await page.click('#stage');
    await page.eval(`__yinian.selectNode(__yinian.currentMap().root.id); return true;`);
    await page.key('ArrowRight');
    await page.key('ArrowDown');
    const title = await page.eval(`return __yinian.currentNode().title;`);
    assertEqual(title, '想法 B2', `方向键导航异常: ${title}`);
  });

  await check('拖拽节点改变从属关系', async () => {
    const ids = await page.eval(`
      const kids = __yinian.currentMap().root.children;
      const a = kids.find(c => c.title === '想法 A');
      const b = kids.find(c => c.title === '想法 B2');
      // 先给 A 建一个子节点
      __yinian.selectNode(a.id);
      return { a: a.id, b: b.id };`);
    await page.key('Tab');
    await page.waitFor(`__yinian.canvas.isEditing`);
    await page.type('细节');
    await page.key('Enter');
    await sleep(250);
    const childId = await page.eval(`
      const a = __yinian.currentMap().root.children.find(c => c.title === '想法 A');
      return a.children[0].id;`);

    const from = await page.$(`.node[data-id="${childId}"]`);
    const target = await page.$(`.node[data-id="${ids.b}"]`);
    // 拖到目标节点右侧 → 成为子节点
    await page.drag(from, { x: target.x + target.w * 0.35, y: target.y });
    await sleep(350);
    const parentTitle = await page.eval(`
      const hit = __yinian.locate(__yinian.currentMap().root, ${JSON.stringify(childId)});
      return hit && hit.parent ? hit.parent.title : null;`);
    assertEqual(parentTitle, '想法 B2', '拖拽后父节点不正确');
  });

  await check('撤销与重做', async () => {
    await page.eval(`__yinian.selectNode(__yinian.currentNode().id); return true;`);
    const before = await page.eval(`return __yinian.countNodes(__yinian.currentMap().root);`);
    await page.key('Tab');
    await page.waitFor(`__yinian.canvas.isEditing`);
    await page.type('临时节点');
    await page.key('Enter');
    await sleep(200);
    const added = await page.eval(`return __yinian.countNodes(__yinian.currentMap().root);`);
    assertEqual(added, before + 1, '节点未添加');
    await page.click('#btnUndo');
    await sleep(350);
    const afterUndo = await page.eval(`return __yinian.countNodes(__yinian.currentMap().root);`);
    assertEqual(afterUndo, before, '撤销未生效');
    await page.click('#btnRedo');
    await sleep(350);
    const afterRedo = await page.eval(`return __yinian.countNodes(__yinian.currentMap().root);`);
    assertEqual(afterRedo, before + 1, '重做未生效');
    await page.click('#btnUndo');
    await sleep(300);
  });

  console.log('\n[4] 节点内容：笔记 / 标签 / 颜色 / 媒体');
  await check('编辑 Markdown 笔记并渲染预览', async () => {
    const id = await page.eval(`
      const n = __yinian.currentMap().root.children[0];
      __yinian.selectNode(n.id);
      return n.id;`);
    await page.waitFor(`document.querySelector('#inspectorBody [data-role="note"]')`);
    await page.fill('#inspectorBody [data-role="note"]', '# 标题\n\n- 第一点 **重点**\n- 第二点');
    await sleep(700);
    const note = await page.eval(`return __yinian.nodeById(${JSON.stringify(id)}).note;`);
    assert(note.includes('第一点'), '笔记未写入');
    await page.eval(`document.querySelector('[data-role="note-mode"] button[data-mode="preview"]').click(); return true;`);
    await sleep(120);
    const html = await page.eval(`return document.querySelector('[data-role="preview"]').innerHTML;`);
    assert(html.includes('<strong>重点</strong>'), 'Markdown 粗体未渲染');
    assert(html.includes('<li>'), 'Markdown 列表未渲染');
    await page.eval(`document.querySelector('[data-role="note-mode"] button[data-mode="edit"]').click(); return true;`);
  });

  await check('添加标签与标记颜色', async () => {
    const id = await page.eval(`return __yinian.currentNode().id;`);
    await page.eval(`
      const input = document.querySelector('[data-role="tag-input"]');
      input.focus();
      input.value = '核心';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;`);
    await sleep(300);
    const tags = await page.eval(`return __yinian.nodeById(${JSON.stringify(id)}).tags;`);
    assertEqual(tags.join(','), '核心', '标签未添加');

    await page.eval(`document.querySelector('.swatch[data-color="#D24B5A"]').click(); return true;`);
    await sleep(300);
    const color = await page.eval(`return __yinian.nodeById(${JSON.stringify(id)}).color;`);
    assertEqual(color, '#D24B5A', '颜色标记未生效');
    const hasClass = await page.eval(`return document.querySelector('.node[data-id="${id}"]').classList.contains('tag-tint');`);
    assert(hasClass, '画布未反映颜色标记');
  });

  await check('上传图片并写入加密媒体库', async () => {
    const id = await page.eval(`return __yinian.currentNode().id;`);
    await page.eval(`
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const file = new File([bytes], 'dot.png', { type: 'image/png' });
      await __yinian.addFilesToNode(${JSON.stringify(id)}, [file]);
      return true;`);
    await sleep(500);
    const info = await page.eval(`
      const n = __yinian.nodeById(${JSON.stringify(id)});
      const att = n.attachments[0];
      const blob = att && att.mediaId ? await __yinian.store.getMediaBlob(att.mediaId) : null;
      return { count: n.attachments.length, kind: att && att.kind, mediaId: att && att.mediaId, size: blob ? blob.size : 0 };`);
    assertEqual(info.count, 1, '附件未添加');
    assertEqual(info.kind, 'image', '附件类型不正确');
    assert(info.mediaId, '媒体未落库');
    assert(info.size > 0, '媒体内容为空');
    nodes.mediaNodeId = id;
  });

  await check('添加链接参考资料', async () => {
    const id = await page.eval(`return __yinian.currentNode().id;`);
    await page.eval(`document.querySelector('[data-act="add-link"]').click(); return true;`);
    await page.waitFor(`document.querySelector('[data-role="att-url"]')`);
    await page.fill('[data-role="att-url"]', 'https://example.com/reading');
    await page.fill('[data-role="att-title"]', '参考资料示例');
    await page.eval(`document.querySelector('.modal [data-ok]').click(); return true;`);
    await sleep(400);
    const atts = await page.eval(`return __yinian.nodeById(${JSON.stringify(id)}).attachments.map(a => ({k:a.kind,t:a.title,u:a.url}));`);
    const link = atts.find((a) => a.k === 'link');
    assert(link, '链接未添加');
    assertEqual(link.u, 'https://example.com/reading', '链接地址不正确');
    assertEqual(atts.length, 2, '附件数量不正确');
  });

  console.log('\n[5] 搜索与定位');
  await check('全局搜索并跳转定位', async () => {
    await page.eval(`__yinian.switchMap(__yinian.S.maps.find(m => m.id !== __yinian.S.currentMapId).id); return true;`);
    await sleep(300);
    await page.click('#searchInput');
    await page.type('想法');
    await page.waitFor(`!document.querySelector('#searchPanel').hidden && document.querySelectorAll('.search-item').length > 0`);
    const count = await page.eval(`return document.querySelectorAll('.search-item').length;`);
    assert(count >= 2, `搜索结果数量异常: ${count}`);
    await page.key('ArrowDown');
    await page.key('Enter');
    await sleep(600);
    const state = await page.eval(`
      return { title: __yinian.currentNode().title, mapId: __yinian.S.currentMapId, panelHidden: document.querySelector('#searchPanel').hidden };`);
    assert(state.title.includes('想法'), `跳转后选中的节点不正确: ${state.title}`);
    assert(state.mapId === currentMapId, '搜索应自动切换到目标导图');
    assert(state.panelHidden, '跳转后搜索面板应关闭');
  });

  console.log('\n[6] 导出 / 导入 JSON');
  await check('导出选中节点子树（含结构与媒体）', async () => {
    // 定位到第 [4] 步写入媒体文件的节点（可能位于另一张导图）
    const where = await page.eval(`
      let hit = null;
      for (const m of __yinian.S.maps) {
        if (__yinian.locate(m.root, ${JSON.stringify(nodes.mediaNodeId)})) hit = m.id;
      }
      if (!hit) return null;
      await __yinian.switchMap(hit);
      __yinian.selectNode(${JSON.stringify(nodes.mediaNodeId)});
      return hit;`);
    assert(where, '找不到含媒体的节点所在导图');
    await sleep(300);
    await page.click('#btnExport');
    await page.waitFor(`document.querySelector('.modal [data-role="range"]')`);
    await page.eval(`
      const r = document.querySelector('.modal input[name="range"][value="node"]');
      r.checked = true;
      r.dispatchEvent(new Event('change', { bubbles: true }));
      return true;`);
    await page.eval(`document.querySelector('.modal [data-ok]').click(); return true;`);
    const dl = await waitForDownload('节点');
    const payload = dl.json;
    assertEqual(payload.format, 'yinian.node', '导出格式不正确');
    assertEqual(payload.version, 1, '版本号不正确');
    assert(payload.root && payload.root.title, '缺少根节点');
    assert(payload.media && Object.keys(payload.media).length > 0, '未内嵌媒体');
    assertEqual(payload.root.id, nodes.mediaNodeId, `导出的根节点不是当前选中节点（${payload.root.title}）`);
    // 导出树里的每个节点都必须能在页面树中找到，且结构一致
    const verify = await page.eval(`
      const root = ${JSON.stringify(JSON.stringify(payload.root))};
      const tree = JSON.parse(root);
      const ids = [];
      const walk = (n) => { ids.push(n.id); (n.children || []).forEach(walk); };
      walk(tree);
      const missing = ids.filter((id) => !__yinian.nodeById(id));
      const pageCount = __yinian.countNodes(__yinian.nodeById(payloadRootId));
      return { total: ids.length, missing, pageCount };
    `.replace('payloadRootId', JSON.stringify(nodes.mediaNodeId)));
    assertEqual(verify.missing.length, 0, `导出内容有节点在页面中不存在: ${verify.missing.join(',')}`);
    assertEqual(verify.total, verify.pageCount, '导出节点数与页面不一致');
    nodes.exported = payload;
  });

  await check('导入 JSON 并恢复为可编辑结构', async () => {
    await page.eval(`__yinian.selectNode(__yinian.currentMap().root.id); return true;`);
    const before = await page.eval(`return __yinian.countNodes(__yinian.currentMap().root);`);
    await page.click('#btnImport');
    await page.waitFor(`document.querySelector('.modal [data-role="text"]')`);
    const json = JSON.stringify({
      title: '导入的子树',
      children: [
        { title: '导入子节点 1', note: '来自外部 JSON', children: [{ title: '孙节点' }] },
        { title: '导入子节点 2' },
      ],
    });
    await page.fill('.modal [data-role="text"]', json);
    await page.eval(`document.querySelector('.modal [data-role="parse"]').click(); return true;`);
    await page.waitFor(`document.querySelector('.modal [data-ok]') && !document.querySelector('.modal [data-ok]').disabled`);
    await page.eval(`document.querySelector('.modal [data-ok]').click(); return true;`);
    await sleep(900);
    const after = await page.eval(`
      const root = __yinian.currentMap().root;
      return { count: __yinian.countNodes(root), titles: root.children.map(c => c.title) };`);
    assertEqual(after.count, before + 4, `导入后节点数不正确: ${after.count} vs ${before + 4}`);
    assert(after.titles.includes('导入的子树'), '导入的根节点未挂载');

    // 导入后继续编辑（验证可编辑）
    const importedRoot = await page.eval(`
      const n = __yinian.currentMap().root.children.find(c => c.title === '导入的子树');
      __yinian.selectNode(n.id);
      return n.id;`);
    await page.key('Tab');
    await page.waitFor(`__yinian.canvas.isEditing`);
    await page.type('新想法');
    await page.key('Enter');
    await sleep(300);
    const canEdit = await page.eval(`
      const n = __yinian.nodeById(${JSON.stringify(importedRoot)});
      return n.children.some(c => c.title === '新想法');`);
    assert(canEdit, '导入的节点无法继续编辑');
  });

  await check('导出的 JSON 可再次导入并且结构一致', async () => {
    const exported = nodes.exported;
    const before = await page.eval(`return __yinian.countNodes(__yinian.currentMap().root);`);
    const res = await page.eval(`
      const parsed = __yinian.parseImportText(${JSON.stringify(JSON.stringify(exported))});
      const media = await __yinian.adoptImportedMedia(parsed.node, parsed.media || {}, (b, i) => __yinian.store.putMedia(b, i));
      const root = __yinian.currentMap().root;
      __yinian.pushHistory();
      const node = parsed.node;
      __yinian.mutate(() => { root.children.push(node); });
      return { count: __yinian.countNodes(node), missing: media.missing.length, expected: ${before} };`);
    assertEqual(res.missing, 0, '媒体恢复存在缺失');
    const after = await page.eval(`return __yinian.countNodes(__yinian.currentMap().root);`);
    assertEqual(after, before + res.count, '再次导入后节点数不一致');
  });

  console.log('\n[7] 持久化与刷新恢复');
  await check('刷新后数据仍存在（重新解锁）', async () => {
    const before = await page.eval(`
      return {
        maps: __yinian.S.maps.map(m => ({ id: m.id, title: m.title, nodes: __yinian.countNodes(m.root) })),
        selectedTitle: __yinian.currentNode().title,
        mediaNodeId: ${JSON.stringify(nodes.mediaNodeId)},
      };`);
    await page.reload({ waitFor: READY });
    await page.waitFor(`!document.querySelector('#lockScreen').hidden`);
    const locked = await page.eval(`return document.querySelector('#shell').hidden;`);
    assert(locked, '刷新后应重新要求密码');

    // 错误密码
    await page.fill('#lockPassword', 'wrong-password');
    await page.click('#lockSubmit');
    await sleep(900);
    const hint = await page.text('#lockHint');
    assert(hint.includes('不正确'), `错误密码未提示: ${hint}`);

    await page.fill('#lockPassword', PASSWORD);
    await page.click('#lockSubmit');
    await page.waitFor(`!document.querySelector('#shell').hidden && __yinian.S.ready`, { timeout: 12000 });
    const after = await page.eval(`
      return {
        maps: __yinian.S.maps.map(m => ({ id: m.id, title: m.title, nodes: __yinian.countNodes(m.root) })),
        rendered: document.querySelectorAll('.node').length,
      };`);
    assertEqual(after.maps.length, before.maps.length, '刷新后导图数量不一致');
    for (const m of before.maps) {
      const hit = after.maps.find((x) => x.id === m.id);
      assert(hit, `导图丢失: ${m.title}`);
      assertEqual(hit.nodes, m.nodes, `导图节点数变化: ${m.title}`);
    }
    assert(after.rendered > 0, '刷新后画布未渲染');
  });

  await check('刷新后媒体仍可解密读取', async () => {
    const res = await page.eval(`
      const n = __yinian.nodeById(${JSON.stringify(nodes.mediaNodeId)});
      if (!n) return { found: false };
      const att = n.attachments.find(a => a.mediaId);
      const blob = att ? await __yinian.store.getMediaBlob(att.mediaId) : null;
      return { found: true, size: blob ? blob.size : 0, mime: blob ? blob.type : '' };`);
    assert(res.found, '媒体节点丢失');
    assert(res.size > 0, '媒体内容无法读取');
    assertEqual(res.mime, 'image/png', '媒体类型不正确');
  });

  console.log('\n[8] 备份与恢复');
  await check('导出全量备份', async () => {
    await page.click('#btnExport');
    await page.waitFor(`document.querySelector('.modal [data-role="range"]')`);
    await page.eval(`
      const r = document.querySelector('.modal input[name="range"][value="backup"]');
      r.checked = true;
      r.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('.modal [data-ok]').click();
      return true;`);
    const dl = await waitForDownload('备份');
    assertEqual(dl.json.format, 'yinian.backup', '备份格式不正确');
    assertEqual(dl.json.maps.length, 2, '备份导图数量不正确');
    assert(dl.json.media && Object.keys(dl.json.media).length > 0, '备份未内嵌媒体');
    nodes.backup = dl;
  });

  await check('恢复备份：替换全部数据且不残留旧导图', async () => {
    // 先制造差异：删除一个节点
    await page.eval(`
      const root = __yinian.currentMap().root;
      if (root.children.length) __yinian.deleteNodeById(root.children[root.children.length - 1].id);
      return true;`);
    await sleep(600);
    const res = await page.eval(`
      const parsed = __yinian.parseImportText(${JSON.stringify(JSON.stringify(nodes.backup.json))});
      await __yinian.applyImport(parsed, 'replace');
      return { maps: __yinian.S.maps.length, settings: !!__yinian.S.settings };`);
    assertEqual(res.maps, 2, '恢复后导图数量不正确');

    const persisted = await page.eval(`
      const all = await new Promise((res, rej) => {
        const req = indexedDB.open('yinian-v1');
        req.onsuccess = () => { const db = req.result; const t = db.transaction('maps').objectStore('maps').getAll(); t.onsuccess = () => { res(t.result.map(r => r.id)); db.close(); }; t.onerror = () => rej(t.error); };
        req.onerror = () => rej(req.error);
      });
      return all;`);
    assertEqual(persisted.length, 2, `IndexedDB 中残留了旧导图记录: ${persisted.join(',')}`);
  });

  await check('备份恢复后节点与媒体完整', async () => {
    const res = await page.eval(`
      const map = __yinian.currentMap();
      let media = 0, titles = [];
      const walk = (n) => { titles.push(n.title); media += (n.attachments || []).filter(a => a.mediaId).length; (n.children||[]).forEach(walk); };
      __yinian.S.maps.forEach(m => walk(m.root));
      return { media, hasImport: titles.includes('导入的子树'), hasMedia: titles.includes('细节') };`);
    assert(res.media > 0, '恢复后媒体引用丢失');
    assert(res.hasImport, '恢复后节点内容不完整');
  });

  console.log('\n[9] 安全与锁定');
  await check('锁定后需重新输入密码，且内存数据被清空', async () => {
    await page.click('#btnLock').catch(() => {});
    try {
      await page.waitFor(`!document.querySelector('#lockScreen').hidden`, { timeout: 2000 });
    } catch {
      await page.eval(`document.querySelector('#btnLock').click(); return true;`);
      await page.waitFor(`!document.querySelector('#lockScreen').hidden`, { timeout: 8000 });
    }
    const state = await page.eval(`
      return { shellHidden: document.querySelector('#shell').hidden, mapsInMemory: __yinian.S.maps.length, unlocked: __yinian.store.unlocked };`);
    assert(state.shellHidden, '锁定后界面仍可见');
    assertEqual(state.mapsInMemory, 0, '锁定后内存中仍保留数据');
    assertEqual(state.unlocked, false, '锁定后存储仍处于解锁状态');

    await page.fill('#lockPassword', PASSWORD);
    await page.click('#lockSubmit');
    await page.waitFor(`!document.querySelector('#shell').hidden && __yinian.S.ready`, { timeout: 12000 });
    const nodes2 = await page.eval(`return document.querySelectorAll('.node').length;`);
    assert(nodes2 > 0, '解锁后画布为空');
  });

  await check('页面无未处理异常', async () => {
    const noise = [/favicon/i, /auth\.json/i, /Failed to load resource/i, /download/i, /密码不正确/];
    const errs = [...page.pageErrors, ...page.consoleErrors].filter(
      (e) => e && !noise.some((n) => n.test(e)),
    );
    assertEqual(errs.length, 0, `存在页面错误: ${errs.slice(0, 3).join(' | ')}`);
  });

  await page.close();

  // 汇总
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`端到端结果：${passed} 通过 / ${failed} 失败 / 共 ${results.length} 项`);
  if (failed) {
    console.log('\n失败详情：');
    results.filter((r) => !r.pass).forEach((r) => console.log(`- ${r.name}: ${r.error}`));
    process.exitCode = 1;
  }
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  void existsSync;
}

main().catch((err) => {
  console.error('测试运行失败：', err);
  if (page) page.close();
  process.exitCode = 1;
});

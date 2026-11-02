/* 固定访问密码（构建期内嵌）—— 端到端验证
 * 会先用临时密码构建一份 html 到 /tmp，再用真实 Chrome 验证进入、锁屏、权限收口。
 * 运行：node tools/fixed.mjs（仅开发期使用，应用本身不需要 Node）
 */

import { launch, Page, sleep } from './cdp.mjs';
import { execFile } from 'node:child_process';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD_DIR = '/tmp/yinian-fixed';
const OUT = `${BUILD_DIR}/index.html`;
const PROFILE = '/tmp/yinian-fixed-profile';
// 运行期随机生成，避免测试脚本里出现固定口令
const PASSWORD = randomBytes(12).toString('base64url');
// 固定 salt，便于模拟「提供者换密码」而本地数据仍是旧密文
const SALT = randomBytes(16).toString('base64');
const READY =
  "(function(){const l=document.querySelector('#lockScreen'),s=document.querySelector('#shell');return !!window.__yinian && ((l&&!l.hidden)||(s&&!s.hidden));})()";

const results = [];
let page;

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

async function build(secret = PASSWORD) {
  await rm(BUILD_DIR, { recursive: true, force: true });
  await mkdir(BUILD_DIR, { recursive: true });
  await run('python3', ['build.py', '--out', OUT], {
    cwd: ROOT,
    env: { ...process.env, YINIAN_AUTH_PASSWORD: secret, YINIAN_AUTH_SALT: SALT },
  });
  return readFile(OUT, 'utf8');
}

async function main() {
  console.log('构建带固定密码的临时页面…');
  const html = await build();
  await rm(PROFILE, { recursive: true, force: true });

  const cdp = await launch({ port: 9444, userDataDir: PROFILE });
  page = new Page(cdp);
  await page.init();
  await page.goto(`file://${OUT}?test=1`, { waitFor: READY });
  await sleep(300);

  await check('页面源码内不含明文密码', async () => {
    assert(!html.includes(PASSWORD), 'html 中出现了明文密码');
    assert(html.includes('__YINIAN_AUTH__'), 'html 未内嵌密码配置');
    assert(html.includes('"verifier"'), 'html 未内嵌校验值');
  });

  await check('首次进入即为固定密码模式（无双密码输入、无导入密钥）', async () => {
    const state = await page.eval(`
      return {
        label: document.querySelector('#lockLabel').textContent,
        confirmHidden: document.querySelector('#confirmField').hidden,
        importHidden: document.querySelector('#btnImportAuth').hidden,
        resetHidden: document.querySelector('#btnResetLocal').hidden,
        mode: __yinian.S.mode,
        fixed: !!__yinian.S.fixedAuth,
        hint: document.querySelector('#lockHint').textContent,
      };
    `);
    assertEqual(state.mode, 'fixed', '锁屏未进入固定密码模式');
    assert(state.fixed, '未识别到内嵌密码配置');
    assertEqual(state.label, '访问密码', '锁屏标签不对');
    assert(state.confirmHidden, '仍显示二次输入框（允许自设密码）');
    assert(state.importHidden, '仍显示导入密钥文件按钮');
    assert(state.resetHidden, '正常状态下不应显示清空按钮');
    assert(state.hint.includes('提供者'), `提示语未说明密码来源：${state.hint}`);
  });

  await check('错误密码被拒绝且不进入工作空间', async () => {
    await page.fill('#lockPassword', `${PASSWORD}-wrong`);
    await page.click('#lockSubmit');
    await page.waitFor(`document.querySelector('#lockHint').classList.contains('is-error')`, {
      timeout: 8000,
    });
    const state = await page.eval(`
      return {
        shellHidden: document.querySelector('#shell').hidden,
        hint: document.querySelector('#lockHint').textContent,
      };
    `);
    assert(state.shellHidden, '错误密码竟然进入了工作空间');
    assert(state.hint.includes('密码不正确'), `错误提示不明确：${state.hint}`);
  });

  await check('正确密码进入工作空间并建立本地工作空间', async () => {
    await page.fill('#lockPassword', PASSWORD);
    await page.click('#lockSubmit');
    await page.waitFor(`!document.querySelector('#shell').hidden && __yinian.S.ready`, { timeout: 15000 });
    const state = await page.eval(`
      const auth = await __yinian.store.readAuth();
      return {
        locked: __yinian.S.locked,
        source: auth && auth.source,
        nodes: document.querySelectorAll('.node').length,
      };
    `);
    assertEqual(state.locked, false, '解锁后仍处于锁定状态');
    assertEqual(state.source, 'builtin', '本地工作空间未沿用内嵌密码配置');
    assert(state.nodes > 0, '画布没有节点');
  });

  await check('设置里不再提供「修改密码 / 导出密码配置」', async () => {
    await page.click('#btnMore');
    await page.waitFor(`!!document.querySelector('.menu .menu-item')`, { timeout: 5000 });
    const items = await page.eval(`
      return Array.from(document.querySelectorAll('.menu .menu-item')).map((b) => b.textContent.trim());
    `);
    assert(!items.some((t) => t.includes('访问密钥')), `菜单仍提供密钥分发：${items.join(' / ')}`);
    const target = await page.eval(`
      const btn = Array.from(document.querySelectorAll('.menu .menu-item')).find((b) => b.textContent.includes('设置'));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    assert(target, '菜单里找不到设置项');
    await page.clickAt(target.x, target.y);
    await page.waitFor(`!!document.querySelector('#modalRoot .modal')`, { timeout: 5000 });
    const modal = await page.eval(`
      const m = document.querySelector('#modalRoot .modal');
      return {
        hasChange: !!m.querySelector('[data-role="change-pass"]'),
        hasExport: !!m.querySelector('[data-role="export-auth"]'),
        text: m.textContent,
      };
    `);
    assert(!modal.hasChange, '仍显示「修改密码」');
    assert(!modal.hasExport, '仍显示「导出密码配置」');
    assert(modal.text.includes('由提供者指定'), '没有说明密码由提供者指定');
    await page.click('#modalRoot .modal [data-close]');
    await sleep(200);
  });

  await check('手动锁定后仍回到固定密码锁屏', async () => {
    await page.click('#btnLock');
    await page.waitFor(`!document.querySelector('#lockScreen').hidden`, { timeout: 8000 });
    const state = await page.eval(`
      return { mode: __yinian.S.mode, label: document.querySelector('#lockLabel').textContent };
    `);
    assertEqual(state.mode, 'fixed', '锁定后没有回到固定密码模式');
    assertEqual(state.label, '访问密码', '锁定后标签不对');
  });

  await check('刷新页面后仍需密码，且同一密码可再次进入', async () => {
    await page.reload({ waitFor: READY });
    await page.fill('#lockPassword', PASSWORD);
    await page.click('#lockSubmit');
    await page.waitFor(`!document.querySelector('#shell').hidden && __yinian.S.ready`, { timeout: 15000 });
    const mode = await page.eval(`return __yinian.S.mode;`);
    assertEqual(mode, 'fixed', '刷新后模式变为 ' + mode);
  });

  await check('清空本机数据后依然是固定密码模式（不会退化为自设密码）', async () => {
    await page.eval(`await __yinian.store.wipeAll();`);
    await page.goto(`file://${OUT}?test=1`, { waitFor: READY });
    const state = await page.eval(`
      return {
        mode: __yinian.S.mode,
        confirmHidden: document.querySelector('#confirmField').hidden,
        label: document.querySelector('#lockLabel').textContent,
      };
    `);
    assertEqual(state.mode, 'fixed', '清空数据后退回了自设密码模式');
    assert(state.confirmHidden, '清空数据后出现二次输入框');
    assertEqual(state.label, '访问密码', '清空数据后标签不对');
    await page.fill('#lockPassword', PASSWORD);
    await page.click('#lockSubmit');
    await page.waitFor(`!document.querySelector('#shell').hidden && __yinian.S.ready`, { timeout: 15000 });
  });

  await check('提供者更换密码后：旧数据被标为过期，清空后可用新密码继续', async () => {
    const next = randomBytes(12).toString('base64url');
    await build(next);
    await page.reload({ waitFor: READY });
    const stale = await page.eval(`
      return {
        stale: __yinian.S.staleLocal,
        resetHidden: document.querySelector('#btnResetLocal').hidden,
        hint: document.querySelector('#lockHint').textContent,
      };
    `);
    assert(stale.stale, '未识别出本机数据属于旧密码');
    assert(!stale.resetHidden, '未提供清空入口');
    assert(stale.hint.includes('旧密码'), `提示未说明数据来源：${stale.hint}`);

    await page.fill('#lockPassword', next);
    await page.click('#lockSubmit');
    await page.waitFor(`document.querySelector('#lockHint').classList.contains('is-error')`, {
      timeout: 10000,
    });
    const hint = await page.text('#lockHint');
    assert(hint.includes('清空'), `未引导用户清空旧数据：${hint}`);

    await page.click('#btnResetLocal');
    await page.waitFor(`!!document.querySelector('#modalRoot [data-confirm]')`, { timeout: 5000 });
    await page.click('#modalRoot [data-confirm]');
    // 清空后会 location.reload()，等新页面起来再输入
    await sleep(2000);
    await page.waitFor(READY, { timeout: 15000 });
    await page.waitFor(`document.querySelector('#lockScreen') && !document.querySelector('#lockScreen').hidden`, {
      timeout: 15000,
    });
    await page.fill('#lockPassword', next);
    await page.click('#lockSubmit');
    await page.waitFor(`!document.querySelector('#shell').hidden && __yinian.S.ready`, { timeout: 15000 });
    const ok = await page.eval(`return !document.querySelector('#shell').hidden;`);
    assert(ok, '新密码未能进入工作空间');
  });

  await check('页面无未处理异常', async () => {
    const noise = [/favicon/i, /Failed to load resource/i, /download/i, /密码不正确/];
    const errs = [...page.pageErrors, ...page.consoleErrors].filter((e) => e && !noise.some((n) => n.test(e)));
    assertEqual(errs.length, 0, `存在页面错误: ${errs.slice(0, 3).join(' | ')}`);
  });

  await page.close();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`固定密码结果：${passed} 通过 / ${failed} 失败 / 共 ${results.length} 项`);
  if (failed) {
    console.log('\n失败详情：');
    results.filter((r) => !r.pass).forEach((r) => console.log(`- ${r.name}: ${r.error}`));
    process.exitCode = 1;
  }
  await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
}

main().catch((err) => {
  console.error('测试运行失败：', err);
  if (page) page.close();
  process.exitCode = 1;
});

/* 规则层还原 / 集数字段 / 一键生成子节点 —— 端到端验证
 * 运行：node tools/episodes.mjs（仅开发期使用，应用本身不需要 Node）
 */

import { launch, Page, sleep } from './cdp.mjs';

const BASE = process.env.BASE_URL || (await import('./fixture.mjs')).fixtureUrl;
const PASSWORD = 'Test-1234';
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
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`);
}

/** 触发输入框的 input + change，模拟真实填写 */
const setValue = (selector, value) => `
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('找不到 ${selector}');
  el.value = ${JSON.stringify(String(value))};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;`;

async function main() {
  const profile = `/tmp/yinian-episodes-${Date.now()}`;
  const cdp = await launch({ port: 9400 + (process.pid % 90), userDataDir: profile });
  page = new Page(cdp);
  await page.init();

  console.log('\n[1] 进入工作区');
  await page.goto(`${BASE}?test=1`, { waitFor: READY });
  await page.fill('#lockPassword', PASSWORD);
  await page.fill('#lockPassword2', PASSWORD);
  await page.click('#lockSubmit');
  await page.waitFor(`__yinian.S.ready`, { timeout: 15000 });

  await page.eval(`__yinian.createNewMap(); return true;`);
  await sleep(500);

  console.log('\n[2] 规则层还原当前节点的规则');
  await check('打开规则层时显示该节点的模板、字段清单与规则 JSON', async () => {
    await page.eval(`
      const map = __yinian.currentMap();
      __yinian.selectNode(map.root.id);
      __yinian.toggleRulePanel(true);
      const sel = document.querySelector('#ruleSelect');
      sel.value = 'anime';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;`);
    await sleep(400);
    const info = await page.eval(`
      const raw = document.querySelector('#ruleJsonInline').value;
      let json = null;
      try { json = JSON.parse(raw); } catch (e) { json = null; }
      return {
        name: document.querySelector('#ruleName').textContent.trim(),
        chips: [...document.querySelectorAll('#ruleBody .rule-chip-item')].map((li) => li.textContent),
        json,
      };`);
    assertEqual(info.name, '动漫模板', '规则层未还原模板名');
    assert(
      info.chips.some((c) => c.includes('集数') && c.includes('episodes')),
      `字段清单里缺少集数：${JSON.stringify(info.chips)}`,
    );
    assert(info.json, '规则 JSON 不是合法 JSON');
    assertEqual(info.json.id, 'anime', 'JSON 的 id 与当前模板不一致');
    assert(
      info.json.fields.some((f) => f.type === 'episodes'),
      '规则 JSON 里没有 episodes 字段',
    );
  });

  await check('详情层点「打开规则层」会还原到被点节点的规则', async () => {
    await page.eval(`__yinian.toggleRulePanel(false); return true;`);
    await page.eval(`
      __yinian.addChild(__yinian.currentMap().root.id);
      return true;`);
    await sleep(400);
    await page.key('Escape');
    // 换到一个未设定规则的节点（子节点只有自身内容规则，没有向下规则）
    const childId = await page.eval(`
      const c = __yinian.currentMap().root.children[0];
      __yinian.selectNode(c.id);
      __yinian.toggleRulePanel(true);
      return c.id;`);
    await sleep(300);
    const name = await page.eval(`return document.querySelector('#ruleName').textContent.trim();`);
    assertEqual(name, '自由导图', '未设定规则时应显示默认模板');
    const json = await page.eval(`
      return JSON.parse(document.querySelector('#ruleJsonInline').value).id;`);
    assertEqual(json, 'free', 'JSON 应还原为默认模板');
    void childId;

    // 回到根节点，规则层应切回动漫模板
    await page.eval(`__yinian.selectNode(__yinian.currentMap().root.id); return true;`);
    await sleep(250);
    const back = await page.eval(`return document.querySelector('#ruleName').textContent.trim();`);
    assertEqual(back, '动漫模板', '切换节点后规则层未还原');
  });

  console.log('\n[3] 集数字段与一键生成');
  await check('详情层出现「子节点 / 集数」区', async () => {
    // 换一张干净的导图：根节点设定动漫规则，子节点数为 0
    await page.eval(`__yinian.createNewMap(); return true;`);
    await sleep(450);
    await page.eval(`
      const map = __yinian.currentMap();
      __yinian.selectNode(map.root.id);
      __yinian.toggleRulePanel(true);
      const sel = document.querySelector('#ruleSelect');
      sel.value = 'anime';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;`);
    await sleep(450);
    await page.eval(`__yinian.toggleRulePanel(false); return true;`);
    await page.eval(`__yinian.selectNode(__yinian.currentMap().root.id); return true;`);
    await sleep(300);
    const info = await page.eval(`
      const el = document.querySelector('[data-role="episodes"]');
      return {
        has: !!el,
        value: el ? el.querySelector('[data-episodes-input]').value : null,
        hasBtn: !!(el && el.querySelector('[data-episodes-gen]')),
        children: __yinian.currentMap().root.children.length,
      };`);
    assert(info.has, '没有渲染子节点区');
    assertEqual(info.children, 0, '新导图不该有子节点');
    assertEqual(info.value, '0', '初始集数应等于现有子节点数');
    assert(info.hasBtn, '缺少一键生成按钮');
  });

  await check('填 5 集生成 5 个子节点（第 1–5 集）', async () => {
    await page.eval(setValue('[data-episodes-input]', 5));
    await page.eval(`document.querySelector('[data-episodes-gen]').click(); return true;`);
    await sleep(500);
    const info = await page.eval(`
      const root = __yinian.currentMap().root;
      return {
        count: root.children.length,
        titles: root.children.map((c) => c.title),
        dataEpisodes: root.data.episodes,
      };`);
    assertEqual(info.count, 5, '子节点数量不对');
    assertEqual(info.titles.join(','), '第 1 集,第 2 集,第 3 集,第 4 集,第 5 集', '子节点命名不对');
    assertEqual(info.dataEpisodes, 5, 'data.episodes 未同步');
  });

  await check('已有 5 集时填 8 集，只补 3 个，原节点不变', async () => {
    const before = await page.eval(`
      return __yinian.currentMap().root.children.map((c) => c.id);`);
    await page.eval(setValue('[data-episodes-input]', 8));
    await page.eval(`document.querySelector('[data-episodes-gen]').click(); return true;`);
    await sleep(500);
    const after = await page.eval(`
      const root = __yinian.currentMap().root;
      return { ids: root.children.map((c) => c.id), titles: root.children.map((c) => c.title) };`);
    assertEqual(after.ids.length, 8, '数量不对');
    assertEqual(
      JSON.stringify(after.ids.slice(0, 5)),
      JSON.stringify(before),
      '已有子节点的 id 被改动了',
    );
    assertEqual(after.titles.slice(5).join(','), '第 6 集,第 7 集,第 8 集', '新增命名不对');
  });

  await check('填更小的数字不删除已有子节点', async () => {
    await page.eval(setValue('[data-episodes-input]', 3));
    await page.eval(`document.querySelector('[data-episodes-gen]').click(); return true;`);
    await sleep(500);
    const info = await page.eval(`
      const root = __yinian.currentMap().root;
      return { count: root.children.length, input: document.querySelector('[data-episodes-input]').value };`);
    assertEqual(info.count, 8, '不应删除子节点');
    assertEqual(info.input, '8', '输入框应回到真实数量');
  });

  await check('手动加子节点时集数自动同步', async () => {
    await page.eval(`
      __yinian.selectNode(__yinian.currentMap().root.id);
      __yinian.addChild(__yinian.currentMap().root.id);
      return true;`);
    await sleep(450);
    await page.key('Escape');
    await page.eval(`__yinian.selectNode(__yinian.currentMap().root.id); return true;`);
    await sleep(350);
    const info = await page.eval(`
      const root = __yinian.currentMap().root;
      return {
        count: root.children.length,
        input: document.querySelector('[data-episodes-input]').value,
        hint: document.querySelector('[data-episodes-hint]').textContent,
        dataEpisodes: root.data.episodes,
      };`);
    assertEqual(info.count, 9, '子节点数量不对');
    assertEqual(info.input, '9', '集数未自动同步');
    assert(info.hint.includes('9'), `提示未同步：${info.hint}`);
    assertEqual(info.dataEpisodes, 9, 'data.episodes 未同步真实数量');
  });

  await check('一次生成可整体撤销', async () => {
    await page.eval(setValue('[data-episodes-input]', 12));
    await page.eval(`document.querySelector('[data-episodes-gen]').click(); return true;`);
    await sleep(450);
    const added = await page.eval(`return __yinian.currentMap().root.children.length;`);
    assertEqual(added, 12, '生成失败');
    await page.eval(`__yinian.undo(); return true;`);
    await sleep(400);
    const back = await page.eval(`return __yinian.currentMap().root.children.length;`);
    assertEqual(back, 9, '撤销没有整体回退');
  });

  console.log('\n[4] 规则 JSON 可改可应用');
  await check('改 JSON 后应用会生成自定义副本，内置模板不受影响', async () => {
    await page.eval(`
      __yinian.selectNode(__yinian.currentMap().root.id);
      __yinian.toggleRulePanel(true);
      return true;`);
    await sleep(300);
    await page.eval(`
      const area = document.querySelector('#ruleJsonInline');
      const json = JSON.parse(area.value);
      json.name = '动漫模板（我的）';
      json.fields = json.fields.filter((f) => f.key !== 'board');
      area.value = JSON.stringify(json, null, 2);
      document.querySelector('[data-json-apply]').click();
      return true;`);
    await sleep(700);
    const info = await page.eval(`
      const map = __yinian.currentMap();
      const down = __yinian.resolveDownRule(map.root, __yinian.S.settings.customRules);
      return {
        name: down.template.name,
        own: down.own,
        hasBoard: down.template.fields.some((f) => f.key === 'board'),
        builtin: __yinian.S.settings.customRules.map((r) => r.id),
        builtinAnimeIntact: __yinian
          .resolveDownRule({ rule: { template: 'anime' } }, __yinian.S.settings.customRules)
          .template.fields.some((f) => f.key === 'board'),
        shown: document.querySelector('#ruleName').textContent.trim(),
      };`);
    assert(info.own, '节点未绑定到新规则');
    assertEqual(info.name, '动漫模板（我的）', '规则名未更新');
    assert(!info.hasBoard, '去掉的字段又出现了');
    assert(info.builtinAnimeIntact, '内置模板被改坏了');
    assertEqual(info.shown, '动漫模板（我的）', '规则层没有同步新规则');
  });

  await check('页面无未捕获异常', async () => {
    const noise = [/favicon/i, /Failed to load resource/i, /download/i];
    const errs = (page.pageErrors || []).filter((e) => !noise.some((r) => r.test(String(e))));
    assert(errs.length === 0, `页面报错：${errs.slice(0, 3).join(' | ')}`);
  });

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n规则与集数结果：${pass}/${results.length} 通过`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log('失败用例：');
    for (const f of failed) console.log(` - ${f.name}: ${f.error}`);
  }
  cdp.proc.kill('SIGKILL');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('测试运行失败：', err);
  process.exit(1);
});

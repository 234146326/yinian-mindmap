/* 规则层 / 父级决定属性 / SVG / 脱离成根 —— 端到端验证
 * 运行：node tools/feature.mjs（仅开发期使用，应用本身不需要 Node）
 */

import { launch, Page, sleep } from './cdp.mjs';
import { rm } from 'node:fs/promises';

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

async function main() {
  const profile = `/tmp/yinian-feature-${Date.now()}`;
  const cdp = await launch({ port: 9300 + (process.pid % 90), userDataDir: profile });
  page = new Page(cdp);
  await page.init();

  console.log('\n[1] 进入工作区');
  await page.goto(`${BASE}?test=1`, { waitFor: READY });
  await page.fill('#lockPassword', PASSWORD);
  await page.fill('#lockPassword2', PASSWORD);
  await page.click('#lockSubmit');
  await page.waitFor(`__yinian.S.ready`, { timeout: 15000 });

  await check('左右两个工作层可以独立开合', async () => {
    await page.eval(`__yinian.toggleRulePanel(true); return true;`);
    await sleep(200);
    const open = await page.eval(`return !document.querySelector('#rulebar').hidden;`);
    assert(open, '规则层未打开');
    await page.eval(`__yinian.toggleRulePanel(false); return true;`);
    await sleep(150);
    const closed = await page.eval(`return document.querySelector('#rulebar').hidden;`);
    assert(closed, '规则层未收起');

    await page.eval(`__yinian.toggleInspector(false); return true;`);
    await sleep(150);
    const inspClosed = await page.eval(`return document.querySelector('#shell').classList.contains('inspector-collapsed');`);
    assert(inspClosed, '详情层未收起');
    await page.eval(`__yinian.toggleInspector(true); return true;`);
  });

  console.log('\n[2] 父节点决定子节点属性');
  await check('给根节点设定动漫模板，规则作用在子节点上', async () => {
    // 新建一张空导图：根节点还没有子节点，才可以设定向下规则
    await page.eval(`__yinian.createNewMap(); return true;`);
    await sleep(500);
    const info = await page.eval(`
      const map = __yinian.currentMap();
      __yinian.selectNode(map.root.id);
      __yinian.toggleRulePanel(true);
      return { rootFields: __yinian.resolveRule(map.root, map.root.id).template.id };`);
    assertEqual(info.rootFields, 'free', '根节点自身应仍是默认模板');

    await page.eval(`
      const sel = document.querySelector('#ruleSelect');
      sel.value = 'anime';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;`);
    await sleep(350);
    await page.eval(`__yinian.addChild(__yinian.currentMap().root.id); return true;`);
    await sleep(400);
    const after = await page.eval(`
      const map = __yinian.currentMap();
      const root = map.root;
      const child = __yinian.currentMap().root.children[0];
      return {
        rootRule: root.rule && root.rule.template,
        rootOwn: __yinian.resolveRule(map.root, root.id).template.id,
        childRule: child ? __yinian.resolveRule(map.root, child.id).template.id : null,
      };`);
    assertEqual(after.rootRule, 'anime', '根节点未写入向下规则');
    assertEqual(after.rootOwn, 'free', '根节点自身内容不应被自己的规则改变');
    assertEqual(after.childRule, 'anime', '子节点未继承父级的规则');
  });

  await check('子节点详情层出现动漫模板要求的属性', async () => {
    await sleep(300);
    const info = await page.eval(`
      const map = __yinian.currentMap();
      const child = map.root.children[0];
      __yinian.selectNode(child.id);
      return child.title;`);
    await sleep(500);
    const dom = await page.eval(`
      const host = document.querySelector('[data-role="rule-fields"]');
      return {
        visible: host && !host.hidden,
        labels: [...document.querySelectorAll('[data-role="rule-fields"] .field-label')].map(el => el.textContent.trim()),
        hasShots: !!document.querySelector('[data-role="rule-fields"] [data-shots-add]'),
        chip: document.querySelector('.rule-card .rule-chip').textContent.trim(),
      };`);
    assert(dom.visible, '规则属性区未显示');
    assert(dom.chip === '动漫模板', `详情层规则标识异常: ${dom.chip}`);
    assert(dom.labels.includes('梗概'), `缺少梗概字段: ${dom.labels.join(',')}`);
    assert(dom.hasShots, '缺少分镜列表');
    void info;
  });

  await check('填写梗概与新增分镜会写入节点数据', async () => {
    const id = await page.eval(`return __yinian.currentNode().id;`);
    await page.eval(`
      const ta = document.querySelector('[data-role="rule-fields"] textarea[data-field="synopsis"]');
      ta.value = '第一集：少年遇见机械鸟';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`);
    await sleep(300);
    await page.eval(`document.querySelector('[data-shots-add]').click(); return true;`);
    await sleep(400);
    const data = await page.eval(`
      const n = __yinian.nodeById(${JSON.stringify(id)});
      return { synopsis: n.data.synopsis, shots: (n.data.shots || []).length };`);
    assertEqual(data.synopsis, '第一集：少年遇见机械鸟', '梗概未写入');
    assertEqual(data.shots, 1, '分镜未写入');
  });

  await check('分镜列表与故事板同时呈现', async () => {
    const dom = await page.eval(`
      return {
        shots: document.querySelectorAll('[data-role="rule-fields"] .shot').length,
        board: !!document.querySelector('[data-role="rule-fields"] .board'),
        boardText: (document.querySelector('[data-role="rule-fields"] .board') || {}).textContent || '',
      };`);
    assertEqual(dom.shots, 1, '分镜列表渲染异常');
    assert(dom.board, '缺少故事板区域');
    assert(dom.boardText.includes('给分镜加上图片'), '空故事板提示缺失');
  });

  console.log('\n[3] 规则编辑限制');
  await check('节点有子节点时规则可改，但修改前要确认', async () => {
    // 根节点已有 1 个子节点，且它的向下规则是动漫模板
    await page.eval(`
      __yinian.selectNode(__yinian.currentMap().root.id);
      __yinian.toggleRulePanel(true);
      return true;`);
    await sleep(400);
    const state = await page.eval(`
      return {
        lockVisible: !document.querySelector('#ruleLock').hidden,
        lockText: document.querySelector('#ruleLock').textContent.trim(),
        selectDisabled: document.querySelector('#ruleSelect').disabled,
      };`);
    assert(state.lockVisible, '未提示修改会影响子节点');
    assert(state.lockText.includes('会影响全部 1 个子节点'), `提示文案异常: ${state.lockText}`);
    assert(!state.selectDisabled, '规则应当允许修改');

    // 修改前必须确认
    await page.eval(`
      const sel = document.querySelector('#ruleSelect');
      sel.value = 'free';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;`);
    await page.waitFor(`document.querySelector('.modal [data-confirm]')`);
    const warned = await page.eval(`return document.querySelector('.modal .confirm-text').textContent;`);
    assert(warned.includes('子节点'), '确认框未说明影响范围');
    await page.eval(`document.querySelector('.modal [data-cancel]')?.click(); return true;`).catch(() => {});
    await page.eval(`document.querySelector('.modal [data-close]').click(); return true;`);
    await sleep(300);
    const keptRule = await page.eval(`
      const root = __yinian.currentMap().root;
      return {
        own: root.rule ? root.rule.template : null,
        effective: __yinian.resolveDownRule(root, __yinian.S.settings.customRules).template.id,
        selected: document.querySelector('#ruleSelect').value,
      };`);
    assertEqual(keptRule.own, 'anime', '取消后节点的规则不应被修改');
    assertEqual(keptRule.effective, 'anime', '取消后生效规则不应改变');
    assertEqual(keptRule.selected, 'anime', '取消后选择器应回到原规则');
  });

  console.log('\n[4] SVG 查看与导出');
  await check('生成包含层级与文字的 SVG', async () => {
    // 先补一个孙节点，确保 SVG 里确实有多层
    await page.eval(`
      __yinian.selectNode(__yinian.currentMap().root.children[0].id);
      __yinian.addChild(__yinian.currentMap().root.children[0].id);
      return true;`);
    await sleep(400);
    await page.key('Escape');
    await page.eval(`
      const grand = __yinian.currentMap().root.children[0].children[0];
      if (grand) grand.title = '子分镜';
      return true;`);
    const info = await page.eval(`
      const map = __yinian.currentMap();
      __yinian.selectNode(map.root.id);
      const { svg, width, height } = __yinian.buildSvg(map.root, { title: map.title });
      return { head: svg.slice(0, 40), nodes: (svg.match(/class="node"/g) || []).length, width, height, hasTitle: svg.includes('子分镜') };`);
    assert(info.head.startsWith('<svg'), '不是合法 SVG');
    assert(info.nodes >= 3, `SVG 节点数量异常: ${info.nodes}`);
    assert(info.width > 100 && info.height > 60, `尺寸异常: ${info.width}x${info.height}`);
    assert(info.hasTitle, 'SVG 未包含节点文字');
  });

  await check('SVG 预览弹窗可用', async () => {
    await page.eval(`__yinian.openSvgDialog(); return true;`);
    await page.waitFor(`document.querySelector('#svgFrame svg')`);
    const ok2 = await page.eval(`
      return { nodes: document.querySelectorAll('#svgFrame .node').length, save: !!document.querySelector('[data-save]') };`);
    assert(ok2.nodes >= 3, '预览里的节点数异常');
    assert(ok2.save, '缺少导出按钮');
    await page.eval(`document.querySelector('.modal [data-close]').click(); return true;`);
    await sleep(200);
  });

  console.log('\n[5] 拖出成为新的根节点');
  await check('分离子节点为独立导图并带走规则', async () => {
    const before = await page.eval(`
      const map = __yinian.currentMap();
      const child = map.root.children[0];
      __yinian.detachToNewMap(child.id);
      return { maps: __yinian.S.maps.length, childTitle: child.title };`);
    await page.waitFor(`document.querySelector('.modal [data-confirm]')`);
    await page.eval(`document.querySelector('.modal [data-confirm]').click(); return true;`);
    await sleep(700);
    const after = await page.eval(`
      return {
        maps: __yinian.S.maps.length,
        titles: __yinian.S.maps.map(m => m.title),
        rootInherited: (__yinian.S.maps[__yinian.S.maps.length-1].root.ruleInherited || null),
        contentRule: __yinian.resolveRule(
          __yinian.S.maps[__yinian.S.maps.length-1].root,
          __yinian.S.maps[__yinian.S.maps.length-1].root.id
        ).template.id,
      };`);
    assertEqual(after.maps, before.maps + 1, '未生成新导图');
    assert(after.titles.includes(before.childTitle), '新导图标题不同步');
    assert(after.rootInherited && after.rootInherited.template === 'anime', '未记录继承的规则');
    assertEqual(after.contentRule, 'anime', '脱离后的根节点未沿用继承规则');
  });

  await check('页面无未处理异常', async () => {
    const noise = [/favicon/i, /auth\.json/i, /Failed to load resource/i, /download/i, /密码不正确/];
    const errs = [...page.pageErrors, ...page.consoleErrors].filter((e) => e && !noise.some((n) => n.test(e)));
    assertEqual(errs.length, 0, `存在页面错误: ${errs.slice(0, 3).join(' | ')}`);
  });

  await page.close();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`新功能结果：${passed} 通过 / ${failed} 失败 / 共 ${results.length} 项`);
  if (failed) {
    console.log('\n失败详情：');
    results.filter((r) => !r.pass).forEach((r) => console.log(`- ${r.name}: ${r.error}`));
    process.exitCode = 1;
  }
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

main().catch((err) => {
  console.error('测试运行失败：', err);
  if (page) page.close();
  process.exitCode = 1;
});

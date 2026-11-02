import { launch, Page } from './cdp.mjs';

const file = new URL('../思维导图.html', import.meta.url);
const url = file.href + '?test=1';
const cdp = await launch({ port: 9451, userDataDir: '/tmp/yn-smoke-' + Date.now() });
const page = new Page(cdp);
await page.init();
await page.goto(url);
try {
  await page.waitFor('!!window.__yinian', { timeout: 8000 });
  console.log('OK 应用已启动');
  const st = await page.eval(`return JSON.stringify({ ready: window.__yinian.S.ready, locked: window.__yinian.S.locked, hasAuth: !!window.__yinian.S.store.auth, title: document.title });`);
  console.log('STATE', st);
} catch (e) {
  console.log('FAIL', e.message);
}
console.log('PAGE ERRORS', JSON.stringify(page.pageErrors, null, 1));
console.log('CONSOLE ERRORS', JSON.stringify(page.consoleErrors.slice(0, 8), null, 1));
cdp.proc.kill('SIGKILL');
process.exit(0);

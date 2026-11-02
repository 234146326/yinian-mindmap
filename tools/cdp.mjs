/* 极简 CDP 客户端：用 Chrome 无头模式驱动真实浏览器完成端到端测试
 * 不依赖 puppeteer/playwright。
 */

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BROWSER_LEVEL = /^(Target|Browser|SystemInfo|Storage)\./;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* 继续 */
    }
  }
  return null;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        (this.handlers.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    const msg = { id, method, params };
    // 浏览器级域名走浏览器会话，其余命令带上页面会话
    if (this.sessionId && !BROWSER_LEVEL.test(method)) msg.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}

export async function launch({ port = 9333, userDataDir = '/tmp/yinian-e2e-profile', headless = true } = {}) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('未找到 Chrome/Chromium，无法运行端到端测试');
  const args = [
    headless ? '--headless=new' : '--new-window',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--hide-scrollbars',
    '--disable-extensions',
    '--remote-allow-origins=*',
    '--disable-background-timer-throttling',
    '--window-size=1600,1000',
    'about:blank',
  ];
  const proc = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {});

  // 通过浏览器级 WebSocket 连接，再显式创建并挂载页面会话，
  // 避免默认 about:blank target 偶发不可用导致的连接不稳定。
  let version = null;
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      version = await res.json();
      if (version && version.webSocketDebuggerUrl) break;
    } catch {
      /* 等待启动 */
    }
    await sleep(100);
  }
  if (!version || !version.webSocketDebuggerUrl) {
    proc.kill('SIGKILL');
    throw new Error('Chrome 启动失败');
  }

  const cdp = await CDP.connect(version.webSocketDebuggerUrl);
  cdp.proc = proc;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  cdp.targetId = targetId;
  cdp.sessionId = sessionId;
  return cdp;
}

/* ---------------- 页面操作 ---------------- */

export class Page {
  constructor(cdp) {
    this.cdp = cdp;
    this.consoleErrors = [];
    this.pageErrors = [];
    this.dialogs = [];
  }

  async init({ downloadPath } = {}) {
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Log.enable');
    this.cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        this.consoleErrors.push(p.args.map((a) => a.value || a.description || '').join(' '));
      }
    });
    this.cdp.on('Runtime.exceptionThrown', (p) => {
      this.pageErrors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text);
    });
    this.cdp.on('Log.entryAdded', (p) => {
      if (p.entry.level === 'error') this.consoleErrors.push(p.entry.text);
    });
    this.cdp.on('Page.javascriptDialogOpening', async (p) => {
      this.dialogs.push(p.message);
      await this.cdp.send('Page.handleJavaScriptDialog', { accept: true });
    });
    if (downloadPath) {
      await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath }).catch(() => {});
    }
  }

  async goto(url, { waitFor } = {}) {
    const loaded = new Promise((resolve) => {
      const h = () => resolve();
      this.cdp.on('Page.loadEventFired', h);
      setTimeout(resolve, 15000);
    });
    await this.cdp.send('Page.navigate', { url });
    await loaded;
    if (waitFor) await this.waitFor(waitFor);
  }

  async reload({ waitFor } = {}) {
    const href = await this.eval('return location.href;');
    await this.goto(href, { waitFor });
  }

  async eval(expression) {
    const res = await this.cdp.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`页面执行出错: ${d.exception?.description || d.text}`);
    }
    return res.result.value;
  }

  async waitFor(expression, { timeout = 8000, interval = 100 } = {}) {
    const started = Date.now();
    let lastErr = null;
    while (Date.now() - started < timeout) {
      try {
        const ok = await this.eval(`return (${expression});`);
        if (ok) return ok;
      } catch (err) {
        lastErr = err;
      }
      await sleep(interval);
    }
    throw new Error(`等待条件超时: ${expression}${lastErr ? ` (${lastErr.message})` : ''}`);
  }

  async $(selector) {
    const box = await this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    `);
    return box;
  }

  async click(selector, { clickCount = 1 } = {}) {
    const box = await this.$(selector);
    if (!box) throw new Error(`找不到元素: ${selector}`);
    await this.clickAt(box.x, box.y, { clickCount });
    return box;
  }

  async clickAt(x, y, { clickCount = 1 } = {}) {
    for (let i = 1; i <= clickCount; i += 1) {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: i,
      });
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: i,
      });
      await sleep(30);
    }
  }

  async dblclick(selector) {
    const box = await this.$(selector);
    if (!box) throw new Error(`找不到元素: ${selector}`);
    await this.clickAt(box.x, box.y, { clickCount: 1 });
    await sleep(40);
    await this.clickAt(box.x, box.y, { clickCount: 2 });
    await sleep(60);
  }

  async moveTo(x, y) {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  }

  async drag(from, to) {
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    const steps = 12;
    for (let i = 1; i <= steps; i += 1) {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
        button: 'left',
        buttons: 1,
      });
      await sleep(16);
    }
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await sleep(120);
  }

  async key(key, { modifiers = 0 } = {}) {
    const codes = {
      Tab: 9,
      Enter: 13,
      Escape: 27,
      Backspace: 8,
      Delete: 46,
      ' ': 32,
      ArrowUp: 38,
      ArrowDown: 40,
      ArrowLeft: 37,
      ArrowRight: 39,
      F2: 113,
    };
    const code = codes[key] || key.toUpperCase().charCodeAt(0);
    // 只有可打印字符才带 text，否则 Chrome 会返回 Invalid 'text' parameter
    let text = null;
    if (key === 'Enter') text = '\r';
    else if (key === 'Tab') text = null;
    else if (key.length === 1) text = key;
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
      text: text === null ? undefined : text,
      unmodifiedText: text === null ? undefined : text,
      modifiers,
    });
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
      modifiers,
    });
    await sleep(40);
  }

  async type(text) {
    await this.cdp.send('Input.insertText', { text });
    await sleep(20);
  }

  async fill(selector, value) {
    await this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('missing ${selector}');
      el.focus();
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await sleep(50);
  }

  async text(selector) {
    return this.eval(`return document.querySelector(${JSON.stringify(selector)})?.textContent || '';`);
  }

  async close() {
    this.cdp.close();
    if (this.cdp.proc) this.cdp.proc.kill('SIGKILL');
  }
}

export { sleep };

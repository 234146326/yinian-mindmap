import { launch } from './cdp.mjs';
const cdp = await launch({ port: 9391, userDataDir: `/tmp/dbg-profile-${Date.now()}` });
console.log('connected');
cdp.ws.addEventListener('message', (ev) => console.log('RAW', typeof ev.data, String(ev.data).slice(0, 240)));
cdp.ws.addEventListener('close', (e) => console.log('CLOSE', e.code, e.reason));
cdp.ws.addEventListener('error', (e) => console.log('ERR', e.message || e));
try {
  const r = await cdp.send('Browser.getVersion');
  console.log('version', r);
} catch (e) {
  console.log('send err', e.message);
}
try {
  const r = await cdp.send('Target.getTargets');
  console.log('targets', r.targetInfos.map((t) => t.type));
} catch (e) {
  console.log('send err2', e.message);
}
cdp.proc.kill('SIGKILL');
process.exit(0);

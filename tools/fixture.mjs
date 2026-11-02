/* 测试夹具：把「访客自设密码」版本构建到 /tmp，避免测试依赖线上/正式产物的固定密码。
 * 各端到端脚本在未显式提供 BASE_URL 时用它作为入口。
 */

import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = '/tmp/yinian-fixture';
const OUT = `${DIR}/index.html`;

export async function buildFixture() {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  await run('python3', ['build.py', '--no-auth', '--out', OUT], { cwd: ROOT });
  return `file://${OUT}`;
}

export const fixtureUrl = await buildFixture();
export default fixtureUrl;

/* 固定访问密码（内嵌 profile）的纯逻辑测试 + 构建脚本派生一致性
 * 运行：node --test tools/*.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { deriveMaterial, fingerprint } from '../src/js/crypto.js';
import {
  normalizeProfile,
  matchesPassword,
  isStaleLocalProfile,
  samePasswordProfile,
} from '../src/js/authguard.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ITERATIONS = 100000;
const salt = randomBytes(16).toString('base64');
const secret = randomBytes(9).toString('base64url');

async function makeProfile(password, overrides = {}) {
  const material = await deriveMaterial(password, salt, ITERATIONS);
  return {
    salt,
    iterations: ITERATIONS,
    verifier: material.verifier,
    fingerprint: fingerprint(salt),
    ...overrides,
  };
}

test('normalizeProfile 保留密钥版本号，缺省为 1', () => {
  assert.equal(normalizeProfile({ salt: 's', iterations: 200000, verifier: 'v' }).version, 1);
  assert.equal(
    normalizeProfile({ salt: 's', iterations: 200000, verifier: 'v', keyVersion: 4 }).version,
    4,
  );
});

test('normalizeProfile 读取扁平结构并补齐指纹', () => {
  const p = normalizeProfile({ salt: 'abc', iterations: 200000, verifier: 'v1' });
  assert.equal(p.salt, 'abc');
  assert.equal(p.iterations, 200000);
  assert.equal(p.verifier, 'v1');
  assert.equal(p.fingerprint, fingerprint('abc'));
  assert.equal(p.source, 'builtin');
});

test('normalizeProfile 兼容 auth.json 的 pbkdf2 嵌套结构', () => {
  const p = normalizeProfile({
    pbkdf2: { algorithm: 'PBKDF2-SHA256', salt: 's', iterations: 300000, verifier: 'vv' },
    fingerprint: 'deadbeef',
  });
  assert.equal(p.salt, 's');
  assert.equal(p.verifier, 'vv');
  assert.equal(p.fingerprint, 'deadbeef');
});

test('normalizeProfile 拒绝残缺或过低迭代的配置', () => {
  assert.equal(normalizeProfile(null), null);
  assert.equal(normalizeProfile({}), null);
  assert.equal(normalizeProfile({ salt: '', iterations: 200000, verifier: 'v' }), null);
  assert.equal(normalizeProfile({ salt: 's', iterations: 200000 }), null);
  assert.equal(normalizeProfile({ salt: 's', iterations: 10, verifier: 'v' }), null);
  assert.equal(normalizeProfile({ salt: 's', iterations: 'x', verifier: 'v' }), null);
});

test('matchesPassword 只接受与内嵌配置一致的密码', async () => {
  const profile = await makeProfile(secret);
  assert.equal(await matchesPassword(profile, secret), true);
  assert.equal(await matchesPassword(profile, `${secret}x`), false);
  assert.equal(await matchesPassword(profile, ''), false);
  assert.equal(await matchesPassword(profile, null), false);
  assert.equal(await matchesPassword(null, secret), false);
});

test('isStaleLocalProfile 识别提供者换过密码的情形', async () => {
  const profile = await makeProfile(secret);
  const local = await makeProfile(secret);
  assert.equal(isStaleLocalProfile(profile, local), false);
  assert.equal(isStaleLocalProfile(profile, null), false);
  assert.equal(isStaleLocalProfile(null, local), false);
  const rotated = await makeProfile(`${secret}-new`);
  assert.equal(isStaleLocalProfile(profile, rotated), true);
});

test('samePasswordProfile 依据 salt 与 verifier 判断同一密码', async () => {
  const a = await makeProfile(secret);
  const b = await makeProfile(secret);
  const c = await makeProfile(`${secret}!`);
  assert.equal(samePasswordProfile(a, b), true);
  assert.equal(samePasswordProfile(a, c), false);
});

test('build.py 的 PBKDF2 派生与浏览器端完全一致', async () => {
  const material = await deriveMaterial(secret, salt, ITERATIONS);
  const out = execFileSync(
    'python3',
    [
      '-c',
      'import sys, build; print(build.derive_verifier(sys.argv[1], sys.argv[2], int(sys.argv[3]))); print(build.fingerprint_of(sys.argv[2]))',
      secret,
      salt,
      String(ITERATIONS),
    ],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim().split('\n');
  assert.equal(out[0], material.verifier);
  assert.equal(out[1], fingerprint(salt));
});

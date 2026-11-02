import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveMaterial,
  newSalt,
  encryptJSON,
  decryptJSON,
  encryptText,
  decryptText,
  encryptBytes,
  decryptBytes,
  b64encode,
  b64decode,
  timingSafeEqual,
  MIN_ITERATIONS,
} from '../src/js/crypto.js';

const ITER = MIN_ITERATIONS;
const salt = newSalt();

test('salt 为 16 字节随机值且每次不同', () => {
  const a = newSalt();
  const b = newSalt();
  assert.notEqual(a, b);
  assert.equal(b64decode(a).length, 16);
});

test('同一密码 + salt 派生结果稳定', async () => {
  const m1 = await deriveMaterial('p@ssw0rd', salt, ITER);
  const m2 = await deriveMaterial('p@ssw0rd', salt, ITER);
  assert.equal(m1.verifier, m2.verifier);
  assert.equal(timingSafeEqual(m1.verifier, m2.verifier), true);
});

test('错误密码派生结果不同', async () => {
  const right = await deriveMaterial('p@ssw0rd', salt, ITER);
  const wrong = await deriveMaterial('p@ssw0rd!', salt, ITER);
  assert.notEqual(right.verifier, wrong.verifier);
});

test('不同 salt 同一密码派生结果不同', async () => {
  const m1 = await deriveMaterial('same', salt, ITER);
  const m2 = await deriveMaterial('same', newSalt(), ITER);
  assert.notEqual(m1.verifier, m2.verifier);
});

test('JSON 加密解密往返', async () => {
  const { key } = await deriveMaterial('secret', salt, ITER);
  const data = { a: 1, 中文: '内容', list: [1, 2, 3] };
  const enc = await encryptJSON(key, data);
  assert.ok(enc.iv && enc.ct);
  const back = await decryptJSON(key, enc);
  assert.deepEqual(back, data);
});

test('每次加密 IV 不同（语义安全）', async () => {
  const { key } = await deriveMaterial('secret', salt, ITER);
  const e1 = await encryptText(key, 'same text');
  const e2 = await encryptText(key, 'same text');
  assert.notEqual(e1.iv, e2.iv);
  assert.notEqual(e1.ct, e2.ct);
});

test('错误密钥无法解密（GCM 校验失败）', async () => {
  const { key } = await deriveMaterial('secret', salt, ITER);
  const other = await deriveMaterial('secret2', salt, ITER);
  const enc = await encryptText(key, 'paylaod');
  await assert.rejects(() => decryptText(other.key, enc));
});

test('密文被篡改会被检测', async () => {
  const { key } = await deriveMaterial('secret', salt, ITER);
  const enc = await encryptText(key, 'important');
  const bytes = b64decode(enc.ct);
  bytes[0] ^= 0xff;
  await assert.rejects(() => decryptText(key, { iv: enc.iv, ct: b64encode(bytes) }));
});

test('二进制（媒体）往返一致', async () => {
  const { key } = await deriveMaterial('secret', salt, ITER);
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
  const enc = await encryptBytes(key, bytes);
  const back = await decryptBytes(key, enc);
  assert.deepEqual([...back], [...bytes]);
});

test('base64 编解码支持大块数据', () => {
  const bytes = new Uint8Array(200000).map((_, i) => i % 256);
  const round = b64decode(b64encode(bytes));
  assert.equal(round.length, bytes.length);
  assert.equal(round[199999], bytes[199999]);
});

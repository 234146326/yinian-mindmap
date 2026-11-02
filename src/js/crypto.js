/* 加密层：PBKDF2-SHA256 派生密钥，AES-256-GCM 加密数据与媒体
 * 说明：数据全部在浏览器本地加解密，密钥不落盘，仅由密码派生。
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const DEFAULT_ITERATIONS = 260000;
export const MIN_ITERATIONS = 100000;

export function randomBytes(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

export function b64encode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function b64decode(str) {
  const bin = atob(String(str || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function newSalt() {
  return b64encode(randomBytes(16));
}

async function pbkdf2Bits(password, saltString, iterations, bits = 256) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const buf = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(saltString), iterations, hash: 'SHA-256' },
    baseKey,
    bits,
  );
  return new Uint8Array(buf);
}

/**
 * 由密码派生数据密钥与校验串。
 * 同一密码 + 同一 salt 必然得到同一结果，因此无需存储密钥本身。
 */
export async function deriveMaterial(password, saltB64, iterations = DEFAULT_ITERATIONS) {
  if (!password) throw new Error('密码不能为空');
  if (!saltB64) throw new Error('缺少 salt');
  const iter = Math.max(MIN_ITERATIONS, Number(iterations) || DEFAULT_ITERATIONS);
  const [dekRaw, verifyRaw] = await Promise.all([
    pbkdf2Bits(password, `${saltB64}|yinian|dek`, iter),
    pbkdf2Bits(password, `${saltB64}|yinian|verify`, iter),
  ]);
  const key = await crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  return { key, verifier: b64encode(verifyRaw), iterations: iter };
}

export function timingSafeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function encryptBytes(key, bytes) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv: b64encode(iv), ct: b64encode(ct) };
}

export async function decryptBytes(key, payload) {
  if (!payload || !payload.iv || !payload.ct) throw new Error('密文格式错误');
  const iv = b64decode(payload.iv);
  const ct = b64decode(payload.ct);
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new Uint8Array(buf);
}

export async function encryptText(key, text) {
  return encryptBytes(key, enc.encode(text));
}

export async function decryptText(key, payload) {
  const bytes = await decryptBytes(key, payload);
  return dec.decode(bytes);
}

export async function encryptJSON(key, value) {
  return encryptText(key, JSON.stringify(value));
}

export async function decryptJSON(key, payload) {
  const text = await decryptText(key, payload);
  return JSON.parse(text);
}

/** 指纹：用于在界面上辨认 salt 是否变化（不泄露密码） */
export function fingerprint(saltB64) {
  let h = 0;
  for (let i = 0; i < saltB64.length; i += 1) h = (h * 31 + saltB64.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0').slice(0, 8);
}

/* 固定访问密码（由提供者指定）
 *
 * 构建时把 {salt, iterations, verifier} 内嵌进单文件 HTML：
 *   - verifier 是 PBKDF2 派生值，页面里没有明文密码；
 *   - 运行时只接受与该 verifier 匹配的密码，访客无法自行设置或修改；
 *   - 任何人都能读到 verifier（静态页面的固有边界），所以密码本身要足够长。
 */

import { deriveMaterial, fingerprint } from './crypto.js';

export const PROFILE_SOURCE = 'builtin';

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 归一化外部传入的密码配置（兼容 auth.json 的 {pbkdf2:{...}} 结构）。
 * 非法的配置返回 null，调用方据此回退到「访客自设密码」模式。
 */
export function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const box = raw.pbkdf2 && typeof raw.pbkdf2 === 'object' ? raw.pbkdf2 : raw;
  const salt = str(box.salt);
  const verifier = str(box.verifier);
  const iterations = Number(box.iterations);
  if (!salt || !verifier) return null;
  if (!Number.isFinite(iterations) || iterations < 1000) return null;
  return {
    salt,
    verifier,
    iterations: Math.round(iterations),
    fingerprint: str(raw.fingerprint) || fingerprint(salt),
    version: Number(raw.keyVersion) > 0 ? Math.round(Number(raw.keyVersion)) : 1,
    source: PROFILE_SOURCE,
  };
}

/** 密码是否与固定配置一致（不产生副作用，可用于纯校验） */
export async function matchesPassword(profile, password) {
  const p = normalizeProfile(profile);
  if (!p) return false;
  if (typeof password !== 'string' || !password) return false;
  const material = await deriveMaterial(password, p.salt, p.iterations);
  return material.verifier === p.verifier;
}

/** 两份配置是否指向同一密码（salt 与 verifier 都相同） */
export function samePasswordProfile(a, b) {
  const x = normalizeProfile(a);
  const y = normalizeProfile(b);
  if (!x || !y) return false;
  return x.salt === y.salt && x.verifier === y.verifier;
}

/** 本地工作空间是否是用另一套密码配置加密的（提供者换过密码） */
export function isStaleLocalProfile(profile, localAuth) {
  if (!profile || !localAuth) return false;
  return localAuth.verifier !== profile.verifier || localAuth.salt !== profile.salt;
}

/* 本地持久化：IndexedDB + AES-GCM 加密
 * 所有业务数据（导图、媒体、快照）都以密文存储，索引也加密，
 * 只有密码派生出的密钥才能读出内容。
 */

import {
  deriveMaterial,
  newSalt,
  encryptJSON,
  decryptJSON,
  encryptBytes,
  decryptBytes,
  b64encode,
  fingerprint,
  DEFAULT_ITERATIONS,
} from './crypto.js';
import { uid, nowISO, isPlainObject } from './util.js';

const DB_NAME = 'yinian-v1';
const DB_VERSION = 1;
const MAX_SNAPSHOTS = 8;

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务已中止'));
  });
}

export class Store {
  constructor() {
    this.db = null;
    this.key = null;
    this.auth = null;
    this._mediaCache = new Map();
  }

  get unlocked() {
    return !!this.key;
  }

  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('maps')) db.createObjectStore('maps', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('snapshots')) {
          const s = db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
          s.createIndex('ts', 'ts');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db;
  }

  async getMeta(k) {
    const db = await this.open();
    return req(db.transaction('meta').objectStore('meta').get(k));
  }

  async setMeta(k, value) {
    const db = await this.open();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ k, ...value });
    await txDone(tx);
  }

  async removeMeta(k) {
    const db = await this.open();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').delete(k);
    await txDone(tx);
  }

  /* ---------------- 密码与解锁 ---------------- */

  async readAuth() {
    const record = await this.getMeta('auth');
    this.auth = record || null;
    return this.auth;
  }

  async hasWorkspace() {
    const auth = await this.readAuth();
    return !!auth;
  }

  /**
   * 首次设置密码。可选传入外部 auth.json 的 salt/verifier 以“沿用”既有密码配置。
   */
  async setupPassword(password, opts = {}) {
    const iterations = Math.max(100000, Number(opts.iterations) || DEFAULT_ITERATIONS);
    const salt = opts.salt || newSalt();
    const material = await deriveMaterial(password, salt, iterations);
    if (opts.verifier && opts.verifier !== material.verifier) {
      throw new Error('密码与提供的配置文件不匹配');
    }
    this.key = material.key;
    const auth = {
      k: 'auth',
      v: 1,
      salt,
      iterations,
      verifier: material.verifier,
      fingerprint: fingerprint(salt),
      source: opts.source || 'local',
      createdAt: nowISO(),
    };
    await this.setMeta('auth', auth);
    this.auth = auth;
    return auth;
  }

  async unlock(password) {
    const auth = await this.readAuth();
    if (!auth) throw new Error('尚未设置密码');
    const material = await deriveMaterial(password, auth.salt, auth.iterations);
    if (material.verifier !== auth.verifier) {
      const err = new Error('密码不正确');
      err.code = 'BAD_PASSWORD';
      throw err;
    }
    this.key = material.key;
    return true;
  }

  lock() {
    this.key = null;
    this._mediaCache.clear();
  }

  async changePassword(currentPassword, newPassword) {
    await this.unlock(currentPassword);
    const oldKey = this.key;
    const previousAuth = { ...this.auth };

    // 1. 读出全部密文
    const db = await this.open();
    const mapRecords = await req(db.transaction('maps').objectStore('maps').getAll());
    const mediaRecords = await req(db.transaction('media').objectStore('media').getAll());
    const snapshotRecords = await req(db.transaction('snapshots').objectStore('snapshots').getAll());
    const wsRecord = await this.getMeta('ws');
    const oldSnapshotPayloads = [];
    for (const s of snapshotRecords) {
      try {
        oldSnapshotPayloads.push({ ...s, payload: await decryptJSON(oldKey, s) });
      } catch {
        /* 忽略损坏快照 */
      }
    }

    // 2. 用新密码重新加密（先算完所有密文，再一次性写入，避免事务失活）
    const salt = newSalt();
    const material = await deriveMaterial(newPassword, salt, previousAuth.iterations);
    const newKey = material.key;

    const newMapRecords = [];
    for (const rec of mapRecords) {
      const data = await decryptJSON(oldKey, rec);
      const enc = await encryptJSON(newKey, data);
      newMapRecords.push({ id: rec.id, updatedAt: rec.updatedAt, ...enc });
    }
    const newMediaRecords = [];
    for (const rec of mediaRecords) {
      const bytes = await decryptBytes(oldKey, rec);
      const enc = await encryptBytes(newKey, bytes);
      newMediaRecords.push({ id: rec.id, mime: rec.mime, name: rec.name, size: rec.size, ...enc });
    }
    const newSnapshots = [];
    for (const s of oldSnapshotPayloads) {
      const enc = await encryptJSON(newKey, s.payload);
      newSnapshots.push({ ts: s.ts, label: s.label, kind: s.kind, ...enc });
    }
    let newWs = null;
    if (wsRecord) {
      const ws = await decryptJSON(oldKey, wsRecord);
      newWs = await encryptJSON(newKey, ws);
    }

    const tx = db.transaction(['maps', 'media', 'snapshots', 'meta'], 'readwrite');
    const mapsStore = tx.objectStore('maps');
    const mediaStore = tx.objectStore('media');
    const snapStore = tx.objectStore('snapshots');
    const metaStore = tx.objectStore('meta');

    for (const rec of newMapRecords) mapsStore.put(rec);
    for (const rec of newMediaRecords) mediaStore.put(rec);
    snapStore.clear();
    for (const rec of newSnapshots) snapStore.put(rec);
    if (newWs) metaStore.put({ k: 'ws', ...newWs });
    metaStore.put({
      k: 'auth',
      v: 1,
      salt,
      iterations: previousAuth.iterations,
      verifier: material.verifier,
      fingerprint: fingerprint(salt),
      source: 'local',
      createdAt: previousAuth.createdAt || nowISO(),
      updatedAt: nowISO(),
    });
    await txDone(tx);

    this.key = newKey;
    this.auth = {
      k: 'auth',
      v: 1,
      salt,
      iterations: previousAuth.iterations,
      verifier: material.verifier,
      fingerprint: fingerprint(salt),
      source: 'local',
    };
    this._mediaCache.clear();
    return true;
  }

  /* ---------------- 工作区索引 ---------------- */

  async loadWorkspace() {
    const wsRecord = await this.getMeta('ws');
    const db = await this.open();
    const mapRecords = await req(db.transaction('maps').objectStore('maps').getAll());

    let index = null;
    if (wsRecord) {
      try {
        index = await decryptJSON(this.key, wsRecord);
      } catch (err) {
        index = null;
      }
    }

    const maps = [];
    const broken = [];
    for (const rec of mapRecords) {
      try {
        const map = await decryptJSON(this.key, rec);
        maps.push(map);
      } catch (err) {
        broken.push(rec.id);
      }
    }

    // 索引缺失时用实际数据重建，避免“数据还在但列表空了”
    const indexIds = new Set((index && index.maps ? index.maps : []).map((m) => m.id));
    const missingFromIndex = maps.filter((m) => !indexIds.has(m.id));
    const order = index && Array.isArray(index.maps) ? index.maps.map((m) => m.id) : [];
    maps.sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      if (ia === -1 && ib === -1) return String(b.updatedAt).localeCompare(String(a.updatedAt));
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    return {
      maps,
      settings: (index && index.settings) || {},
      lastMapId: (index && index.lastMapId) || null,
      broken,
      rebuilt: !index || missingFromIndex.length > 0,
    };
  }

  async saveWorkspace(meta) {
    const payload = {
      version: 1,
      maps: meta.maps.map((m) => ({
        id: m.id,
        title: m.title,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
      settings: meta.settings || {},
      lastMapId: meta.lastMapId || null,
      updatedAt: nowISO(),
    };
    const enc = await encryptJSON(this.key, payload);
    await this.setMeta('ws', enc);
    return payload;
  }

  /* ---------------- 导图 ---------------- */

  async saveMap(map) {
    const enc = await encryptJSON(this.key, map);
    const db = await this.open();
    const tx = db.transaction('maps', 'readwrite');
    tx.objectStore('maps').put({ id: map.id, updatedAt: map.updatedAt || nowISO(), ...enc });
    await txDone(tx);
  }

  async deleteMap(id) {
    const db = await this.open();
    const tx = db.transaction('maps', 'readwrite');
    tx.objectStore('maps').delete(id);
    await txDone(tx);
  }

  /* ---------------- 媒体 ---------------- */

  async putMedia(blob, info = {}) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const enc = await encryptBytes(this.key, bytes);
    const id = uid('md');
    const record = {
      id,
      mime: blob.type || info.mime || 'application/octet-stream',
      name: info.name || blob.name || '媒体文件',
      size: bytes.byteLength,
      ...enc,
    };
    const db = await this.open();
    const tx = db.transaction('media', 'readwrite');
    tx.objectStore('media').put(record);
    await txDone(tx);
    return { id, mime: record.mime, name: record.name, size: record.size };
  }

  async getMediaBlob(id) {
    if (!id) return null;
    if (this._mediaCache.has(id)) return this._mediaCache.get(id);
    const db = await this.open();
    const rec = await req(db.transaction('media').objectStore('media').get(id));
    if (!rec) return null;
    const bytes = await decryptBytes(this.key, rec);
    const blob = new Blob([bytes], { type: rec.mime || 'application/octet-stream' });
    this._mediaCache.set(id, blob);
    return blob;
  }

  async getMediaDataURL(id) {
    const blob = await this.getMediaBlob(id);
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return `data:${blob.type || 'application/octet-stream'};base64,${b64encode(bytes)}`;
  }

  async listMediaRecords() {
    const db = await this.open();
    return req(db.transaction('media').objectStore('media').getAll());
  }

  /* ---------------- 快照 ---------------- */

  async createSnapshot(label, maps, meta = {}) {
    if (!this.key) return null;
    const payload = {
      version: 1,
      label: label || '自动快照',
      createdAt: nowISO(),
      maps: maps.map((m) => ({ ...m })),
      meta,
    };
    const enc = await encryptJSON(this.key, payload);
    const db = await this.open();
    const tx = db.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').add({ ts: Date.now(), label: payload.label, kind: meta.kind || 'manual', ...enc });
    await txDone(tx);
    await this.trimSnapshots();
    return payload;
  }

  async listSnapshots() {
    const db = await this.open();
    const records = await req(db.transaction('snapshots').objectStore('snapshots').getAll());
    return records
      .map((r) => ({ id: r.id, ts: r.ts, label: r.label, kind: r.kind }))
      .sort((a, b) => b.ts - a.ts);
  }

  async readSnapshot(id) {
    const db = await this.open();
    const rec = await req(db.transaction('snapshots').objectStore('snapshots').get(Number(id)));
    if (!rec) throw new Error('快照不存在');
    return decryptJSON(this.key, rec);
  }

  async deleteSnapshot(id) {
    const db = await this.open();
    const tx = db.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').delete(Number(id));
    await txDone(tx);
  }

  async trimSnapshots(max = MAX_SNAPSHOTS) {
    const list = await this.listSnapshots();
    if (list.length <= max) return;
    const db = await this.open();
    const tx = db.transaction('snapshots', 'readwrite');
    for (const s of list.slice(max)) tx.objectStore('snapshots').delete(s.id);
    await txDone(tx);
  }

  /* ---------------- 维护 ---------------- */

  async usage() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        return { usage: est.usage || 0, quota: est.quota || 0 };
      } catch {
        return null;
      }
    }
    return null;
  }

  async wipeAll() {
    const db = await this.open();
    const tx = db.transaction(['meta', 'maps', 'media', 'snapshots'], 'readwrite');
    for (const name of ['meta', 'maps', 'media', 'snapshots']) tx.objectStore(name).clear();
    await txDone(tx);
    this.lock();
  }

  async exportAuthConfig() {
    const auth = await this.readAuth();
    if (!auth) throw new Error('尚未设置密码');
    return {
      version: 1,
      app: 'yinian',
      note: '此文件只包含密码校验所需的信息，不含明文密码。请与服务端/静态资源分开存放。',
      pbkdf2: {
        algorithm: 'PBKDF2-SHA256',
        salt: auth.salt,
        iterations: auth.iterations,
        verifier: auth.verifier,
      },
      fingerprint: auth.fingerprint,
      createdAt: auth.createdAt || nowISO(),
      updatedAt: nowISO(),
    };
  }
}

export function isAuthConfig(obj) {
  return isPlainObject(obj) && isPlainObject(obj.pbkdf2) && !!obj.pbkdf2.salt && !!obj.pbkdf2.verifier;
}

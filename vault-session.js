(() => {
  'use strict';

  const DB_NAME = 'sharecapsule-private-finance';
  const DB_VERSION = 1;
  const STORE_NAME = 'vaults';
  const WRAP_KEY_ID = 'vault-session-wrap-key';
  const STORAGE_KEY = 'sharecapsule-finance-vault-session-v1';
  const MAX_IDLE_MS = 10 * 60 * 1000;

  function toBase64(bytes) {
    let binary = '';
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  function fromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function readRecord(id) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  async function writeRecord(record) {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  async function ensureWrapKey() {
    const existing = await readRecord(WRAP_KEY_ID);
    if (existing?.key) return existing.key;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await writeRecord({ id: WRAP_KEY_ID, key, createdAt: new Date().toISOString() });
    return key;
  }

  function readMetadata({ clearExpired = true } = {}) {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || data.version !== 1 || typeof data.iv !== 'string' || typeof data.wrappedKey !== 'string' || !Number.isFinite(data.touchedAt)) {
        if (clearExpired) sessionStorage.removeItem(STORAGE_KEY);
        return null;
      }
      if (Date.now() - data.touchedAt > MAX_IDLE_MS) {
        if (clearExpired) sessionStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return data;
    } catch (_) {
      if (clearExpired) {
        try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
      }
      return null;
    }
  }

  function announce(active) {
    try {
      document.documentElement.dataset.vaultSession = active ? 'active' : 'locked';
      window.dispatchEvent(new CustomEvent('sharecapsule:vault-session', { detail: { active } }));
    } catch (_) {}
  }

  async function start(rawVaultKey) {
    const bytes = rawVaultKey instanceof Uint8Array ? rawVaultKey : new Uint8Array(rawVaultKey || []);
    if (bytes.byteLength !== 32) throw new Error('Vault session requires a 256-bit vault key');
    const wrapKey = await ensureWrapKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, bytes);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      iv: toBase64(iv),
      wrappedKey: toBase64(ciphertext),
      createdAt: Date.now(),
      touchedAt: Date.now()
    }));
    announce(true);
  }

  async function restoreKey() {
    const data = readMetadata();
    if (!data) return null;
    const record = await readRecord(WRAP_KEY_ID);
    if (!record?.key) {
      clear();
      return null;
    }
    let raw = null;
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(data.iv) }, record.key, fromBase64(data.wrappedKey));
      raw = new Uint8Array(plaintext);
      if (raw.byteLength !== 32) throw new Error('Invalid vault session key');
      const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      touch();
      return key;
    } catch (error) {
      clear();
      throw error;
    } finally {
      if (raw) raw.fill(0);
    }
  }

  function isActive() {
    const active = Boolean(readMetadata());
    announce(active);
    return active;
  }

  function touch() {
    const data = readMetadata();
    if (!data) {
      announce(false);
      return false;
    }
    data.touchedAt = Date.now();
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      announce(true);
      return true;
    } catch (_) {
      return false;
    }
  }

  function clear() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
    announce(false);
  }

  function bindActivity() {
    let lastTouch = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - lastTouch < 15000) return;
      lastTouch = now;
      touch();
    };
    ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach((eventName) => document.addEventListener(eventName, onActivity, { passive: true }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) touch(); });
  }

  window.ShareCapsuleVaultSession = Object.freeze({
    maxIdleMs: MAX_IDLE_MS,
    start,
    restoreKey,
    isActive,
    touch,
    clear,
    bindActivity
  });

  isActive();
  bindActivity();
})();

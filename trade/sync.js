(() => {
  'use strict';

  const DB_NAME = 'sharecapsule-trade-monitor';
  const DB_VERSION = 1;
  const STORE = 'local';
  const WATCHLIST_ID = 'watchlist';
  const DEVICE_KEY_ID = 'device-key';
  const CONFIG_ID = 'watchlist-sync-config';
  const SYNC_ENDPOINT = 'https://sync.finance.sharecapsule.org';
  const SYNC_INTERVAL_MS = 10000;
  const FORMAT = 'sharecapsule-ticker-watch-v1';
  const CONFIG_AAD = new TextEncoder().encode('sharecapsule-ticker-watch-sync-config-v1');
  const PAYLOAD_AAD = new TextEncoder().encode(FORMAT);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let db;
  let deviceKey;
  let timer = null;
  let busy = false;
  let conflict = null;

  const $ = (id) => document.getElementById(id);

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  function b64(bytes) {
    let text = '';
    for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
    return btoa(text);
  }

  function unb64(text) {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  }

  function b64url(bytes) {
    return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function unb64url(value) {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    return unb64(padded);
  }

  async function sha256Text(value) {
    return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, {keyPath: 'id'});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function get(id) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  function put(record) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function remove(id) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function ensureDeviceKey() {
    const existing = await get(DEVICE_KEY_ID);
    if (existing?.key) return existing.key;
    const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
    await put({id: DEVICE_KEY_ID, key});
    return key;
  }

  async function protectBytes(bytes) {
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: CONFIG_AAD}, deviceKey, bytes);
    return {iv: b64url(iv), ciphertext: b64url(new Uint8Array(ciphertext))};
  }

  async function revealBytes(iv, ciphertext) {
    const plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64url(iv), additionalData: CONFIG_AAD}, deviceKey, unb64url(ciphertext));
    return new Uint8Array(plaintext);
  }

  async function protectText(value) {
    return protectBytes(encoder.encode(value));
  }

  async function revealText(iv, ciphertext) {
    return decoder.decode(await revealBytes(iv, ciphertext));
  }

  async function localWatchlist() {
    const record = await get(WATCHLIST_ID);
    if (!record) return {record: null, tickers: []};
    try {
      const plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(record.iv)}, deviceKey, unb64(record.ciphertext));
      const parsed = JSON.parse(decoder.decode(plaintext));
      const tickers = Array.isArray(parsed) ? parsed.filter((t) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(t)).slice(0, 30) : [];
      return {record, tickers};
    } catch {
      throw new Error('Could not decrypt this device’s ticker watchlist.');
    }
  }

  async function writeLocalWatchlist(tickers, updatedAt = new Date().toISOString()) {
    const clean = Array.from(new Set(tickers.filter((t) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(t)))).slice(0, 30);
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, deviceKey, encoder.encode(JSON.stringify(clean)));
    const record = {id: WATCHLIST_ID, iv: b64(iv), ciphertext: b64(ciphertext), updatedAt};
    await put(record);
    return record;
  }

  async function importContentKey(rawBytes, usages) {
    return crypto.subtle.importKey('raw', rawBytes, {name: 'AES-GCM'}, false, usages);
  }

  async function encryptSyncPayload(tickers, updatedAt, contentKeyBytes) {
    const key = await importContentKey(contentKeyBytes, ['encrypt']);
    const iv = randomBytes(12);
    const plaintext = encoder.encode(JSON.stringify({tickers}));
    const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: PAYLOAD_AAD}, key, plaintext);
    return {format: FORMAT, iv: b64url(iv), ciphertext: b64url(new Uint8Array(ciphertext)), updatedAt};
  }

  async function decryptSyncPayload(payload, contentKeyBytes) {
    if (!payload || payload.format !== FORMAT) throw new Error('Sync relay returned an unknown watchlist format.');
    const key = await importContentKey(contentKeyBytes, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64url(payload.iv), additionalData: PAYLOAD_AAD}, key, unb64url(payload.ciphertext));
    const parsed = JSON.parse(decoder.decode(plaintext));
    if (!Array.isArray(parsed.tickers)) throw new Error('Encrypted watchlist payload is invalid.');
    return parsed.tickers.filter((t) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(t)).slice(0, 30);
  }

  async function api(path, options = {}) {
    const response = await fetch(`${SYNC_ENDPOINT}${path}`, {
      method: options.method || 'GET',
      headers: {'Content-Type': 'application/json', ...(options.authorization ? {Authorization: options.authorization} : {})},
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const error = new Error(body?.error || `Sync service returned ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  async function configSecrets(config) {
    const token = await revealText(config.tokenIv, config.protectedToken);
    const contentKey = await revealBytes(config.keyIv, config.protectedKey);
    return {token, contentKey};
  }

  async function createConfig() {
    let {record, tickers} = await localWatchlist();
    if (!record) record = await writeLocalWatchlist([]);
    const watchlistId = b64url(randomBytes(16));
    const token = b64url(randomBytes(32));
    const deviceId = b64url(randomBytes(12));
    const contentKey = randomBytes(32);
    const payload = await encryptSyncPayload(tickers, record.updatedAt, contentKey);
    const result = await api(`/v1/watchlist/${watchlistId}`, {
      method: 'PUT', authorization: `Bearer ${token}`,
      body: {baseRevision: 0, deviceId, payload}
    });
    const protectedToken = await protectText(token);
    const protectedKey = await protectBytes(contentKey);
    const config = {
      id: CONFIG_ID, watchlistId, deviceId,
      tokenIv: protectedToken.iv, protectedToken: protectedToken.ciphertext,
      keyIv: protectedKey.iv, protectedKey: protectedKey.ciphertext,
      lastRevision: result.revision, lastLocalUpdatedAt: record.updatedAt,
      createdAt: new Date().toISOString(), lastSyncAt: new Date().toISOString()
    };
    await put(config);
    return config;
  }

  async function ensureConfig() {
    return (await get(CONFIG_ID)) || createConfig();
  }

  async function pairKey(secretBytes, usages) {
    const digest = await crypto.subtle.digest('SHA-256', secretBytes);
    return crypto.subtle.importKey('raw', digest, {name: 'AES-GCM'}, false, usages);
  }

  async function wrapForPairing(bytes, secretBytes) {
    const key = await pairKey(secretBytes, ['encrypt']);
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, bytes);
    return {ciphertext: b64url(new Uint8Array(ciphertext)), iv: b64url(iv)};
  }

  async function unwrapFromPairing(ciphertext, iv, secretBytes) {
    const key = await pairKey(secretBytes, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64url(iv)}, key, unb64url(ciphertext));
    return new Uint8Array(plaintext);
  }

  async function pushLocal(config, token, contentKey, force = false, baseRevision = config.lastRevision || 0) {
    let {record, tickers} = await localWatchlist();
    if (!record) record = await writeLocalWatchlist([]);
    const payload = await encryptSyncPayload(tickers, record.updatedAt, contentKey);
    const result = await api(`/v1/watchlist/${config.watchlistId}`, {
      method: 'PUT', authorization: `Bearer ${token}`,
      body: {baseRevision, deviceId: config.deviceId, payload, force}
    });
    config.lastRevision = result.revision;
    config.lastLocalUpdatedAt = record.updatedAt;
    config.lastSyncAt = new Date().toISOString();
    await put(config);
    return result;
  }

  async function applyRemote(config, remote, contentKey, reload = true) {
    const tickers = await decryptSyncPayload(remote.payload, contentKey);
    const record = await writeLocalWatchlist(tickers, remote.payload.updatedAt || new Date().toISOString());
    config.lastRevision = remote.revision;
    config.lastLocalUpdatedAt = record.updatedAt;
    config.lastSyncAt = new Date().toISOString();
    await put(config);
    conflict = null;
    renderState(config, `Applied ${tickers.length} ticker${tickers.length === 1 ? '' : 's'} from another device.`);
    if (reload) setTimeout(() => location.reload(), 450);
  }

  async function syncNow({silent = false} = {}) {
    if (busy || conflict) return;
    busy = true;
    try {
      const config = await get(CONFIG_ID);
      if (!config) return renderState(null);
      const {token, contentKey} = await configSecrets(config);
      const remote = await api(`/v1/watchlist/${config.watchlistId}`, {authorization: `Bearer ${token}`});
      const {record} = await localWatchlist();
      const localUpdatedAt = record?.updatedAt || '';
      const localChanged = localUpdatedAt !== (config.lastLocalUpdatedAt || '');
      const remoteChanged = remote.revision > (config.lastRevision || 0);

      if (localChanged && remoteChanged) {
        conflict = {config, token, contentKey, remote};
        const remoteTickers = await decryptSyncPayload(remote.payload, contentKey);
        showConflict(remoteTickers.length);
        return;
      }
      if (localChanged) {
        try {
          await pushLocal(config, token, contentKey);
        } catch (error) {
          if (error.status === 409 && error.body?.payload) {
            conflict = {config, token, contentKey, remote: error.body};
            const remoteTickers = await decryptSyncPayload(error.body.payload, contentKey);
            showConflict(remoteTickers.length);
            return;
          }
          throw error;
        }
      } else if (remoteChanged) {
        await applyRemote(config, remote, contentKey);
        return;
      } else {
        config.lastSyncAt = new Date().toISOString();
        await put(config);
      }
      if (!silent) renderState(config, 'Encrypted watchlist is up to date.');
      else renderState(config);
    } catch (error) {
      console.error(error);
      renderState(await get(CONFIG_ID), error.message || 'Could not sync watchlist.', true);
    } finally {
      busy = false;
    }
  }

  async function createPairing() {
    try {
      renderState(await get(CONFIG_ID), 'Preparing one-time device pairing…');
      const config = await ensureConfig();
      const {token, contentKey} = await configSecrets(config);
      await pushLocal(config, token, contentKey, true);

      const pairId = b64url(randomBytes(8));
      const secretBytes = randomBytes(24);
      const secret = b64url(secretBytes);
      const secretHash = await sha256Text(secret);
      const wrappedToken = await wrapForPairing(encoder.encode(token), secretBytes);
      const wrappedKey = await wrapForPairing(contentKey, secretBytes);
      const pairing = await api(`/v1/watchlist/${config.watchlistId}/pairings`, {
        method: 'POST', authorization: `Bearer ${token}`,
        body: {
          pairId, secretHash,
          wrappedToken: wrappedToken.ciphertext, tokenWrapIv: wrappedToken.iv,
          wrappedKey: wrappedKey.ciphertext, keyWrapIv: wrappedKey.iv
        }
      });

      const url = `${location.origin}/trade/#tw=${config.watchlistId}.${pairId}.${secret}`;
      $('syncPairLink').value = url;
      $('syncPairPanel').hidden = false;
      $('syncPairExpires').dataset.expiresAt = String(pairing.expiresAt);
      updateCountdown();
      if (window.ShareCapsuleQR?.render) window.ShareCapsuleQR.render($('syncQr'), url, {moduleSize: 6});
      renderState(config, 'Scan the QR on the other device. Pairing expires in 5 minutes.');
    } catch (error) {
      console.error(error);
      renderState(await get(CONFIG_ID), error.message || 'Could not create pairing.', true);
    }
  }

  function updateCountdown() {
    const node = $('syncPairExpires');
    const expiresAt = Number(node?.dataset.expiresAt || 0);
    if (!node || !expiresAt) return;
    const remaining = Math.max(0, expiresAt - Date.now());
    if (!remaining) {
      node.textContent = 'Expired — generate a new pairing.';
      return;
    }
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    node.textContent = `Expires in ${minutes}:${String(seconds).padStart(2, '0')}`;
    setTimeout(updateCountdown, 1000);
  }

  async function claimFromHash() {
    const match = location.hash.match(/^#tw=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{32})$/);
    if (!match) return false;
    const [, watchlistId, pairId, secret] = match;
    try {
      renderState(null, 'Connecting this device…');
      const claimed = await api(`/v1/watchlist-pairings/${watchlistId}/${pairId}`, {authorization: `Pair ${secret}`});
      const secretBytes = unb64url(secret);
      const token = decoder.decode(await unwrapFromPairing(claimed.wrappedToken, claimed.tokenWrapIv, secretBytes));
      const contentKey = await unwrapFromPairing(claimed.wrappedKey, claimed.keyWrapIv, secretBytes);
      if (!/^[A-Za-z0-9_-]{43}$/.test(token) || contentKey.length !== 32) throw new Error('Pairing credentials could not be verified.');
      const remoteTickers = await decryptSyncPayload(claimed.payload, contentKey);
      const local = await localWatchlist();
      if (local.tickers.length && JSON.stringify(local.tickers) !== JSON.stringify(remoteTickers)) {
        if (!confirm(`This device already has ${local.tickers.length} preferred ticker(s). Pairing will replace them with the ${remoteTickers.length} ticker(s) from the connected device. Continue?`)) {
          history.replaceState(null, '', location.pathname + location.search);
          renderState(await get(CONFIG_ID), 'Pairing cancelled.');
          return true;
        }
      }
      const protectedToken = await protectText(token);
      const protectedKey = await protectBytes(contentKey);
      const deviceId = b64url(randomBytes(12));
      const record = await writeLocalWatchlist(remoteTickers, claimed.payload.updatedAt || new Date().toISOString());
      const config = {
        id: CONFIG_ID, watchlistId, deviceId,
        tokenIv: protectedToken.iv, protectedToken: protectedToken.ciphertext,
        keyIv: protectedKey.iv, protectedKey: protectedKey.ciphertext,
        lastRevision: claimed.revision, lastLocalUpdatedAt: record.updatedAt,
        createdAt: new Date().toISOString(), lastSyncAt: new Date().toISOString()
      };
      await put(config);
      history.replaceState(null, '', location.pathname + location.search);
      renderState(config, 'Device connected. Encrypted preferred tickers were applied.');
      setTimeout(() => location.reload(), 600);
      return true;
    } catch (error) {
      console.error(error);
      history.replaceState(null, '', location.pathname + location.search);
      renderState(await get(CONFIG_ID), error.message || 'Could not connect this device.', true);
      return true;
    }
  }

  function showConflict(remoteCount) {
    $('syncConflict').hidden = false;
    $('syncConflictText').textContent = `Both devices changed the watchlist. The other device currently has ${remoteCount} preferred ticker${remoteCount === 1 ? '' : 's'}. Choose which version to keep.`;
    renderState(conflict.config, 'Sync conflict needs your choice.', true);
  }

  async function keepLocal() {
    if (!conflict) return;
    busy = true;
    try {
      await pushLocal(conflict.config, conflict.token, conflict.contentKey, true, conflict.remote.revision);
      conflict = null;
      $('syncConflict').hidden = true;
      renderState(await get(CONFIG_ID), 'This device’s watchlist is now the synced version.');
    } catch (error) {
      renderState(await get(CONFIG_ID), error.message || 'Could not resolve conflict.', true);
    } finally { busy = false; }
  }

  async function useRemote() {
    if (!conflict) return;
    busy = true;
    try {
      $('syncConflict').hidden = true;
      await applyRemote(conflict.config, conflict.remote, conflict.contentKey);
    } catch (error) {
      renderState(await get(CONFIG_ID), error.message || 'Could not apply the other device version.', true);
    } finally { busy = false; }
  }

  async function disconnect() {
    if (!confirm('Stop syncing Ticker Watch on this device? Your local preferred tickers will remain.')) return;
    await remove(CONFIG_ID);
    conflict = null;
    $('syncConflict').hidden = true;
    $('syncPairPanel').hidden = true;
    renderState(null, 'Sync disconnected on this device.');
  }

  function renderState(config, message = '', error = false) {
    if (!$('syncState')) return;
    $('syncState').textContent = config ? 'Encrypted sync on' : 'Local only';
    $('syncState').classList.toggle('connected', Boolean(config));
    $('syncMessage').textContent = message || (config
      ? `Last checked ${config.lastSyncAt ? new Date(config.lastSyncAt).toLocaleTimeString() : 'not yet'}. The relay stores ciphertext only.`
      : 'Enable encrypted sync to keep preferred tickers consistent across trusted devices.');
    $('syncMessage').classList.toggle('error', error);
    $('syncNowButton').disabled = !config;
    $('disconnectSyncButton').hidden = !config;
    $('pairDeviceButton').textContent = config ? 'Pair another device' : 'Enable sync & pair device';
  }

  async function init() {
    if (!crypto?.subtle || !indexedDB) return;
    db = await openDb();
    deviceKey = await ensureDeviceKey();
    await claimFromHash();
    renderState(await get(CONFIG_ID));
    clearInterval(timer);
    timer = setInterval(() => syncNow({silent: true}), SYNC_INTERVAL_MS);
  }

  $('pairDeviceButton')?.addEventListener('click', createPairing);
  $('syncNowButton')?.addEventListener('click', () => syncNow());
  $('disconnectSyncButton')?.addEventListener('click', disconnect);
  $('keepLocalButton')?.addEventListener('click', keepLocal);
  $('useRemoteButton')?.addEventListener('click', useRemote);
  $('copyPairLinkButton')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('syncPairLink').value);
      renderState(await get(CONFIG_ID), 'Pairing link copied.');
    } catch {
      $('syncPairLink').select();
    }
  });

  init().catch((error) => {
    console.error(error);
    renderState(null, 'Could not initialize encrypted device sync.', true);
  });
})();

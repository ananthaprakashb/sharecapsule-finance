(() => {
  'use strict';

  const DB_NAME = 'sharecapsule-private-finance';
  const DB_VERSION = 1;
  const STORE_NAME = 'vaults';
  const VAULT_ID = 'primary';
  const CONFIG_ID = 'sync-config';
  const DEVICE_KEY_ID = 'sync-device-key';
  const PENDING_ID = 'sync-pending';
  const SYNC_ENDPOINT = 'https://sync.finance.sharecapsule.app';
  const SYNC_INTERVAL_MS = 20000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let db;
  let pollTimer = null;
  let pairingTimer = null;
  let activeConflict = null;

  const $ = (id) => document.getElementById(id);

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  function toBase64Url(bytes) {
    let binary = '';
    for (const value of bytes) binary += String.fromCharCode(value);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function fromBase64Url(value) {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function sha256Text(value) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
    return toBase64Url(new Uint8Array(digest));
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

  function dbGet(id) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  function dbPut(record) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function dbDelete(id) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function ensureDeviceKey() {
    const existing = await dbGet(DEVICE_KEY_ID);
    if (existing?.key) return existing.key;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await dbPut({ id: DEVICE_KEY_ID, key, createdAt: new Date().toISOString() });
    return key;
  }

  async function protectToken(token) {
    const key = await ensureDeviceKey();
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(token));
    return { tokenIv: toBase64Url(iv), protectedToken: toBase64Url(new Uint8Array(ciphertext)) };
  }

  async function revealToken(config) {
    const keyRecord = await dbGet(DEVICE_KEY_ID);
    if (!keyRecord?.key) throw new Error('This device lost its sync protection key. Disconnect and pair it again.');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(config.tokenIv) },
      keyRecord.key,
      fromBase64Url(config.protectedToken)
    );
    return decoder.decode(plaintext);
  }

  async function api(path, options = {}) {
    const response = await fetch(`${SYNC_ENDPOINT}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.authorization ? { Authorization: options.authorization } : {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
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

  function isVaultRecord(record) {
    return Boolean(record && record.id === VAULT_ID && record.format === 'sharecapsule-private-finance-v1' && typeof record.ciphertext === 'string' && typeof record.iv === 'string' && typeof record.salt === 'string');
  }

  async function createSyncConfig(vaultRecord) {
    const vaultId = toBase64Url(randomBytes(16));
    const token = toBase64Url(randomBytes(32));
    const deviceId = toBase64Url(randomBytes(12));
    const result = await api(`/v1/vault/${vaultId}`, {
      method: 'PUT',
      authorization: `Bearer ${token}`,
      body: { baseRevision: 0, deviceId, payload: vaultRecord }
    });
    const protectedFields = await protectToken(token);
    const config = {
      id: CONFIG_ID,
      vaultId,
      deviceId,
      ...protectedFields,
      lastRevision: result.revision,
      lastPayloadUpdatedAt: vaultRecord.updatedAt,
      createdAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString()
    };
    await dbPut(config);
    return config;
  }

  async function ensureSyncConfig() {
    const vaultRecord = await dbGet(VAULT_ID);
    if (!isVaultRecord(vaultRecord)) throw new Error('Create or restore a vault before connecting another device.');
    const existing = await dbGet(CONFIG_ID);
    return existing || createSyncConfig(vaultRecord);
  }

  async function wrapTokenForPairing(token, pairSecretBytes) {
    const key = await crypto.subtle.importKey('raw', pairSecretBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(token));
    return { wrappedToken: toBase64Url(new Uint8Array(ciphertext)), wrapIv: toBase64Url(iv) };
  }

  async function unwrapTokenFromPairing(wrappedToken, wrapIv, pairSecretBytes) {
    const key = await crypto.subtle.importKey('raw', pairSecretBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(wrapIv) }, key, fromBase64Url(wrappedToken));
    return decoder.decode(plaintext);
  }

  async function createPairing() {
    setDeviceStatus('Preparing a one-time pairing QR…');
    const config = await ensureSyncConfig();
    const token = await revealToken(config);
    const vaultRecord = await dbGet(VAULT_ID);
    await pushLocalIfNeeded(config, token, vaultRecord, true);

    const pairId = toBase64Url(randomBytes(8));
    const pairSecretBytes = randomBytes(24);
    const pairSecret = toBase64Url(pairSecretBytes);
    const secretHash = await sha256Text(pairSecret);
    const wrapped = await wrapTokenForPairing(token, pairSecretBytes);

    const pairing = await api(`/v1/vault/${config.vaultId}/pairings`, {
      method: 'POST',
      authorization: `Bearer ${token}`,
      body: { pairId, secretHash, ...wrapped }
    });

    const pairingUrl = `${location.origin}/#p=${config.vaultId}.${pairId}.${pairSecret}`;
    if (new TextEncoder().encode(pairingUrl).length > window.ShareCapsuleQR.maxBytes) throw new Error('Pairing URL exceeds QR capacity.');
    window.ShareCapsuleQR.render($('pairQrCanvas'), pairingUrl, { moduleSize: 7 });
    $('pairQrPanel').hidden = false;
    $('pairingFallback').value = pairingUrl;
    $('pairQrExpires').dataset.expiresAt = String(pairing.expiresAt);
    updatePairCountdown();
    clearInterval(pairingTimer);
    pairingTimer = setInterval(updatePairCountdown, 1000);
    setDeviceStatus('Scan the QR with the other device’s Camera app.');
  }

  function updatePairCountdown() {
    const node = $('pairQrExpires');
    const expiresAt = Number(node?.dataset.expiresAt || 0);
    const remaining = Math.max(0, expiresAt - Date.now());
    if (!node) return;
    if (remaining <= 0) {
      node.textContent = 'Expired — generate a new QR.';
      clearInterval(pairingTimer);
      return;
    }
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    node.textContent = `Expires in ${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  async function claimPairingFromHash() {
    const match = location.hash.match(/^#p=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{32})$/);
    if (!match) return false;
    const [, vaultId, pairId, pairSecret] = match;
    showPairingOverlay('Connecting this device…', 'Fetching the encrypted vault. No financial data is readable by the sync relay.');

    try {
      const existingVault = await dbGet(VAULT_ID);
      if (existingVault && !confirm('This browser already has a local finance vault. Pairing will replace that local encrypted vault. Continue?')) {
        clearPairHash();
        hidePairingOverlay();
        return true;
      }

      const claimed = await api(`/v1/pairings/${vaultId}/${pairId}`, { authorization: `Pair ${pairSecret}` });
      if (!isVaultRecord(claimed.payload)) throw new Error('The pairing did not contain a valid encrypted finance vault.');

      const syncToken = await unwrapTokenFromPairing(claimed.wrappedToken, claimed.wrapIv, fromBase64Url(pairSecret));
      if (!/^[A-Za-z0-9_-]{43}$/.test(syncToken)) throw new Error('The pairing token could not be verified.');

      const deviceId = toBase64Url(randomBytes(12));
      const protectedFields = await protectToken(syncToken);
      await dbPut(claimed.payload);
      await dbPut({
        id: CONFIG_ID,
        vaultId,
        deviceId,
        ...protectedFields,
        lastRevision: claimed.revision,
        lastPayloadUpdatedAt: claimed.payload.updatedAt,
        createdAt: new Date().toISOString(),
        lastSyncAt: new Date().toISOString()
      });

      clearPairHash();
      showPairingOverlay('Device connected', 'The encrypted vault is now on this device. Unlock it with the same vault passphrase used on your first device.');
      const button = document.createElement('button');
      button.className = 'primary-button';
      button.textContent = 'Continue to vault';
      button.addEventListener('click', () => location.reload());
      $('pairingOverlayActions').replaceChildren(button);
      return true;
    } catch (error) {
      console.error(error);
      showPairingOverlay('Could not connect device', error.message || 'The pairing may have expired or already been used.');
      const button = document.createElement('button');
      button.className = 'secondary-button';
      button.textContent = 'Close';
      button.addEventListener('click', () => { clearPairHash(); hidePairingOverlay(); });
      $('pairingOverlayActions').replaceChildren(button);
      return true;
    }
  }

  function clearPairHash() {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }

  async function pullRemote(config, token) {
    return api(`/v1/vault/${config.vaultId}`, { authorization: `Bearer ${token}` });
  }

  async function pushLocalIfNeeded(config, token, vaultRecord, force = false) {
    const result = await api(`/v1/vault/${config.vaultId}`, {
      method: 'PUT',
      authorization: `Bearer ${token}`,
      body: { baseRevision: config.lastRevision || 0, deviceId: config.deviceId, payload: vaultRecord, force }
    });
    config.lastRevision = result.revision;
    config.lastPayloadUpdatedAt = vaultRecord.updatedAt;
    config.lastSyncAt = new Date().toISOString();
    await dbPut(config);
    return result;
  }

  async function syncNow({ silent = false } = {}) {
    const config = await dbGet(CONFIG_ID);
    if (!config || activeConflict || await dbGet(PENDING_ID)) return;
    const vaultRecord = await dbGet(VAULT_ID);
    if (!isVaultRecord(vaultRecord)) return;
    const token = await revealToken(config);
    if (!silent) setDeviceStatus('Checking encrypted sync…');

    try {
      const remote = await pullRemote(config, token);
      const localChanged = vaultRecord.updatedAt !== config.lastPayloadUpdatedAt;
      const remoteChanged = remote.revision > (config.lastRevision || 0);

      if (localChanged && remoteChanged) {
        activeConflict = { config, token, local: vaultRecord, remote };
        showConflict();
        setDeviceStatus('Sync paused: both devices changed the vault.');
        return;
      }

      if (remoteChanged) {
        if (!isVaultRecord(remote.payload)) throw new Error('Sync relay returned an invalid encrypted vault.');
        await dbPut({ id: PENDING_ID, remote, localUpdatedAt: vaultRecord.updatedAt });
        config.lastRevision = remote.revision;
        config.lastSyncAt = new Date().toISOString();
        await dbPut(config);
        showIncomingNotice();
        setDeviceStatus('Encrypted changes received from another device.');
        renderDeviceState();
        return;
      }

      if (localChanged) {
        await pushLocalIfNeeded(config, token, vaultRecord, false);
        setDeviceStatus('Encrypted changes synced.');
        renderDeviceState();
        return;
      }

      config.lastSyncAt = new Date().toISOString();
      await dbPut(config);
      if (!silent) setDeviceStatus('Everything is encrypted and up to date.');
      renderDeviceState();
    } catch (error) {
      if (error.status === 409 && error.body) {
        activeConflict = { config, token, local: vaultRecord, remote: error.body };
        showConflict();
        setDeviceStatus('Sync conflict needs your choice.');
        return;
      }
      console.error(error);
      if (!silent) setDeviceStatus(`Sync unavailable: ${error.message}`);
      renderDeviceState(error.message);
    }
  }

  function showIncomingNotice() {
    if ($('syncIncomingNotice')) $('syncIncomingNotice').hidden = false;
  }

  async function resolveConflict(useLocal) {
    if (!activeConflict) return;
    const conflict = activeConflict;
    if (useLocal) {
      await pushLocalIfNeeded(conflict.config, conflict.token, conflict.local, true);
      setDeviceStatus('This device’s encrypted vault was kept and synced.');
    } else {
      if (!isVaultRecord(conflict.remote.payload)) throw new Error('Remote vault is invalid.');
      await dbPut({ id: PENDING_ID, remote: conflict.remote, localUpdatedAt: conflict.local.updatedAt });
      conflict.config.lastRevision = conflict.remote.revision;
      conflict.config.lastSyncAt = new Date().toISOString();
      await dbPut(conflict.config);
      setDeviceStatus('Other device’s encrypted vault is ready to apply.');
      showIncomingNotice();
    }
    activeConflict = null;
    $('syncConflict').hidden = true;
    renderDeviceState();
  }

  async function applyIncomingChanges() {
    const pending = await dbGet(PENDING_ID);
    const config = await dbGet(CONFIG_ID);
    if (!pending?.remote || !config) return;
    if (!isVaultRecord(pending.remote.payload)) throw new Error('Pending encrypted vault is invalid.');
    const current = await dbGet(VAULT_ID);
    if (current?.updatedAt !== pending.localUpdatedAt) {
      const token = await revealToken(config);
      activeConflict = { config, token, local: current, remote: pending.remote };
      await dbDelete(PENDING_ID);
      showConflict();
      setDeviceStatus('Both devices changed the vault. Choose which version to keep.');
      return;
    }
    await dbPut(pending.remote.payload);
    config.lastRevision = pending.remote.revision;
    config.lastPayloadUpdatedAt = pending.remote.payload.updatedAt;
    config.lastSyncAt = new Date().toISOString();
    await dbPut(config);
    await dbDelete(PENDING_ID);
    location.reload();
  }

  async function disconnectThisDevice() {
    if (!confirm('Disconnect this device from encrypted sync? The local encrypted vault will remain on this device.')) return;
    await dbDelete(CONFIG_ID);
    await dbDelete(DEVICE_KEY_ID);
    await dbDelete(PENDING_ID);
    clearInterval(pollTimer);
    updatePrivacyPill(false);
    renderDeviceState();
  }

  async function disableSyncEverywhere() {
    const config = await dbGet(CONFIG_ID);
    if (!config) return;
    if (!confirm('Disable encrypted sync for every paired device? Existing local vaults remain on each device, but they will stop synchronizing.')) return;
    const token = await revealToken(config);
    await api(`/v1/vault/${config.vaultId}`, { method: 'DELETE', authorization: `Bearer ${token}` });
    await dbDelete(CONFIG_ID);
    await dbDelete(DEVICE_KEY_ID);
    await dbDelete(PENDING_ID);
    clearInterval(pollTimer);
    updatePrivacyPill(false);
    renderDeviceState();
    setDeviceStatus('Encrypted sync disabled everywhere.');
  }

  function updatePrivacyPill(syncEnabled) {
    const pill = document.querySelector('.privacy-pill');
    if (!pill) return;
    pill.innerHTML = `<span class="status-dot"></span>${syncEnabled ? 'Encrypted sync' : 'Local-only'}`;
  }

  function setDeviceStatus(message) {
    const node = $('deviceSyncStatus');
    if (node) node.textContent = message;
  }

  async function renderDeviceState(error = '') {
    const config = await dbGet(CONFIG_ID);
    const enabled = Boolean(config);
    updatePrivacyPill(enabled);
    const mode = $('syncModeValue');
    if (!mode) return;
    $('syncModeValue').textContent = enabled ? 'End-to-end encrypted device sync' : 'This device only';
    $('syncDeviceValue').textContent = enabled ? `Device ${String(config.deviceId).slice(-6).toUpperCase()}` : 'Not paired';
    $('syncLastValue').textContent = enabled && config.lastSyncAt ? new Date(config.lastSyncAt).toLocaleString() : '—';
    $('syncNowButton').hidden = !enabled;
    $('disconnectDeviceButton').hidden = !enabled;
    $('disableSyncButton').hidden = !enabled;
    $('addDeviceButton').textContent = enabled ? 'Add another device' : 'Enable sync & add device';
    const pending = await dbGet(PENDING_ID);
    if (pending) showIncomingNotice();
    if (error) setDeviceStatus(`Sync unavailable: ${error}`);
    else if (!enabled) setDeviceStatus('Financial data is stored only on this device.');
  }

  function injectUi() {
    if ($('devicesNavTab')) return;
    const nav = document.querySelector('.section-nav');
    const privacyTab = nav?.querySelector('[data-view="privacy"]');
    if (nav) {
      const button = document.createElement('button');
      button.className = 'nav-tab';
      button.dataset.view = 'devices';
      button.id = 'devicesNavTab';
      button.type = 'button';
      button.textContent = 'Devices';
      nav.insertBefore(button, privacyTab || null);
      button.addEventListener('click', activateDevicesView);
    }

    const shell = document.querySelector('#app > .shell');
    if (!shell) return;
    const section = document.createElement('section');
    section.className = 'view';
    section.dataset.viewPanel = 'devices';
    section.innerHTML = `
      <div class="section-title"><div><p class="eyebrow">Trusted devices</p><h2>Encrypted device sync</h2><p class="muted">Pair a phone or another computer by scanning a one-time QR. The relay stores encrypted vault ciphertext only; the vault passphrase is never sent.</p></div></div>
      <div id="syncIncomingNotice" class="sync-alert" hidden><strong>Encrypted changes arrived from another device.</strong><span>Apply them by reloading the encrypted vault. If this device changed too, you will be asked which version to keep.</span><div class="sync-actions"><button class="primary-button" id="applyIncomingButton" type="button">Apply & reload vault</button></div></div>
      <div id="syncConflict" class="sync-alert sync-conflict" hidden><strong>Both devices changed the vault.</strong><span>Choose which encrypted vault should become the current version.</span><div class="sync-actions"><button class="primary-button" id="keepLocalButton" type="button">Keep this device</button><button class="secondary-button" id="keepRemoteButton" type="button">Use other device</button></div></div>
      <div class="privacy-grid sync-summary">
        <article class="panel"><h3>Sync mode</h3><p id="syncModeValue" class="sync-value">This device only</p></article>
        <article class="panel"><h3>This device</h3><p id="syncDeviceValue" class="sync-value">Not paired</p></article>
        <article class="panel"><h3>Last sync</h3><p id="syncLastValue" class="sync-value">—</p></article>
        <article class="panel"><h3>Relay visibility</h3><p class="sync-value">Encrypted ciphertext only</p></article>
      </div>
      <div class="two-column form-layout">
        <article class="panel">
          <h3>Connect another device</h3>
          <p class="muted">Generate the QR on your laptop, then scan it with the normal Camera app on your phone. The QR is single-use and expires after five minutes.</p>
          <div class="sync-actions"><button class="primary-button" id="addDeviceButton" type="button">Enable sync & add device</button><button class="secondary-button" id="syncNowButton" type="button" hidden>Sync now</button></div>
          <p id="deviceSyncStatus" class="sync-status">Financial data is stored only on this device.</p>
          <div id="pairQrPanel" class="pair-panel" hidden>
            <div class="pair-qr-wrap"><canvas id="pairQrCanvas" aria-label="One-time device pairing QR code"></canvas></div>
            <strong>Scan with the other device</strong>
            <p class="muted">The QR contains a short-lived authorization capability, not your passphrase or financial data. Keep it private while it is active.</p>
            <p id="pairQrExpires" class="pair-expiry"></p>
            <details><summary>Can't scan?</summary><label class="field"><span>Pairing link</span><input id="pairingFallback" readonly></label><button class="secondary-button" id="copyPairingButton" type="button">Copy pairing link</button></details>
          </div>
        </article>
        <article class="panel danger-zone">
          <h3>Sync controls</h3>
          <p class="muted">Disconnect only this browser, or disable the encrypted relay for every paired device. Local encrypted vaults are not erased.</p>
          <div class="sync-actions vertical"><button class="secondary-button" id="disconnectDeviceButton" type="button" hidden>Disconnect this device</button><button class="danger-button" id="disableSyncButton" type="button" hidden>Disable sync everywhere</button></div>
        </article>
      </div>`;
    const privacyPanel = shell.querySelector('[data-view-panel="privacy"]');
    shell.insertBefore(section, privacyPanel || null);

    const style = document.createElement('style');
    style.textContent = `.sync-summary{margin-bottom:12px}.sync-value{font-size:14px!important;color:var(--ink)!important;font-weight:850;margin-bottom:0}.sync-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:14px}.sync-actions.vertical{flex-direction:column;align-items:flex-start}.sync-status{color:var(--muted);font-size:12px;line-height:1.5;margin:14px 0 0}.pair-panel{margin-top:18px;padding:18px;border:1px solid var(--line);border-radius:18px;background:rgba(255,255,255,.025)}.pair-qr-wrap{background:#fff;border-radius:18px;padding:10px;width:max-content;max-width:100%;overflow:auto;margin-bottom:12px}.pair-qr-wrap canvas{display:block;max-width:min(100%,315px);height:auto!important}.pair-expiry{font-size:12px;font-weight:900;color:var(--accent)}.sync-alert{margin:0 0 12px;padding:14px 16px;border:1px solid rgba(99,230,190,.2);background:rgba(99,230,190,.07);border-radius:16px;display:grid;gap:5px}.sync-alert strong{font-size:13px}.sync-alert span{font-size:12px;color:var(--muted)}.sync-conflict{border-color:rgba(255,212,59,.22);background:rgba(255,212,59,.07)}.pair-overlay{position:fixed;inset:0;z-index:100;background:rgba(3,9,17,.86);backdrop-filter:blur(16px);display:grid;place-items:center;padding:18px}.pair-overlay[hidden]{display:none}.pair-overlay-card{width:min(100%,480px);background:var(--panel);border:1px solid var(--line);border-radius:24px;padding:24px;box-shadow:var(--shadow)}.pair-overlay-card h2{margin:4px 0 8px;font-size:28px;letter-spacing:-.04em}.pair-overlay-card p{color:var(--muted);line-height:1.55}.pair-overlay-actions{margin-top:18px;display:flex;gap:9px;flex-wrap:wrap}`;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'pairingOverlay';
    overlay.className = 'pair-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `<div class="pair-overlay-card"><p class="eyebrow">Trusted device pairing</p><h2 id="pairingOverlayTitle">Connecting…</h2><p id="pairingOverlayMessage"></p><div id="pairingOverlayActions" class="pair-overlay-actions"></div></div>`;
    document.body.appendChild(overlay);

    $('addDeviceButton').addEventListener('click', () => createPairing().catch((error) => { console.error(error); setDeviceStatus(`Could not create pairing: ${error.message}`); }));
    $('syncNowButton').addEventListener('click', () => syncNow().catch((error) => setDeviceStatus(error.message)));
    $('disconnectDeviceButton').addEventListener('click', () => disconnectThisDevice().catch((error) => setDeviceStatus(error.message)));
    $('disableSyncButton').addEventListener('click', () => disableSyncEverywhere().catch((error) => setDeviceStatus(error.message)));
    $('keepLocalButton').addEventListener('click', () => resolveConflict(true).catch((error) => setDeviceStatus(error.message)));
    $('keepRemoteButton').addEventListener('click', () => resolveConflict(false).catch((error) => setDeviceStatus(error.message)));
    $('applyIncomingButton').addEventListener('click', () => applyIncomingChanges().catch((error) => setDeviceStatus(error.message)));
    $('copyPairingButton').addEventListener('click', async () => {
      await navigator.clipboard.writeText($('pairingFallback').value);
      $('copyPairingButton').textContent = 'Copied';
      setTimeout(() => { $('copyPairingButton').textContent = 'Copy pairing link'; }, 1400);
    });
  }

  function activateDevicesView() {
    document.querySelectorAll('.nav-tab').forEach((node) => node.classList.toggle('active', node.dataset.view === 'devices'));
    document.querySelectorAll('[data-view-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.viewPanel === 'devices'));
    renderDeviceState();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showPairingOverlay(title, message) {
    const overlay = $('pairingOverlay');
    if (!overlay) return;
    $('pairingOverlayTitle').textContent = title;
    $('pairingOverlayMessage').textContent = message;
    $('pairingOverlayActions').replaceChildren();
    overlay.hidden = false;
  }

  function hidePairingOverlay() {
    if ($('pairingOverlay')) $('pairingOverlay').hidden = true;
  }

  function showConflict() {
    if ($('syncConflict')) $('syncConflict').hidden = false;
  }

  async function startPolling() {
    clearInterval(pollTimer);
    const config = await dbGet(CONFIG_ID);
    if (!config) return;
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') syncNow({ silent: true }).catch(() => {});
    }, SYNC_INTERVAL_MS);
  }

  async function init() {
    if (!window.crypto?.subtle || !window.indexedDB || !window.ShareCapsuleQR) return;
    injectUi();
    db = await openDb();
    await claimPairingFromHash();
    await renderDeviceState();
    await startPolling();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncNow({ silent: true }).catch(() => {});
    });
    window.addEventListener('online', () => syncNow({ silent: true }).catch(() => {}));
  }

  init().catch((error) => {
    console.error(error);
    setDeviceStatus(`Device sync could not start: ${error.message}`);
  });
})();

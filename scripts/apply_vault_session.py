#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def replace(path, old, new, count=1):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    actual = text.count(old)
    if actual < count:
        raise SystemExit(f'{path}: expected at least {count} occurrences, found {actual}: {old[:80]!r}')
    text = text.replace(old, new, count)
    p.write_text(text, encoding='utf-8')

# app.js: expose secure session helper and derive temporary raw key material only long enough to wrap it.
replace('app.js',
"  const $ = (id) => document.getElementById(id);\n  const qsa = (selector) => [...document.querySelectorAll(selector)];",
"  const $ = (id) => document.getElementById(id);\n  const qsa = (selector) => [...document.querySelectorAll(selector)];\n  const vaultSession = () => window.ShareCapsuleVaultSession || null;")

replace('app.js',
"  async function deriveKey(passphrase, salt, iterations = KDF_ITERATIONS) {\n    const baseKey = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);\n    return crypto.subtle.deriveKey(\n      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },\n      baseKey,\n      { name: 'AES-GCM', length: 256 },\n      false,\n      ['encrypt', 'decrypt']\n    );\n  }",
"  async function deriveKeyMaterial(passphrase, salt, iterations = KDF_ITERATIONS) {\n    const baseKey = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']);\n    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, baseKey, 256);\n    const rawKey = new Uint8Array(bits);\n    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);\n    return { key, rawKey };\n  }\n\n  async function deriveKey(passphrase, salt, iterations = KDF_ITERATIONS) {\n    const material = await deriveKeyMaterial(passphrase, salt, iterations);\n    material.rawKey.fill(0);\n    return material.key;\n  }")

replace('app.js',
"  async function decryptRecord(record, passphrase) {\n    const salt = base64ToBytes(record.salt);\n    const iterations = Number(record.kdf?.iterations || KDF_ITERATIONS);\n    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 5000000) throw new Error('Unsupported vault parameters');\n    const key = await deriveKey(passphrase, salt, iterations);\n    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(record.iv) }, key, base64ToBytes(record.ciphertext));\n    const parsed = JSON.parse(decoder.decode(plaintext));\n    return { key, state: normalizeState(parsed), salt };\n  }",
"  async function decryptRecord(record, passphrase) {\n    const salt = base64ToBytes(record.salt);\n    const iterations = Number(record.kdf?.iterations || KDF_ITERATIONS);\n    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 5000000) throw new Error('Unsupported vault parameters');\n    const material = await deriveKeyMaterial(passphrase, salt, iterations);\n    try {\n      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(record.iv) }, material.key, base64ToBytes(record.ciphertext));\n      const parsed = JSON.parse(decoder.decode(plaintext));\n      return { key: material.key, rawKey: material.rawKey, state: normalizeState(parsed), salt };\n    } catch (error) {\n      material.rawKey.fill(0);\n      throw error;\n    }\n  }")

replace('app.js',
"  function showApp() {\n    $('vaultGate').hidden = true;\n    $('app').hidden = false;\n    $('lockButton').hidden = false;\n    $('transactionDate').value = nowIsoDate();\n    resetAutoLock();\n    renderAll();\n  }",
"  function showApp() {\n    $('vaultGate').hidden = true;\n    $('app').hidden = false;\n    $('lockButton').hidden = false;\n    $('transactionDate').value = nowIsoDate();\n    vaultSession()?.touch();\n    resetAutoLock();\n    renderAll();\n  }")

replace('app.js',
"  function lockVault() {\n    clearTimeout(saveTimer);\n    saveTimer = null;\n    clearTimeout(lockTimer);\n    currentKey = null;\n    state = null;\n    dirty = false;\n    showGate(true);\n  }",
"  function lockVault() {\n    clearTimeout(saveTimer);\n    saveTimer = null;\n    clearTimeout(lockTimer);\n    currentKey = null;\n    state = null;\n    dirty = false;\n    vaultSession()?.clear();\n    showGate(true);\n  }")

replace('app.js',
"  function resetAutoLock() {\n    if (!currentKey) return;\n    clearTimeout(lockTimer);\n    lockTimer = setTimeout(lockVault, AUTO_LOCK_MS);\n  }",
"  function resetAutoLock() {\n    if (!currentKey) return;\n    vaultSession()?.touch();\n    clearTimeout(lockTimer);\n    lockTimer = setTimeout(lockVault, AUTO_LOCK_MS);\n  }")

replace('app.js',
"        const salt = crypto.getRandomValues(new Uint8Array(16));\n        currentKey = await deriveKey(passphrase, salt);\n        state = defaultState();\n        vaultRecord = await encryptState(state, currentKey, salt);\n        await dbPut(vaultRecord);\n        dirty = false;\n        showApp();",
"        const salt = crypto.getRandomValues(new Uint8Array(16));\n        const material = await deriveKeyMaterial(passphrase, salt);\n        currentKey = material.key;\n        state = defaultState();\n        vaultRecord = await encryptState(state, currentKey, salt);\n        await dbPut(vaultRecord);\n        dirty = false;\n        try { await vaultSession()?.start(material.rawKey); } catch (sessionError) { console.warn('Vault session resume unavailable', sessionError); } finally { material.rawKey.fill(0); }\n        showApp();")

replace('app.js',
"        const result = await decryptRecord(vaultRecord, $('unlockPassphrase').value);\n        currentKey = result.key;\n        state = result.state;\n        dirty = false;\n        showApp();",
"        const result = await decryptRecord(vaultRecord, $('unlockPassphrase').value);\n        currentKey = result.key;\n        state = result.state;\n        dirty = false;\n        try { await vaultSession()?.start(result.rawKey); } catch (sessionError) { console.warn('Vault session resume unavailable', sessionError); } finally { result.rawKey.fill(0); }\n        showApp();")

replace('app.js',
"      vaultRecord = null; currentKey = null; state = null; dirty = false;\n      clearTimeout(lockTimer); clearTimeout(saveTimer); saveTimer = null;\n      showGate(false);",
"      vaultRecord = null; currentKey = null; state = null; dirty = false;\n      vaultSession()?.clear();\n      clearTimeout(lockTimer); clearTimeout(saveTimer); saveTimer = null;\n      showGate(false);")

replace('app.js',
"      db = await openDb();\n      vaultRecord = await dbGet(VAULT_ID);\n      bindForms(); bindButtons(); bindAutoLock();\n      showGate(Boolean(vaultRecord));",
"      db = await openDb();\n      vaultRecord = await dbGet(VAULT_ID);\n      bindForms(); bindButtons(); bindAutoLock();\n      if (vaultRecord && vaultSession()?.isActive()) {\n        try {\n          currentKey = await vaultSession().restoreKey();\n          if (currentKey) {\n            state = await decryptRecordWithCurrentKey(vaultRecord);\n            dirty = false;\n            showApp();\n            return;\n          }\n        } catch (sessionError) {\n          console.warn('Could not resume vault session', sessionError);\n          currentKey = null;\n          state = null;\n          vaultSession()?.clear();\n        }\n      }\n      showGate(Boolean(vaultRecord));")

# index.html: load session helper first and explain the active-tab behavior.
replace('index.html',
"<article class=\"panel\"><h3>Automatic lock</h3><p>The decrypted vault is kept only in page memory and automatically locks after inactivity. You can lock it immediately from the header.</p></article>",
"<article class=\"panel\"><h3>Automatic lock</h3><p>The decrypted working copy stays in page memory. To let the same browser tab move between ShareCapsule pages without asking for the passphrase again, the 256-bit vault key is wrapped locally with a non-extractable device key and kept only in session storage. The session expires after inactivity or when you press Lock vault; the passphrase itself is never stored.</p></article>")
replace('index.html',
"  <script src=\"./app.js?v=20260814-0930\" defer></script>",
"  <script src=\"./vault-session.js?v=20260815-1\" defer></script>\n  <script src=\"./app.js?v=20260815-1\" defer></script>")

# health/index.html: active vault session hides the repeated passphrase field.
replace('health/index.html', '<label class="field">\n              <span>Vault passphrase</span>', '<label class="field" id="vaultPassphraseField">\n              <span>Vault passphrase</span>')
replace('health/index.html', '<small>Used only in browser memory to decrypt the local vault.</small>', '<small>Needed only when this tab does not already have an active vault session.</small>')
replace('health/index.html',
"          <div class=\"setup-note\">The comparison profile is session-only in this version. ShareCapsule does not persist your state, household income, household size, or passphrase from this page.</div>",
"          <div class=\"setup-note\" id=\"healthSessionNote\">The comparison profile is session-only in this version. ShareCapsule does not persist your state, household income, household size, or passphrase from this page.</div>")
replace('health/index.html',
"  <script src=\"./health.js?v=20260815-3\" defer></script>",
"  <script src=\"../vault-session.js?v=20260815-1\" defer></script>\n  <script src=\"./health.js?v=20260815-4\" defer></script>")

# health/health.js: use the tab session when available; starting here also establishes the same session.
replace('health/health.js',
"  const $ = (id) => document.getElementById(id);\n  const money = new Intl.NumberFormat",
"  const $ = (id) => document.getElementById(id);\n  const vaultSession = () => window.ShareCapsuleVaultSession || null;\n  const money = new Intl.NumberFormat")

replace('health/health.js',
"  async function decryptVault(record, passphrase) {\n    const iterations = Number(record?.kdf?.iterations || 600000);\n    if (!record || !record.salt || !record.iv || !record.ciphertext || !Number.isInteger(iterations)) throw new Error('The local finance vault is not in a supported format.');\n    const baseKey = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);\n    const cryptoKey = await crypto.subtle.deriveKey(\n      { name:'PBKDF2', salt:fromBase64(record.salt), iterations, hash:'SHA-256' },\n      baseKey,\n      { name:'AES-GCM', length:256 },\n      false,\n      ['decrypt']\n    );\n    const plaintext = await crypto.subtle.decrypt({ name:'AES-GCM', iv:fromBase64(record.iv) }, cryptoKey, fromBase64(record.ciphertext));\n    return JSON.parse(decoder.decode(plaintext));\n  }",
"  async function decryptVaultWithKey(record, cryptoKey) {\n    if (!record || !record.iv || !record.ciphertext) throw new Error('The local finance vault is not in a supported format.');\n    const plaintext = await crypto.subtle.decrypt({ name:'AES-GCM', iv:fromBase64(record.iv) }, cryptoKey, fromBase64(record.ciphertext));\n    return JSON.parse(decoder.decode(plaintext));\n  }\n\n  async function decryptVault(record, passphrase) {\n    const iterations = Number(record?.kdf?.iterations || 600000);\n    if (!record || !record.salt || !record.iv || !record.ciphertext || !Number.isInteger(iterations)) throw new Error('The local finance vault is not in a supported format.');\n    const baseKey = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']);\n    const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', salt:fromBase64(record.salt), iterations, hash:'SHA-256' }, baseKey, 256);\n    const rawKey = new Uint8Array(bits);\n    try {\n      const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name:'AES-GCM' }, false, ['encrypt','decrypt']);\n      const vault = await decryptVaultWithKey(record, cryptoKey);\n      try { await vaultSession()?.start(rawKey); } catch (sessionError) { console.warn('Vault session resume unavailable', sessionError); }\n      return vault;\n    } finally {\n      rawKey.fill(0);\n    }\n  }\n\n  function updateVaultSessionUi() {\n    const active = Boolean(vaultSession()?.isActive());\n    const field = $('vaultPassphraseField');\n    const input = $('vaultPassphrase');\n    if (field) field.hidden = active;\n    if (input) { input.required = !active; if (active) input.value = ''; }\n    const note = $('healthSessionNote');\n    if (note) note.textContent = active\n      ? 'Vault session active in this tab. Financial Health will read the encrypted local vault without asking for the passphrase again. State, income and household size remain session-only.'\n      : 'The comparison profile is session-only in this version. ShareCapsule does not persist your state, household income, household size, or passphrase from this page.';\n  }")

replace('health/health.js',
"      const vault = await decryptVault(record, $('vaultPassphrase').value);\n      renderResults(vault, region, cohort, householdSize);",
"      let vault;\n      if (vaultSession()?.isActive()) {\n        const sessionKey = await vaultSession().restoreKey();\n        if (!sessionKey) throw new Error('Your vault session expired. Enter the vault passphrase to continue.');\n        vault = await decryptVaultWithKey(record, sessionKey);\n      } else {\n        vault = await decryptVault(record, $('vaultPassphrase').value);\n        updateVaultSessionUi();\n      }\n      renderResults(vault, region, cohort, householdSize);")

replace('health/health.js',
"  function init() {\n    $('stateSelect').insertAdjacentHTML('beforeend', STATES.map(([code,name]) => `<option value=\"${code}\">${escapeHtml(name)}</option>`).join(''));\n    $('healthForm').addEventListener('submit', analyze);",
"  function init() {\n    $('stateSelect').insertAdjacentHTML('beforeend', STATES.map(([code,name]) => `<option value=\"${code}\">${escapeHtml(name)}</option>`).join(''));\n    updateVaultSessionUi();\n    window.addEventListener('sharecapsule:vault-session', updateVaultSessionUi);\n    $('healthForm').addEventListener('submit', analyze);")

# Guide focus is script-enabled already; keep active session alive while working through a recommendation.
replace('guide/focus/index.html',
"  <script src=\"./focus.js?v=20260815-1\" defer></script>",
"  <script src=\"../../vault-session.js?v=20260815-1\" defer></script>\n  <script src=\"./focus.js?v=20260815-1\" defer></script>")

# Validation: make the shared session helper a required, syntax-checked asset and enforce no password persistence.
replace('.github/workflows/static-validate.yml',
"          node --check app.js\n          node --check qr.js",
"          node --check vault-session.js\n          node --check app.js\n          node --check qr.js")
replace('scripts/validate_static.py',
'    "PUBLISHING.md",\n    "health/index.html",',
'    "PUBLISHING.md",\n    "vault-session.js",\n    "health/index.html",')

# One-time patch artifacts remove themselves after a successful edit, preventing recursive patch runs.
for relative in ['scripts/apply_vault_session.py', '.github/workflows/apply-vault-session.yml']:
    target = ROOT / relative
    if target.exists():
        target.unlink()

print('Vault navigation session patch applied.')

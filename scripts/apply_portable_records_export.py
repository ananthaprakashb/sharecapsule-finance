#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def replace(path, old, new, count=1):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    actual = text.count(old)
    if actual < count:
        raise SystemExit(f'{path}: expected at least {count} occurrence(s), found {actual}: {old[:120]!r}')
    p.write_text(text.replace(old, new, count), encoding='utf-8')

def append_once(path, marker, block):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    if marker not in text:
        if not text.endswith('\n'):
            text += '\n'
        text += '\n' + block.strip() + '\n'
        p.write_text(text, encoding='utf-8')

replace('app.js',
"  const VAULT_ID = 'primary';\n  const KDF_ITERATIONS = 600000;",
"  const VAULT_ID = 'primary';\n  const MIGRATION_PENDING_ID = 'migration-pending';\n  const PORTABLE_EXPORT_FORMAT = 'sharecapsule-finance-export-v2';\n  const INCOME_DB_NAME = 'sharecapsule-income-projects';\n  const INCOME_DB_VERSION = 1;\n  const INCOME_STORE = 'workspace';\n  const INCOME_STATE_ID = 'state';\n  const INCOME_KEY_ID = 'device-key';\n  const KDF_ITERATIONS = 600000;")

old_block = """  async function importBackup(file) {
    if (!file || file.size > 25 * 1024 * 1024) throw new Error('Backup file is too large');
    const text = await file.text();
    const record = JSON.parse(text);
    if (!validateBackupRecord(record)) throw new Error('This is not a valid ShareCapsule encrypted finance backup');
    record.id = VAULT_ID;
    await dbPut(record);
    vaultRecord = record;
    dirty = false;
    lockVault();
    alert('Encrypted backup restored. Unlock it with the passphrase used when the backup was created.');
  }

  async function exportBackup() {
    if (dirty) await persist();
    const record = await dbGet(VAULT_ID);
    if (!record) return;
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sharecapsule-finance-backup-${nowIsoDate()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
"""

new_block = """  function openIncomeDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(INCOME_DB_NAME, INCOME_DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(INCOME_STORE)) request.result.createObjectStore(INCOME_STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function externalDbGet(database, storeName, id) {
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  function externalDbPut(database, storeName, value) {
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, 'readwrite').objectStore(storeName).put(value);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function loadIncomeLabStateForExport() {
    if (typeof indexedDB.databases === 'function') {
      try {
        const databases = await indexedDB.databases();
        if (!databases.some((item) => item.name === INCOME_DB_NAME)) return null;
      } catch (_) { /* Fall back to opening the known local database. */ }
    }
    const incomeDb = await openIncomeDb();
    try {
      const keyRecord = await externalDbGet(incomeDb, INCOME_STORE, INCOME_KEY_ID);
      const record = await externalDbGet(incomeDb, INCOME_STORE, INCOME_STATE_ID);
      if (!keyRecord?.key || !record?.iv || !record?.ciphertext) return null;
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(record.iv) }, keyRecord.key, base64ToBytes(record.ciphertext));
      const parsed = JSON.parse(decoder.decode(plaintext));
      if (!parsed || !Array.isArray(parsed.projects)) return null;
      return { version: 1, focusProjectId: parsed.focusProjectId || null, projects: parsed.projects.slice(0, 100) };
    } finally {
      incomeDb.close();
    }
  }

  async function encryptPortablePayload(value, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value)));
    return {
      format: 'sharecapsule-income-projects-portable-v1',
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext)
    };
  }

  function validatePortablePayload(payload) {
    if (!payload || payload.format !== 'sharecapsule-income-projects-portable-v1') return false;
    if (typeof payload.iv !== 'string' || typeof payload.ciphertext !== 'string') return false;
    try {
      return base64ToBytes(payload.iv).length === 12 && base64ToBytes(payload.ciphertext).length > 16;
    } catch (_) { return false; }
  }

  async function restoreIncomeLabFromPortable(payload, key) {
    if (!validatePortablePayload(payload)) throw new Error('Income Lab migration payload is invalid');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(payload.iv) }, key, base64ToBytes(payload.ciphertext));
    const parsed = JSON.parse(decoder.decode(plaintext));
    if (!parsed || !Array.isArray(parsed.projects)) throw new Error('Income Lab migration data is invalid');
    const nextState = { version: 1, focusProjectId: parsed.focusProjectId || null, projects: parsed.projects.slice(0, 100) };

    const incomeDb = await openIncomeDb();
    try {
      let keyRecord = await externalDbGet(incomeDb, INCOME_STORE, INCOME_KEY_ID);
      if (!keyRecord?.key) {
        const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        keyRecord = { id: INCOME_KEY_ID, key: deviceKey, createdAt: new Date().toISOString() };
        await externalDbPut(incomeDb, INCOME_STORE, keyRecord);
      }
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyRecord.key, encoder.encode(JSON.stringify(nextState)));
      await externalDbPut(incomeDb, INCOME_STORE, {
        id: INCOME_STATE_ID,
        format: 'sharecapsule-income-projects-v1',
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(ciphertext),
        updatedAt: new Date().toISOString()
      });
    } finally {
      incomeDb.close();
    }
  }

  async function restorePendingMigrationData() {
    const pending = await dbGet(MIGRATION_PENDING_ID);
    if (!pending) return false;
    if (pending.incomeLab) await restoreIncomeLabFromPortable(pending.incomeLab, currentKey);
    await dbDelete(MIGRATION_PENDING_ID);
    return Boolean(pending.incomeLab);
  }

  async function importBackup(file) {
    if (!file || file.size > 25 * 1024 * 1024) throw new Error('Export file is too large');
    const text = await file.text();
    const parsed = JSON.parse(text);
    let record;
    let portable = null;

    if (parsed?.format === PORTABLE_EXPORT_FORMAT) {
      if (parsed.version !== 2 || !validateBackupRecord(parsed.vault)) throw new Error('This ShareCapsule records export is invalid');
      if (parsed.incomeLab && !validatePortablePayload(parsed.incomeLab)) throw new Error('The Income Lab section of this export is invalid');
      portable = parsed;
      record = { ...parsed.vault, id: VAULT_ID };
    } else {
      if (!validateBackupRecord(parsed)) throw new Error('This is not a valid ShareCapsule encrypted finance backup or records export');
      record = { ...parsed, id: VAULT_ID };
    }

    await dbPut(record);
    if (portable?.incomeLab) {
      await dbPut({
        id: MIGRATION_PENDING_ID,
        format: 'sharecapsule-domain-migration-pending-v1',
        incomeLab: portable.incomeLab,
        sourceOrigin: typeof portable.sourceOrigin === 'string' ? portable.sourceOrigin : '',
        importedAt: new Date().toISOString()
      });
    } else {
      await dbDelete(MIGRATION_PENDING_ID);
    }

    vaultRecord = record;
    dirty = false;
    lockVault();
    alert(portable
      ? 'Records imported. Unlock with your existing vault passphrase. Income Lab progress will be restored locally after a successful unlock.'
      : 'Encrypted backup restored. Unlock it with the passphrase used when the backup was created.');
  }

  async function exportBackup() {
    if (!currentKey || !state) throw new Error('Unlock the vault before exporting records');
    if (dirty) await persist();
    const record = await dbGet(VAULT_ID);
    if (!record) throw new Error('No encrypted finance vault was found');

    let incomeLab = null;
    try {
      const incomeState = await loadIncomeLabStateForExport();
      if (incomeState) incomeLab = await encryptPortablePayload(incomeState, currentKey);
    } catch (error) {
      console.error('Could not include Income Lab progress in export', error);
      throw new Error('Could not prepare the complete records export. Income Lab progress could not be read safely.');
    }

    const bundle = {
      format: PORTABLE_EXPORT_FORMAT,
      version: 2,
      exportedAt: new Date().toISOString(),
      sourceOrigin: window.location.origin,
      vault: record,
      incomeLab
    };

    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sharecapsule-finance-records-${nowIsoDate()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaveState(`Portable encrypted export downloaded · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  }
"""
replace('app.js', old_block, new_block)

replace('app.js',
"        try { await vaultSession()?.start(result.rawKey); } catch (sessionError) { console.warn('Vault session resume unavailable', sessionError); } finally { result.rawKey.fill(0); }\n        showApp();",
"        try { await vaultSession()?.start(result.rawKey); } catch (sessionError) { console.warn('Vault session resume unavailable', sessionError); } finally { result.rawKey.fill(0); }\n        let migrationMessage = '';\n        try {\n          if (await restorePendingMigrationData()) migrationMessage = 'Income Lab progress from the imported records file was restored on this domain.';\n        } catch (migrationError) {\n          console.error('Could not restore migrated Income Lab progress', migrationError);\n          migrationMessage = 'Vault unlocked, but Income Lab progress could not be restored. Keep the exported records file and try the import again.';\n        }\n        showApp();\n        if (migrationMessage) setTimeout(() => alert(migrationMessage), 0);")

replace('app.js',
"    $('exportBackupButton').addEventListener('click', exportBackup);",
"    $('exportBackupButton').addEventListener('click', async () => {\n      try { await exportBackup(); } catch (error) { console.error(error); alert(error.message || 'Could not export records.'); }\n    });")

replace('app.js',
"        if (file && confirm('Restore this encrypted backup? It will replace the encrypted vault currently stored in this browser.')) await importBackup(file);",
"        if (file && confirm('Import this ShareCapsule records file? It will replace the encrypted finance vault currently stored in this browser.')) await importBackup(file);")

replace('app.js',
"      await dbDelete(VAULT_ID);\n      vaultRecord = null; currentKey = null; state = null; dirty = false;",
"      await dbDelete(VAULT_ID);\n      await dbDelete(MIGRATION_PENDING_ID);\n      vaultRecord = null; currentKey = null; state = null; dirty = false;")

replace('index.html',
"<button class=\"text-button\" id=\"importBackupAtGate\" type=\"button\">Import an encrypted backup instead</button>",
"<button class=\"text-button\" id=\"importBackupAtGate\" type=\"button\">Import existing ShareCapsule records</button>")
replace('index.html',
"<div class=\"gate-links\"><button class=\"text-button\" id=\"importBackupUnlock\" type=\"button\">Restore encrypted backup</button><button class=\"danger-link\" id=\"resetVaultButton\" type=\"button\">Erase local vault</button></div>",
"<div class=\"gate-links\"><button class=\"text-button\" id=\"importBackupUnlock\" type=\"button\">Import / restore records</button><button class=\"danger-link\" id=\"resetVaultButton\" type=\"button\">Erase local vault</button></div>")
replace('index.html',
"<div class=\"vault-note\"><strong>Important</strong><span>If you lose the passphrase, the encrypted data cannot be recovered. Keep an encrypted backup in a secure location.</span></div>",
"<div class=\"vault-note\"><strong>Important</strong><span>If you lose the passphrase, the encrypted data cannot be recovered. Before moving to another ShareCapsule Finance domain, unlock this vault and use Export all records under Privacy.</span></div>")
replace('index.html',
"<article class=\"panel\"><h3>Encrypted backup</h3><p class=\"muted\">Download the encrypted vault exactly as stored on this device. The same passphrase is required to restore it.</p><button class=\"primary-button\" id=\"exportBackupButton\" type=\"button\">Download encrypted backup</button><button class=\"secondary-button\" id=\"importBackupButton\" type=\"button\">Restore encrypted backup</button></article>",
"<article class=\"panel\"><h3>Export / import records</h3><p class=\"muted\">Before moving to a new ShareCapsule Finance domain, export one portable encrypted records file. It contains the encrypted finance vault and, when present, Income Lab progress. Your vault passphrase is still required on the new domain. Device-sync credentials are intentionally not exported.</p><button class=\"primary-button\" id=\"exportBackupButton\" type=\"button\">Export all records</button><button class=\"secondary-button\" id=\"importBackupButton\" type=\"button\">Import records</button><p class=\"muted\">Keep this file private and do not delete the old-domain data until you have imported and verified the new domain.</p></article>")
replace('index.html',
"  <script src=\"./app.js?v=20260815-1\" defer></script>",
"  <script src=\"./app.js?v=20260815-2\" defer></script>")

append_once('README.md', '## Domain migration export', '''
## Domain migration export

Because IndexedDB is origin-scoped, browser data at `finance.sharecapsule.app` does not automatically appear at a future `finance.sharecapsule.org` origin. The unlocked planner therefore provides **Privacy → Export all records**.

The portable `sharecapsule-finance-export-v2` JSON file contains:

- the existing AES-GCM encrypted finance vault envelope
- Income Project Lab state, when present, re-encrypted under the finance vault key for portability
- non-sensitive export metadata such as format version and source origin

The export intentionally excludes device-sync authorization material and tab-session state. On the destination domain, import the file, unlock with the existing vault passphrase, verify the planner and Income Lab data, and then configure device sync again for the new origin.

Legacy `sharecapsule-private-finance-v1` encrypted backup files remain import-compatible.
''')

append_once('PUBLISHING.md', '### Domain migration (.app → .org)', '''
### Domain migration (.app → .org)

Before changing the production CNAME away from `finance.sharecapsule.app`:

1. Publish and verify **Privacy → Export all records** on the old domain.
2. Export a portable records file from at least one realistic populated vault and keep the original `.app` domain available during validation.
3. Bring up the `.org` domain with the same import-capable frontend before retiring `.app`.
4. On `.org`, choose **Import existing ShareCapsule records**, then unlock with the original vault passphrase.
5. Verify transactions, budgets, assets, debts, goals and Income Lab project history.
6. Reconfigure encrypted device sync for the `.org` origin; sync authorization material is intentionally not migrated in the export.
7. Update the Worker allowed origin/custom domain, CSP, canonical URLs, sitemap and Search Console configuration before making `.org` primary.
8. Keep `.app` available as a migration/redirect surface until users have had a reasonable opportunity to export their browser-local records.
''')

append_once('SECURITY.md', '## Portable domain migration export', '''
## Portable domain migration export

The domain-migration export is designed to move browser-local records between ShareCapsule Finance origins without creating a plaintext export. The finance vault remains in its existing AES-GCM encrypted envelope. Income Project Lab state is decrypted locally with its device-held key only long enough to be re-encrypted under the already-unlocked finance vault key and written into the portable export. The passphrase, finance vault key, Income Lab device key, sync authorization token and vault-session wrapping key are never written into the export file.

On import, the encrypted finance vault is restored first. After the user successfully unlocks it with the original passphrase, the browser decrypts the portable Income Lab payload locally and re-encrypts it under a new destination-origin device key. Device-sync credentials are deliberately excluded and must be re-established on the destination origin.
''')

print('Portable records export patch applied.')

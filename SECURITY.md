# ShareCapsule Finance — security model

ShareCapsule Finance handles financial information as highly sensitive data. The default remains local-first. Multi-device synchronization is optional and is designed so that the sync relay receives only an already-encrypted vault envelope, never the vault passphrase or decrypted financial data.

## Two operating modes

### 1. This device only — default

- No finance sync traffic.
- The encrypted vault stays in IndexedDB on the current device.
- Financial calculations run locally.
- No analytics, advertising, remote fonts, bank SDKs or AI finance-data calls are loaded.

### 2. Encrypted device sync — optional

- The same encrypted vault envelope is copied to a dedicated sync relay.
- The relay cannot decrypt it because it never receives the vault passphrase.
- Devices authenticate to the relay with a random sync capability protected locally on each device.
- A new device is added with a one-time QR pairing capability that expires after five minutes and is consumed when claimed.
- The second device still needs the existing vault passphrase to decrypt the financial vault.

## Local vault encryption

Persistent finance state uses the Web Crypto API:

- Encryption: AES-GCM, 256-bit key.
- Passphrase KDF: PBKDF2-HMAC-SHA-256.
- PBKDF2 work factor: 600,000 iterations.
- Salt: random 128-bit value per vault.
- AES-GCM IV: new random 96-bit value for every save.
- The vault passphrase is never persisted by the application.
- The derived finance `CryptoKey` is non-extractable and exists only in page memory while the vault is unlocked.
- Decrypted finance JSON is kept only in page memory.
- The app locks after inactivity and clears in-memory finance key/state references on lock or unload.
- Encrypted backups contain the encrypted vault envelope, never plaintext financial data.

The vault envelope contains ciphertext plus non-secret KDF/cipher parameters required for decryption: salt, IV, algorithm identifiers, iteration count and format version.

## Device-sync authorization

The synchronization authorization token is separate from the vault passphrase.

- A random 256-bit sync token identifies trusted devices to the relay.
- The relay persists only a SHA-256 hash of that token.
- Each browser stores its copy of the sync token encrypted under a separate non-extractable AES-GCM device key stored through IndexedDB structured cloning.
- The sync token is not capable of decrypting the finance vault. It only authorizes encrypted relay reads/writes.

A stolen sync token can read or replace the encrypted ciphertext and therefore can cause confidentiality metadata exposure or denial/corruption risk, but it still cannot decrypt the finance data without the separate vault passphrase. Protecting the sync token remains important.

## QR pairing design

The QR is generated locally; no third-party QR service is used.

The QR URL fragment contains only:

- an opaque random vault identifier
- a one-time pairing identifier
- a random one-time pairing secret

It does **not** contain:

- the vault passphrase
- transactions
- balances
- debt information
- budgets/goals
- bank credentials
- card/account numbers

The one-time pairing secret is used locally to unwrap the persistent sync authorization token. The relay stores a hash of the pairing secret, the wrapped token, and an expiration timestamp. Claiming the pairing atomically deletes the pairing record.

Because the pairing capability grants access to the encrypted sync channel, users should keep an active QR private even though it cannot decrypt the vault by itself.

## Sync relay storage

The D1 sync database stores only:

- opaque vault ID
- hash of the sync authorization token
- AES-GCM encrypted vault envelope/ciphertext
- revision number
- opaque device ID associated with the latest write
- timestamps
- short-lived pairing records

The relay does not store the vault passphrase or decrypted finance JSON.

## Conflict protection

Every device tracks the last relay revision it has observed. A normal write includes that base revision.

If another device has already changed the vault, the relay returns a conflict instead of silently overwriting a newer revision. The client asks the user whether to keep this device's encrypted version or the other device's encrypted version.

Incoming remote ciphertext is staged separately before replacing the local primary vault, preventing the currently unlocked in-memory planner from silently overwriting a just-downloaded remote version during the apply/reload step.

## Content Security Policy

The application permits outbound connections only to the dedicated sync relay:

```text
connect-src 'self' https://sync.finance.sharecapsule.app
```

The application still loads scripts/styles from itself only and contains no analytics, ads or remote finance SDKs.

Recommended production response headers:

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://sync.finance.sharecapsule.app; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()
Cache-Control: no-store
```

The QR flow deliberately uses the phone's normal Camera application, so the finance web application itself does not require camera permission.

`style-src 'unsafe-inline'` is currently required because the planner sets local progress widths and the sync UI injects presentation styles. It does not permit scripts.

## Data the application must never request

Do not add UI that asks users for:

- online banking username/password
- one-time passcodes or MFA recovery codes
- debit/credit card numbers
- full bank account/routing numbers
- Social Security numbers or tax IDs
- brokerage or crypto private keys / seed phrases

Display names such as `Checking`, `401(k)` or `Mortgage` and user-entered balances are sufficient for this planner.

## Threat model

This architecture is designed to reduce risk from:

- accidental plaintext server-side collection
- a sync-database compromise exposing readable financial records
- third-party analytics/advertising exfiltration
- passive network inspection of plaintext financial values
- casual access to browser storage without the vault passphrase
- silent last-writer-wins corruption when two devices edit concurrently
- reuse of a QR pairing record after it has been claimed

It cannot guarantee confidentiality on a compromised endpoint. Malware, a malicious browser extension with page access, a compromised browser, screen capture, keylogging or hostile software with sufficient device privileges can expose data while the vault is unlocked.

A compromised sync authorization token can also access/replace encrypted ciphertext even though it cannot decrypt it. Future work should add per-device asymmetric credentials and individual device revocation rather than one shared vault sync capability.

## Security review before production sync

Before enabling real-user multi-device sync:

1. Deploy the relay only at `https://sync.finance.sharecapsule.app`.
2. Apply the D1 schema and verify no plaintext finance fields exist server-side.
3. Add Cloudflare rate limiting and abuse controls.
4. Ensure logs never record Authorization headers, QR fragments, request bodies or encrypted payloads unnecessarily.
5. Test pairing expiration, one-time consumption and replay attempts.
6. Test malformed vault/pairing payloads and size limits.
7. Test wrong sync tokens and wrong vault passphrases.
8. Test concurrent edits and conflict resolution.
9. Test network loss during upload/download.
10. Confirm browser IndexedDB contains ciphertext for finance state and locally protected sync authorization material.
11. Verify the Network panel never sends decrypted financial JSON.
12. Obtain an independent security review before promoting sync for real financial use.

## Reference guidance used for the design

The finance vault uses browser cryptography primitives from the Web Cryptography API, with AES-GCM authenticated encryption and PBKDF2-HMAC-SHA-256 for passphrase derivation. The client intentionally does not persist plaintext finance state in LocalStorage, SessionStorage or IndexedDB.

# Private Finance Planner — security model

This feature handles financial information as highly sensitive data. The default architecture is deliberately local-first and does not require a ShareCapsule account, financial institution login, bank-aggregation provider, analytics provider, or server-side financial database.

## Data-flow guarantee

The finance application must not transmit transaction, account balance, debt, budget, goal, or planning data to ShareCapsule or any third party.

The page currently enforces this at the browser layer with a Content Security Policy containing `connect-src 'none'` and by shipping no analytics, advertising, remote fonts, third-party JavaScript, bank SDKs, or AI API calls.

All financial calculations are deterministic JavaScript executed in the browser.

## Local encrypted vault

Persistent financial data is stored only as an encrypted IndexedDB record on the user's device.

- Encryption: AES-GCM, 256-bit key.
- Passphrase KDF: PBKDF2-HMAC-SHA-256.
- PBKDF2 work factor: 600,000 iterations.
- Salt: random 128-bit value per vault.
- AES-GCM IV: new random 96-bit value for every save.
- The passphrase is never persisted by the application.
- The derived `CryptoKey` is non-extractable and exists only in page memory while the vault is unlocked.
- The decrypted JSON is kept only in page memory.
- The app locks after inactivity and clears the in-memory key/state references on lock or unload.
- Backups contain only the encrypted vault envelope, never plaintext financial data.

The vault envelope contains ciphertext plus the non-secret KDF/cipher parameters needed for decryption: salt, IV, algorithm identifiers, iteration count, and format version.

## Data the application must never request

Do not add UI that asks users for:

- online banking username or password
- one-time passcodes or MFA recovery codes
- debit/credit card numbers
- full bank account or routing numbers
- Social Security numbers or tax IDs
- brokerage or crypto private keys / seed phrases

Display names such as `Checking`, `401(k)`, or `Mortgage` and user-entered balances are sufficient for this local planner.

## Dedicated-origin launch requirement

`/finance/` inside the main ShareCapsule origin is suitable for development and review, but a production finance product should be served from a dedicated origin such as:

`https://finance.sharecapsule.app/`

A separate origin reduces the blast radius of an unrelated same-origin ShareCapsule vulnerability and gives the finance application an independent browser storage namespace.

The dedicated origin should not host unrelated content, third-party widgets, ad scripts, analytics, tag managers, or user-generated executable content.

## Required production response headers

The production finance origin should set security policy in HTTP response headers rather than relying only on an HTML meta tag. At minimum review and deploy:

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()
Cache-Control: no-store
```

`style-src 'unsafe-inline'` is currently required because local JavaScript sets progress widths. It does not permit scripts, and the policy still blocks all outbound connection and remote resource channels. A later hardening pass can remove it by replacing dynamic inline style widths with CSP-safe presentation primitives.

## Threat model

This architecture is designed to protect financial data from:

- accidental server-side collection
- ShareCapsule database compromise (there is no financial database)
- network-side inspection of financial values (they are not sent)
- casual access to browser storage without the vault passphrase
- third-party analytics/advertising exfiltration (none are loaded)

It cannot guarantee confidentiality on a compromised device. Malware, a malicious browser extension with page access, a compromised browser, screen capture, keylogging, or hostile software running with sufficient device privileges can still expose data while the vault is unlocked.

## Security review before production

Before calling this production-ready:

1. Serve the feature from the dedicated finance origin.
2. Set and verify the HTTP security headers above.
3. Run a dependency review (the current app intentionally has no runtime third-party dependencies).
4. Run static analysis and browser security tests.
5. Test vault creation, lock/unlock, wrong-passphrase behavior, backup/restore, corrupted backups, private browsing, storage eviction, and multi-tab behavior.
6. Test XSS injection attempts against every user-controlled text field and CSV import.
7. Confirm the browser devtools Network panel shows no finance-data network traffic.
8. Confirm IndexedDB contains ciphertext only.
9. Arrange an independent security review before promoting the product for real-world financial use.

## Reference guidance used for the design

The implementation follows the browser cryptography primitives defined by the W3C Web Cryptography API and uses AES-GCM authenticated encryption. The PBKDF2 work factor is aligned with current OWASP Password Storage Cheat Sheet guidance for PBKDF2-HMAC-SHA-256. OWASP client-side storage guidance is also why plaintext financial information is never written to LocalStorage, SessionStorage, or IndexedDB.

# ShareCapsule Finance

Privacy-first personal finance workspace published at:

`https://finance.sharecapsule.app`

## Finance vault

The planner stores finance state as an AES-GCM encrypted IndexedDB vault. The vault passphrase is not persisted and decrypted finance JSON is kept only in browser memory while unlocked.

Core tools include:

- cash-flow tracking
- transaction CSV import
- category budgets
- asset/net-worth tracking
- debt/APR tracking
- savings goals
- emergency-fund runway
- 12-month projection
- deterministic local planning guidance
- encrypted backup/restore
- inactivity lock
- financial education guide under `/guide/`

## Multi-device sync

The `agent/qr-device-pairing` implementation adds optional encrypted device sync:

1. Unlock the finance vault on the first device.
2. Open **Devices**.
3. Select **Enable sync & add device**.
4. A one-time QR is generated locally.
5. Scan the QR with the normal Camera app on the phone.
6. The phone downloads the encrypted vault and connects to the same encrypted sync channel.
7. Unlock the phone with the existing vault passphrase.

The QR does not contain the vault passphrase or financial data. Pairing is single-use and expires after five minutes.

The sync relay code is in `sync-worker/`. It stores encrypted vault ciphertext, not decrypted finance JSON. See `sync-worker/README.md` for deployment.

## Security

Read `SECURITY.md` before enabling sync for real financial information.

Local-only remains the default and does not require the sync relay.

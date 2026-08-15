# ShareCapsule Finance

Privacy-first financial control platform published at:

`https://finance.sharecapsule.app`

## Platform areas

- `/` — Private Planner
- `/guide/` — Financial Control Guide
- `/passive-income/` — Income Project Lab
- `/about/` — About and Trust Center
- `/methodology/` — Editorial and recommendation methodology
- `/privacy/` — Privacy model
- `/security/` — Security model
- `/sources/` — Source standards and primary references
- `/roadmap/` — Product roadmap

Search/discovery files:

- `/robots.txt`
- `/sitemap.xml`
- `/404.html`

See `PUBLISHING.md` for the production release checklist.

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
- financial education guide
- passive-income project planning
- optional encrypted multi-device sync

## Multi-device sync

Optional encrypted device sync supports laptop/mobile use with one-time QR pairing.

1. Unlock the finance vault on the first device.
2. Open **Devices**.
3. Select **Enable sync & add device**.
4. A one-time QR is generated locally.
5. Scan the QR with the normal Camera app on the phone.
6. The second device downloads the encrypted vault and joins the same encrypted sync channel.
7. Unlock the second device with the existing vault passphrase.
8. Encrypted local saves are pushed to the relay and newer remote encrypted records can update an already-unlocked trusted device.

The QR does not contain the vault passphrase or financial data. Pairing is single-use and expires after five minutes.

The sync relay code is in `sync-worker/`. It stores encrypted vault ciphertext, not decrypted finance JSON. See `sync-worker/README.md` for deployment details.

## Income Project Lab

`/passive-income/` provides realistic additional-income project ideas and a one-project-at-a-time workflow. Users can:

- select one idea as the active focus
- track milestones and progress
- record optional monthly results
- mark the project complete
- continue post-launch updates
- start the next project while keeping project history

This first version stores Income Project Lab progress locally in the browser with a device-held encryption key.

## Publishing

Before broad promotion, run the full `PUBLISHING.md` checklist. The release gate includes:

- domain/HTTPS validation
- planner create/unlock/backup/restore testing
- real laptop + mobile sync testing
- conflict testing
- relay/D1 privacy checks
- guide/trust review
- browser/mobile layout checks
- sitemap/robots/404 verification

## Security

Read `SECURITY.md` before enabling sync for real financial information.

Local-only remains the default and does not require the sync relay.

## Domain migration export

Because IndexedDB is origin-scoped, browser data at `finance.sharecapsule.app` does not automatically appear at a future `finance.sharecapsule.org` origin. The unlocked planner therefore provides **Privacy → Export all records**.

The portable `sharecapsule-finance-export-v2` JSON file contains:

- the existing AES-GCM encrypted finance vault envelope
- Income Project Lab state, when present, re-encrypted under the finance vault key for portability
- non-sensitive export metadata such as format version and source origin

The export intentionally excludes device-sync authorization material and tab-session state. On the destination domain, import the file, unlock with the existing vault passphrase, verify the planner and Income Lab data, and then configure device sync again for the new origin.

Legacy `sharecapsule-private-finance-v1` encrypted backup files remain import-compatible.

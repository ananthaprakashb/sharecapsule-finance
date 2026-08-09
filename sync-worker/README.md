# ShareCapsule Finance encrypted sync relay

This Worker is an optional relay for multi-device finance vault synchronization.

It never receives the vault passphrase and never receives decrypted finance JSON. The `payload` stored in D1 is the same AES-GCM encrypted vault envelope already stored in the browser's IndexedDB.

## Pairing flow

1. The first device enables sync and uploads the encrypted vault envelope.
2. The browser creates a random one-time pairing secret and a five-minute pairing record.
3. The QR contains `vaultId + pairId + pairSecret` in the URL fragment. No financial values or vault passphrase are in the QR.
4. The second device claims the one-time pairing record.
5. It receives the encrypted vault plus a sync authorization token wrapped with the one-time pairing secret.
6. The pairing record is deleted atomically when claimed.
7. The second device still needs the existing vault passphrase to decrypt the financial vault.

## Deploy

From this directory:

```bash
npx wrangler@latest login
npx wrangler@latest d1 create sharecapsule-finance-sync
```

Copy the returned D1 `database_id` into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

Apply the schema:

```bash
npx wrangler@latest d1 migrations apply sharecapsule-finance-sync --remote
```

Deploy the Worker:

```bash
npx wrangler@latest deploy
```

The Wrangler configuration declares `sync.finance.sharecapsule.app` as a Worker Custom Domain. Do not point that hostname at GitHub Pages; it belongs to this relay Worker.

## Verify

The application origin is restricted to:

```text
https://finance.sharecapsule.app
```

A request without authorization should fail. For example:

```bash
curl -i https://sync.finance.sharecapsule.app/v1/vault/AAAAAAAAAAAAAAAAAAAAAA
```

Expected result after deployment: an authorization/not-found error rather than finance data.

## Stored server-side

D1 stores only:

- opaque random vault identifier
- SHA-256 hash of the sync authorization token
- encrypted vault envelope/ciphertext
- monotonically increasing revision
- opaque random device identifier for the last write
- timestamps
- short-lived one-time pairing records

## Not stored server-side

- vault passphrase
- decrypted transactions
- decrypted account balances
- decrypted debt balances
- decrypted budgets/goals
- bank credentials
- card numbers
- Social Security numbers

## Conflict behavior

Every upload includes the last revision seen by that device. If another device has already written a newer revision, the relay returns `409 Sync conflict` instead of silently overwriting it. The browser asks the user which encrypted version should win.

## Production hardening before public launch

- enable Cloudflare rate limiting for the sync API
- keep Worker request/body logging free of Authorization values and request bodies
- verify D1 backups/retention policy
- add automated API tests for auth, expiration, replay, conflict, payload-size and CORS behavior
- obtain an independent security review before recommending sync for real financial data

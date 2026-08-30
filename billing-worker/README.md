# ShareCapsule Finance Billing / Identity Worker

This Worker provides account identity, subscription state and server-side feature entitlements without receiving decrypted finance-vault data.

## Privacy boundary

Stored server-side:

- opaque ShareCapsule user ID
- Google account subject, email, display name and optional profile image
- SHA-256 hashes of random session tokens
- Stripe customer/subscription identifiers and status
- feature entitlement flags
- Stripe webhook event IDs for idempotency

Not stored here:

- finance vault ciphertext or passphrase
- decrypted transactions, balances, debts, goals or holdings
- readable Ticker Watch watchlist contents
- brokerage credentials

The finance vault and billing identity remain separate systems.

## Routes

- `GET /v1/auth/google/start` — begins Google OAuth
- `GET /v1/auth/google/callback` — verifies OAuth state, exchanges the code and creates an opaque session
- `GET /v1/me` — returns account, plan and feature flags
- `POST /v1/logout` — revokes this browser session
- `POST /v1/checkout` — creates Stripe Checkout for Plus
- `POST /v1/portal` — creates a Stripe Customer Portal session
- `POST /v1/stripe/webhook` — verifies Stripe signature and updates subscription/entitlement state
- `GET /v1/feature/:feature` — returns the authenticated user's entitlement for one feature
- `GET /health` — service health response

## 1. Create the D1 database

From `billing-worker/`:

```powershell
npx wrangler d1 create sharecapsule-finance-billing
```

Copy the returned UUID into `wrangler.toml`:

```toml
database_id = "THE_RETURNED_UUID"
```

Apply the schema:

```powershell
npx wrangler d1 migrations apply sharecapsule-finance-billing --remote --config .\wrangler.toml
```

## 2. Configure Google OAuth

Create a Google OAuth **Web application** client.

Authorized redirect URI:

```text
https://billing.sharecapsule.org/v1/auth/google/callback
```

The Worker requests only:

```text
openid email profile
```

Store credentials as Worker secrets; never commit them:

```powershell
npx wrangler secret put GOOGLE_CLIENT_ID --config .\wrangler.toml
npx wrangler secret put GOOGLE_CLIENT_SECRET --config .\wrangler.toml
```

## 3. Configure Stripe

Create one Stripe product for **ShareCapsule Finance Plus** with monthly and annual recurring prices.

Set the identifiers/secrets in the Worker:

```powershell
npx wrangler secret put STRIPE_SECRET_KEY --config .\wrangler.toml
npx wrangler secret put STRIPE_PRICE_PLUS_MONTHLY --config .\wrangler.toml
npx wrangler secret put STRIPE_PRICE_PLUS_ANNUAL --config .\wrangler.toml
```

Configure a Stripe webhook endpoint:

```text
https://billing.sharecapsule.org/v1/stripe/webhook
```

Subscribe it to at least:

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
```

Then save the webhook signing secret:

```powershell
npx wrangler secret put STRIPE_WEBHOOK_SECRET --config .\wrangler.toml
```

The webhook signature is verified against the raw request body before any D1 subscription state is changed.

## 4. Deploy

```powershell
npx wrangler deploy --config .\wrangler.toml
```

The custom domain in Wrangler is:

```text
billing.sharecapsule.org
```

Do not manually create a conflicting CNAME for that hostname when using a Workers Custom Domain.

## 5. Verify

Health:

```powershell
curl.exe "https://billing.sharecapsule.org/health"
```

Expected:

```json
{"ok":true,"service":"sharecapsule-finance-billing"}
```

CORS / anonymous entitlement state:

```powershell
curl.exe -i -H "Origin: https://finance.sharecapsule.org" "https://billing.sharecapsule.org/v1/me"
```

Expected body begins with:

```json
{"authenticated":false,"plan":"free"}
```

Then open:

```text
https://finance.sharecapsule.org/account/
```

and test Google sign-in before enabling live Stripe prices.

## Entitlement model

Free remains the privacy foundation:

- `finance_vault`
- `basic_ticker_watch`
- `single_ticker_audio`
- `watchlist_sync`

Plus currently provisions:

- `daily_watchlist_briefing`
- `scheduled_briefing`
- `briefing_history`
- `advanced_alerts`

The next premium API should check one of these entitlements in the Worker before doing paid work. UI-only hiding is not considered authorization.

## Session design

The browser receives a random 256-bit opaque **host-only** session cookie from `billing.sharecapsule.org`. D1 stores only its SHA-256 hash. Sessions expire after 30 days and can be revoked on sign-out. The account UI on `finance.sharecapsule.org` calls the billing Worker with credentialed requests; the session cookie is not widened to unrelated ShareCapsule subdomains.

State-changing browser routes require the exact `https://finance.sharecapsule.org` `Origin`. The session cookie is `Secure`, `HttpOnly` and `SameSite=Lax`.

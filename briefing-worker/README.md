# ShareCapsule Finance Plus Watchlist Briefing Worker

This Worker powers the on-demand **whole-watchlist briefing** for Plus subscribers.

## Privacy / entitlement design

The finance frontend does not send the readable watchlist to the billing service.

1. `billing.sharecapsule.org` verifies the existing Google-backed session and the `daily_watchlist_briefing` entitlement.
2. Billing returns a short-lived HMAC-signed capability token containing only the feature name, timestamps and a random nonce. It contains no ShareCapsule user ID, email, watchlist or finance data.
3. The browser decrypts the watchlist locally and sends only ticker symbols plus that short-lived capability to `briefing.sharecapsule.org`.
4. The briefing Worker verifies the capability, loads public market/news/SEC data through the existing market gateway, ranks the most material returned events, and returns a structured briefing.
5. The briefing Worker has no D1 binding and does not persist the watchlist or the generated briefing.

The finance vault, balances, holdings, transactions, cost basis and brokerage credentials are never sent to this Worker.

## Shared capability secret

Generate one strong random secret and store the **same value** in both Workers as `BRIEFING_CAPABILITY_SECRET`.

Billing Worker:

```powershell
cd ..\billing-worker
npx wrangler secret put BRIEFING_CAPABILITY_SECRET --config .\wrangler.toml
```

Briefing Worker:

```powershell
cd ..\briefing-worker
npx wrangler secret put BRIEFING_CAPABILITY_SECRET --config .\wrangler.toml
```

Do not commit the secret.

## Deploy

```powershell
cd briefing-worker
npx wrangler deploy --config .\wrangler.toml
```

Custom domain:

```text
briefing.sharecapsule.org
```

Do not manually create a conflicting DNS record when using the Workers Custom Domain.

Health check:

```powershell
curl.exe "https://briefing.sharecapsule.org/health"
```

Expected:

```json
{"ok":true,"service":"sharecapsule-finance-briefing"}
```

## Billing Worker deployment

This feature changes the billing Worker entry point from `src/index.js` to `src/entry.js`. The new entry delegates all existing OAuth, Stripe and account routes unchanged and adds:

```text
POST /v1/capability/daily_watchlist_briefing
```

After setting the shared secret, redeploy billing:

```powershell
cd billing-worker
npx wrangler deploy --config .\wrangler.toml
```

## End-to-end test

1. Sign in at `https://finance.sharecapsule.org/account/` with a Stripe test-mode Plus account.
2. Add several tickers in `/trade/`.
3. Open **Whole-watchlist briefing** and generate a briefing.
4. Confirm Free/not-signed-in accounts are redirected to the account/upgrade flow.
5. Confirm Plus accounts receive ranked highlights and source links.
6. Confirm the browser can play the generated transcript with SpeechSynthesis.

## Market-data licensing

This Worker is suitable for development and subscription-flow testing, but a paid public launch must use market/news data under terms that permit the intended commercial use and redistribution. Confirm the configured provider plan/licensing before enabling this feature for paying production customers.

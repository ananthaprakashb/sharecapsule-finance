# ShareCapsule Finance Plus Watchlist Briefing Worker

This Worker powers the on-demand **whole-watchlist briefing** for Plus subscribers.

## Privacy / entitlement design

The finance frontend does not send the readable watchlist to the billing service.

1. `billing.sharecapsule.org` verifies the existing Google-backed session and the `daily_watchlist_briefing` entitlement.
2. Billing returns a short-lived HMAC-signed capability token containing only the feature name, timestamps and a random nonce. It contains no ShareCapsule user ID, email, watchlist or finance data.
3. The browser decrypts the watchlist locally and sends only ticker symbols plus that short-lived capability to `briefing.sharecapsule.org`.
4. The briefing Worker verifies the capability and sends the requested ticker symbols to a protected server-only batch endpoint on the existing market Worker.
5. The market Worker performs a batch snapshot request plus a multi-ticker news request, avoiding the previous per-ticker provider fan-out that could trigger provider rate limits.
6. The briefing Worker ranks the most material returned events and returns a structured briefing.
7. Neither the briefing Worker nor the batch market endpoint persists the requested watchlist or generated briefing.

The finance vault, balances, holdings, transactions, cost basis and brokerage credentials are never sent to these Workers.

## Shared capability secret

Generate one strong random secret and store the **same value** in both billing and briefing Workers as `BRIEFING_CAPABILITY_SECRET`.

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

## Server-only batch market secret

Generate a second strong random secret and store the **same value** in the market Worker and briefing Worker as `MARKET_BATCH_SECRET`.

Market Worker:

```powershell
cd ..\market-worker
npx wrangler secret put MARKET_BATCH_SECRET --config .\wrangler.toml
```

Briefing Worker:

```powershell
cd ..\briefing-worker
npx wrangler secret put MARKET_BATCH_SECRET --config .\wrangler.toml
```

This secret is never exposed to the browser. The protected endpoint is:

```text
POST https://finance-market.sharecapsule.org/v1/watchlist
```

It accepts only server-to-server requests with the shared bearer secret and processes up to 30 ticker symbols in one request.

## Deploy

Redeploy the market Worker first:

```powershell
cd market-worker
npx wrangler deploy --config .\wrangler.toml
```

Then deploy the briefing Worker:

```powershell
cd ..\briefing-worker
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

The Plus briefing feature uses the billing Worker entry point `src/entry.js`, which delegates existing OAuth, Stripe and account routes and adds:

```text
POST /v1/capability/daily_watchlist_briefing
```

If the capability secret changes, redeploy billing:

```powershell
cd billing-worker
npx wrangler deploy --config .\wrangler.toml
```

## End-to-end test

1. Sign in at `https://finance.sharecapsule.org/account/` with a Stripe test-mode Plus account.
2. Add several tickers in `/trade/`.
3. Open **Whole-watchlist briefing** and generate a briefing.
4. Confirm Free/not-signed-in accounts are redirected to the account/upgrade flow.
5. Confirm Plus accounts receive multiple ticker snapshots and ranked source links.
6. Confirm tickers without a top-ranked story remain listed as watchlist coverage instead of failing to load.
7. Confirm the browser can play the generated transcript with SpeechSynthesis.

## Provider request behavior

The single-ticker Ticker Watch endpoint remains unchanged. The Plus whole-watchlist flow uses the batch market endpoint so one watchlist generation normally needs only:

- one Massive full-market snapshot request filtered to the requested tickers
- one Massive news request using multi-ticker filter modifiers

If the provider does not accept the multi-ticker news modifier, the market Worker falls back to one broad recent-news request and filters ticker associations in memory. This keeps the request count bounded instead of making several provider calls for every ticker.

SEC filings remain available in the existing single-ticker research view. They are intentionally omitted from the first batch watchlist response to avoid a per-company CIK/SEC fan-out.

## Market-data licensing

This Worker is suitable for development and subscription-flow testing, but a paid public launch must use market/news data under terms that permit the intended commercial use and redistribution. Confirm the configured provider plan/licensing before enabling this feature for paying production customers.

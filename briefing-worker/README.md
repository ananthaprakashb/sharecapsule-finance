# ShareCapsule Finance Plus Watchlist Briefing Worker

This Worker powers the on-demand **whole-watchlist briefing** for Plus subscribers.

## Privacy / entitlement design

The finance frontend does not send the readable watchlist to the billing service.

1. `billing.sharecapsule.org` verifies the existing Google-backed session and the `daily_watchlist_briefing` entitlement.
2. Billing returns a short-lived HMAC-signed capability token containing only the feature name, timestamps and a random nonce. It contains no ShareCapsule user ID, email, watchlist or finance data.
3. The browser decrypts the watchlist locally and sends only ticker symbols plus that short-lived capability to `briefing.sharecapsule.org`.
4. The briefing Worker verifies the capability and sends the requested ticker symbols to a protected server-only batch endpoint on the existing market Worker.
5. The market Worker performs one news request constrained to the rolling last **24 hours** and matches returned article ticker associations to the requested watchlist. This avoids the previous per-ticker provider fan-out that could trigger provider rate limits.
6. The market Worker independently discards any response item older than 24 hours before returning it, even though the provider request already has a `published_utc.gte` filter.
7. The briefing Worker applies its own 24-hour cutoff again before ranking highlights, so stale news cannot enter the briefing if an upstream response is unexpected.
8. Neither the briefing Worker nor the batch market endpoint persists the requested watchlist or generated briefing.

The finance vault, balances, holdings, transactions, cost basis and brokerage credentials are never sent to these Workers.

## Freshness rule

Whole-watchlist briefings are intentionally **fresh-news only**:

- rolling window: last 24 hours from generation time
- stories older than 24 hours are excluded entirely
- no fallback to older news
- a ticker with no qualifying story is shown as `No news in the last 24 hours`
- ranking favors the newest qualifying items inside the 24-hour window

Massive's News endpoint supports `published_utc` comparison filters. The market Worker uses `published_utc.gte=<24-hour-cutoff>` and then validates timestamps locally as a second guard.

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
5. Confirm every displayed highlight has a publication time within the rolling last 24 hours.
6. Confirm a ticker with no qualifying story shows `No news in the last 24 hours` instead of falling back to older coverage.
7. Confirm tickers without a top-ranked story remain listed as watchlist coverage instead of failing to load.
8. Confirm the browser can play the generated transcript with SpeechSynthesis.

## Provider request behavior

The single-ticker Ticker Watch endpoint still includes quote/news/company-detail requests and SEC filings. Its redundant previous-day provider request has been removed because the snapshot response already carries day/previous-day context when available.

The Plus whole-watchlist flow is deliberately **news-first**. One watchlist generation performs one Massive news request with a maximum limit of 1000 records, constrained by `published_utc.gte` to the rolling last 24 hours, then matches `tickers` / `insights[].ticker` associations in memory against the requested watchlist. This keeps provider usage bounded even on low-rate plans while preventing stale stories from entering the briefing.

A ticker with no matching story in the 24-hour window is still treated as successfully covered; it appears in the watchlist coverage cards and/or `remainingTickers` rather than as a failed load.

Live cross-watchlist price snapshots and SEC filings are intentionally omitted from this first batch path because adding per-ticker provider/CIK calls would recreate the rate-limit fan-out we are avoiding. The existing single-ticker research view remains the place for quote and filing depth.

## Market-data licensing

This Worker is suitable for development and subscription-flow testing, but a paid public launch must use market/news data under terms that permit the intended commercial use and redistribution. Confirm the configured provider plan/licensing before enabling this feature for paying production customers.

const FEATURE = 'daily_watchlist_briefing';
const MAX_TICKERS = 30;
const MAX_HIGHLIGHTS = 8;
const FETCH_TIMEOUT_MS = 15000;
const IMPACT_WEIGHT = Object.freeze({high: 3, medium: 2, low: 1});
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlDecode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function cors(origin, env) {
  if (origin !== env.APP_ORIGIN) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(body, status, origin, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...cors(origin, env)
    }
  });
}

async function verifyCapability(token, env) {
  if (!env.BRIEFING_CAPABILITY_SECRET) return {ok: false, reason: 'not_configured'};
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return {ok: false, reason: 'invalid'};

  let payload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecode(parts[0])));
  } catch {
    return {ok: false, reason: 'invalid'};
  }
  if (payload?.v !== 1 || payload?.feature !== FEATURE || !Number.isFinite(payload?.exp)) return {ok: false, reason: 'invalid'};
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now || payload.exp > now + 300) return {ok: false, reason: 'expired'};

  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.BRIEFING_CAPABILITY_SECRET), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, base64UrlDecode(parts[1]), encoder.encode(parts[0]));
    return valid ? {ok: true, payload} : {ok: false, reason: 'invalid'};
  } catch {
    return {ok: false, reason: 'invalid'};
  }
}

function normalizeTickers(value) {
  const list = Array.isArray(value) ? value : [];
  const unique = [];
  const seen = new Set();
  for (const item of list) {
    const ticker = String(item || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);
    unique.push(ticker);
    if (unique.length >= MAX_TICKERS) break;
  }
  return unique;
}

function freshnessScore(value) {
  const time = new Date(value || 0).getTime();
  if (!Number.isFinite(time) || time <= 0) return 0;
  const hours = Math.max(0, (Date.now() - time) / 3600000);
  if (hours <= 12) return 3;
  if (hours <= 36) return 2;
  if (hours <= 96) return 1;
  return 0;
}

function eventScore(event) {
  const impact = IMPACT_WEIGHT[event.impact] || 1;
  const direction = event.direction && event.direction !== 'neutral' ? 2 : 0;
  const primary = event.kind === 'filing' ? 2 : 0;
  return impact * 10 + direction + primary + freshnessScore(event.publishedAt);
}

function eventsFromTicker(data) {
  const ticker = data.ticker;
  const company = data.company?.name || ticker;
  const news = (Array.isArray(data.news) ? data.news : []).slice(0, 8).map((item) => ({
    kind: 'news', ticker, company,
    title: String(item.title || 'Untitled article'),
    summary: String(item.summary || ''),
    direction: ['positive', 'negative'].includes(item.direction) ? item.direction : 'neutral',
    impact: ['high', 'medium'].includes(item.impact) ? item.impact : 'low',
    why: String(item.impactReason || item.sentimentReason || ''),
    source: String(item.publisher || 'News source'),
    publishedAt: item.publishedAt || null,
    url: String(item.url || '')
  }));
  const filings = (Array.isArray(data.filings) ? data.filings : []).slice(0, 4).map((item) => ({
    kind: 'filing', ticker, company,
    title: `${item.form || 'SEC filing'} — ${item.description || 'Regulatory filing'}`,
    summary: 'Primary-source SEC filing. Review the filing itself for material details.',
    direction: 'neutral',
    impact: item.impact === 'high' ? 'high' : 'medium',
    why: 'Primary-source regulatory filing.',
    source: 'SEC EDGAR',
    publishedAt: item.acceptedAt || item.filed || null,
    url: String(item.url || '')
  }));
  return [...news, ...filings].map((event) => ({...event, score: eventScore(event)}));
}

function dedupeAndRank(events) {
  const byKey = new Map();
  for (const event of events) {
    const key = event.url || `${event.kind}:${event.ticker}:${event.title.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {...event, tickers: [event.ticker]});
      continue;
    }
    if (!existing.tickers.includes(event.ticker)) existing.tickers.push(event.ticker);
    if (event.score > existing.score) {
      const tickers = existing.tickers;
      byKey.set(key, {...event, tickers});
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.score - a.score || String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
    .slice(0, MAX_HIGHLIGHTS);
}

function watchlistContext(results) {
  let positive = 0, negative = 0, neutral = 0, highImpact = 0;
  for (const item of results) {
    const summary = item.data?.newsSummary || {};
    positive += Number(summary.positive || 0);
    negative += Number(summary.negative || 0);
    neutral += Number(summary.neutral || 0);
    highImpact += Number(summary.highImpact || 0);
  }
  const directional = positive + negative;
  let tone = 'mixed / neutral';
  if (directional) {
    const skew = (positive - negative) / directional;
    if (skew >= 0.35) tone = 'positive news skew';
    else if (skew <= -0.35) tone = 'negative news skew';
    else if (skew >= 0.1) tone = 'slightly positive news skew';
    else if (skew <= -0.1) tone = 'slightly negative news skew';
  }
  return {positive, negative, neutral, highImpact, tone};
}

async function loadWatchlist(tickers, env) {
  if (!env.MARKET_BATCH_SECRET) throw new Error('Batch market access is not configured.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(env.MARKET_API, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.MARKET_BATCH_SECRET}`
      },
      body: JSON.stringify({symbols: tickers}),
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `market gateway returned ${response.status}`);
    const items = Array.isArray(body.items) ? body.items : [];
    const byTicker = new Map(items.map((item) => [String(item?.ticker || '').toUpperCase(), item]));
    return tickers.map((ticker) => {
      const data = byTicker.get(ticker);
      return data ? {ticker, ok: true, data} : {ticker, ok: false, error: 'No batch market payload was returned for this ticker.'};
    });
  } catch (error) {
    const message = error.name === 'AbortError' ? 'batch market request timed out' : String(error.message || error);
    return tickers.map((ticker) => ({ticker, ok: false, error: message}));
  } finally {
    clearTimeout(timeout);
  }
}

function snapshots(results) {
  return results.filter((item) => item.ok).map((item) => {
    const data = item.data || {};
    return {
      ticker: item.ticker,
      company: data.company?.name || item.ticker,
      price: Number.isFinite(Number(data.quote?.price)) ? Number(data.quote.price) : null,
      changePercent: Number.isFinite(Number(data.quote?.changePercent)) ? Number(data.quote.changePercent) : null,
      tone: data.newsSummary?.label || 'No recent news',
      toneScore: Number(data.newsSummary?.score || 0),
      highImpactStories: Number(data.newsSummary?.highImpact || 0)
    };
  });
}

async function generate(request, env, origin) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const verified = await verifyCapability(token, env);
  if (!verified.ok) return json({error: verified.reason === 'not_configured' ? 'Briefing capability verification is not configured.' : 'invalid_or_expired_capability'}, verified.reason === 'not_configured' ? 503 : 401, origin, env);

  const input = await request.json().catch(() => ({}));
  const tickers = normalizeTickers(input.tickers);
  if (!tickers.length) return json({error: 'Provide at least one valid ticker.'}, 400, origin, env);

  const results = await loadWatchlist(tickers, env);
  const successes = results.filter((item) => item.ok);
  if (!successes.length) return json({error: 'Market data could not be loaded for the requested watchlist.', failures: results.map(({ticker, error}) => ({ticker, error}))}, 502, origin, env);

  const allEvents = successes.flatMap((item) => eventsFromTicker(item.data));
  const highlights = dedupeAndRank(allEvents);
  const highlightedTickers = new Set(highlights.flatMap((event) => event.tickers || [event.ticker]));
  const context = watchlistContext(successes);

  return json({
    feature: FEATURE,
    generatedAt: new Date().toISOString(),
    requestedTickerCount: tickers.length,
    loadedTickerCount: successes.length,
    context,
    snapshots: snapshots(results),
    highlights: highlights.map(({score, ...event}) => event),
    remainingTickers: tickers.filter((ticker) => !highlightedTickers.has(ticker)),
    failures: results.filter((item) => !item.ok).map(({ticker, error}) => ({ticker, error})),
    privacy: 'Only the ticker symbols explicitly included in this request were processed. No finance vault, balances, holdings, transactions, cost basis, brokerage credentials, or ShareCapsule user identity were sent to the briefing service. The downstream market batch endpoint is server-only and does not persist the requested symbols.',
    guardrail: 'This briefing summarizes public market information and recent coverage for research. It does not predict price direction or recommend a trade.'
  }, 200, origin, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (url.pathname === '/health' && request.method === 'GET') return json({ok: true, service: 'sharecapsule-finance-briefing'}, 200, origin, env);
    if (request.method === 'OPTIONS') {
      if (origin !== env.APP_ORIGIN) return new Response(null, {status: 403});
      return new Response(null, {status: 204, headers: cors(origin, env)});
    }
    if (origin !== env.APP_ORIGIN) return json({error: 'Origin not allowed.'}, 403, origin, env);
    if (url.pathname !== '/v1/watchlist') return json({error: 'Not found'}, 404, origin, env);
    if (request.method !== 'POST') return json({error: 'Method not allowed'}, 405, origin, env);
    if (!env.MARKET_API) return json({error: 'Market gateway is not configured.'}, 503, origin, env);
    return generate(request, env, origin);
  }
};

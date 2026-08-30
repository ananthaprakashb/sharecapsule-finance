import billing from './index.js';

const CAPABILITY_TTL_SECONDS = 180;
const SUPPORTED_CAPABILITIES = new Set(['daily_watchlist_briefing']);
const encoder = new TextEncoder();

function base64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlText(value) {
  return base64Url(encoder.encode(value));
}

async function sign(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    ['sign']
  );
  return base64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return base64Url(bytes);
}

function json(body, status = 200, origin = '') {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Vary'] = 'Origin';
  }
  return new Response(JSON.stringify(body), {status, headers});
}

async function issueCapability(request, env, feature) {
  const origin = request.headers.get('Origin') || '';
  if (origin !== env.APP_ORIGIN) return json({error: 'Origin not allowed.'}, 403);
  if (!SUPPORTED_CAPABILITIES.has(feature)) return json({error: 'Unsupported capability.'}, 404, origin);
  if (!env.BRIEFING_CAPABILITY_SECRET) return json({error: 'Premium capability signing is not configured.'}, 503, origin);

  const checkUrl = new URL(`/v1/feature/${encodeURIComponent(feature)}`, env.PUBLIC_ORIGIN);
  const checkRequest = new Request(checkUrl, {
    method: 'GET',
    headers: {
      Cookie: request.headers.get('Cookie') || '',
      Origin: origin,
      Accept: 'application/json'
    }
  });
  const checkResponse = await billing.fetch(checkRequest, env);
  const check = await checkResponse.json().catch(() => ({}));
  if (!check.authenticated) return json({error: 'authentication_required'}, 401, origin);
  if (!check.allowed) return json({error: 'plus_required', feature}, 403, origin);

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    feature,
    iat: now,
    exp: now + CAPABILITY_TTL_SECONDS,
    nonce: randomNonce()
  };
  const encoded = base64UrlText(JSON.stringify(payload));
  const signature = await sign(env.BRIEFING_CAPABILITY_SECRET, encoded);
  return json({token: `${encoded}.${signature}`, feature, expiresAt: payload.exp}, 200, origin);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const prefix = '/v1/capability/';
    if (request.method === 'POST' && url.pathname.startsWith(prefix)) {
      const feature = decodeURIComponent(url.pathname.slice(prefix.length));
      return issueCapability(request, env, feature);
    }
    return billing.fetch(request, env, ctx);
  }
};

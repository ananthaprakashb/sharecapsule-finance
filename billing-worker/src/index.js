const SESSION_COOKIE = 'scf_session';
const OAUTH_STATE_COOKIE = 'scf_oauth_state';
const RETURN_COOKIE = 'scf_return_to';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_TTL_SECONDS = 10 * 60;
const STRIPE_TOLERANCE_SECONDS = 300;
const encoder = new TextEncoder();

const FREE_FEATURES = Object.freeze({
  finance_vault: true,
  basic_ticker_watch: true,
  single_ticker_audio: true,
  watchlist_sync: true,
  daily_watchlist_briefing: false,
  scheduled_briefing: false,
  briefing_history: false,
  advanced_alerts: false
});

const PLUS_FEATURES = Object.freeze([
  'daily_watchlist_briefing',
  'scheduled_briefing',
  'briefing_history',
  'advanced_alerts'
]);

function nowIso() { return new Date().toISOString(); }
function nowSeconds() { return Math.floor(Date.now() / 1000); }

function randomUrlSafe(bytes = 32) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

function safeReturnPath(value) {
  const text = String(value || '/account/');
  if (!text.startsWith('/') || text.startsWith('//') || /[\r\n]/.test(text)) return '/account/';
  return text;
}

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const result = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch { result[key] = value; }
  }
  return result;
}

function cookie(name, value, env, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'Secure', 'HttpOnly', `SameSite=${options.sameSite || 'Lax'}`];
  if (env.COOKIE_DOMAIN) parts.push(`Domain=${env.COOKIE_DOMAIN}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Number(options.maxAge) || 0)}`);
  return parts.join('; ');
}

function clearCookie(name, env) { return cookie(name, '', env, {maxAge: 0}); }

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  };
  if (origin === env.APP_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function json(request, env, body, status = 200, extra = {}) {
  const headers = new Headers({...corsHeaders(request, env), 'Content-Type': 'application/json; charset=utf-8', ...extra});
  return new Response(JSON.stringify(body), {status, headers});
}

function redirect(location, headers = []) {
  const responseHeaders = new Headers({Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'});
  for (const value of headers) responseHeaders.append('Set-Cookie', value);
  return new Response(null, {status: 302, headers: responseHeaders});
}

function requireAppOrigin(request, env) {
  const origin = request.headers.get('Origin');
  return origin === env.APP_ORIGIN;
}

async function stripeRequest(env, path, params) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `Stripe returned ${response.status}`);
  return body;
}

async function userFromSession(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || token.length < 30) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`
    SELECT u.id, u.email, u.display_name, u.picture_url, u.stripe_customer_id, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, nowSeconds()).first();
  if (!row) return null;
  return row;
}

async function createSession(env, userId) {
  const token = randomUrlSafe(32);
  const tokenHash = await sha256(token);
  const now = nowIso();
  const expiresAt = nowSeconds() + SESSION_TTL_SECONDS;
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .bind(tokenHash, userId, expiresAt, now, now).run();
  return token;
}

async function revokeSession(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

async function upsertGoogleUser(env, profile) {
  let user = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(profile.sub).first();
  const timestamp = nowIso();
  if (user) {
    await env.DB.prepare('UPDATE users SET email = ?, display_name = ?, picture_url = ?, updated_at = ? WHERE id = ?')
      .bind(profile.email, profile.name || null, profile.picture || null, timestamp, user.id).run();
    return {...user, email: profile.email, display_name: profile.name || null, picture_url: profile.picture || null};
  }

  const byEmail = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(profile.email).first();
  if (byEmail) {
    await env.DB.prepare('UPDATE users SET google_sub = ?, display_name = ?, picture_url = ?, updated_at = ? WHERE id = ?')
      .bind(profile.sub, profile.name || null, profile.picture || null, timestamp, byEmail.id).run();
    return {...byEmail, google_sub: profile.sub, display_name: profile.name || null, picture_url: profile.picture || null};
  }

  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, google_sub, email, display_name, picture_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, profile.sub, profile.email, profile.name || null, profile.picture || null, timestamp, timestamp).run();
  return {id, email: profile.email, display_name: profile.name || null, picture_url: profile.picture || null, stripe_customer_id: null};
}

async function authStart(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json(request, env, {error: 'Google sign-in is not configured.'}, 503);
  const url = new URL(request.url);
  const state = randomUrlSafe(24);
  const returnTo = safeReturnPath(url.searchParams.get('return_to'));
  const redirectUri = `${env.PUBLIC_ORIGIN}/v1/auth/google/callback`;
  const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorize.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'openid email profile');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('access_type', 'online');
  authorize.searchParams.set('prompt', 'select_account');
  return redirect(authorize.href, [
    cookie(OAUTH_STATE_COOKIE, state, env, {maxAge: OAUTH_TTL_SECONDS}),
    cookie(RETURN_COOKIE, returnTo, env, {maxAge: OAUTH_TTL_SECONDS})
  ]);
}

async function authCallback(request, env) {
  const url = new URL(request.url);
  const cookies = parseCookies(request);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const returnTo = safeReturnPath(cookies[RETURN_COOKIE]);
  const failure = `${env.APP_ORIGIN}/account/?auth=failed`;
  if (!state || !code || state !== cookies[OAUTH_STATE_COOKIE]) {
    return redirect(failure, [clearCookie(OAUTH_STATE_COOKIE, env), clearCookie(RETURN_COOKIE, env)]);
  }

  try {
    const redirectUri = `${env.PUBLIC_ORIGIN}/v1/auth/google/callback`;
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: redirectUri})
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.access_token) throw new Error('Google token exchange failed.');

    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: {Authorization: `Bearer ${tokens.access_token}`}
    });
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.sub || !profile.email) throw new Error('Google profile could not be verified.');

    const user = await upsertGoogleUser(env, profile);
    const session = await createSession(env, user.id);
    return redirect(`${env.APP_ORIGIN}${returnTo}`, [
      cookie(SESSION_COOKIE, session, env, {maxAge: SESSION_TTL_SECONDS}),
      clearCookie(OAUTH_STATE_COOKIE, env),
      clearCookie(RETURN_COOKIE, env)
    ]);
  } catch (error) {
    console.error('OAuth callback failed', error);
    return redirect(failure, [clearCookie(OAUTH_STATE_COOKIE, env), clearCookie(RETURN_COOKIE, env)]);
  }
}

async function subscriptionForUser(env, userId) {
  return env.DB.prepare(`
    SELECT plan, status, current_period_end, cancel_at_period_end
    FROM subscriptions WHERE user_id = ?
    ORDER BY updated_at DESC LIMIT 1
  `).bind(userId).first();
}

async function entitlementsForUser(env, userId) {
  const rows = await env.DB.prepare('SELECT feature, enabled FROM entitlements WHERE user_id = ?').bind(userId).all();
  const features = {...FREE_FEATURES};
  for (const row of rows.results || []) features[row.feature] = Boolean(row.enabled);
  return features;
}

async function me(request, env) {
  const user = await userFromSession(request, env);
  if (!user) return json(request, env, {authenticated: false, plan: 'free', features: FREE_FEATURES});
  const subscription = await subscriptionForUser(env, user.id);
  const features = await entitlementsForUser(env, user.id);
  return json(request, env, {
    authenticated: true,
    user: {id: user.id, email: user.email, name: user.display_name || null, picture: user.picture_url || null},
    plan: subscription?.plan === 'plus' && ['active', 'trialing', 'past_due'].includes(subscription.status) ? 'plus' : 'free',
    subscription: subscription ? {
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end || null,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end)
    } : null,
    features
  });
}

async function logout(request, env) {
  if (!requireAppOrigin(request, env)) return json(request, env, {error: 'Origin not allowed.'}, 403);
  await revokeSession(request, env);
  return json(request, env, {ok: true}, 200, {'Set-Cookie': clearCookie(SESSION_COOKIE, env)});
}

async function checkout(request, env) {
  if (!requireAppOrigin(request, env)) return json(request, env, {error: 'Origin not allowed.'}, 403);
  const user = await userFromSession(request, env);
  if (!user) return json(request, env, {error: 'authentication_required'}, 401);
  if (!env.STRIPE_SECRET_KEY) return json(request, env, {error: 'Billing is not configured.'}, 503);

  const input = await request.json().catch(() => ({}));
  const interval = input.interval === 'annual' ? 'annual' : 'monthly';
  const priceId = interval === 'annual' ? env.STRIPE_PRICE_PLUS_ANNUAL : env.STRIPE_PRICE_PLUS_MONTHLY;
  if (!priceId) return json(request, env, {error: `Stripe ${interval} price is not configured.`}, 503);

  const params = {
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    success_url: `${env.APP_ORIGIN}/account/?checkout=success`,
    cancel_url: `${env.APP_ORIGIN}/account/?checkout=cancelled`,
    client_reference_id: user.id,
    'metadata[sharecapsule_user_id]': user.id,
    'subscription_data[metadata][sharecapsule_user_id]': user.id,
    allow_promotion_codes: 'true'
  };
  if (user.stripe_customer_id) params.customer = user.stripe_customer_id;
  else params.customer_email = user.email;

  try {
    const session = await stripeRequest(env, '/v1/checkout/sessions', params);
    return json(request, env, {url: session.url});
  } catch (error) {
    console.error('Checkout failed', error);
    return json(request, env, {error: error.message}, 502);
  }
}

async function portal(request, env) {
  if (!requireAppOrigin(request, env)) return json(request, env, {error: 'Origin not allowed.'}, 403);
  const user = await userFromSession(request, env);
  if (!user) return json(request, env, {error: 'authentication_required'}, 401);
  if (!user.stripe_customer_id) return json(request, env, {error: 'No Stripe customer is linked to this account yet.'}, 409);
  try {
    const session = await stripeRequest(env, '/v1/billing_portal/sessions', {customer: user.stripe_customer_id, return_url: `${env.APP_ORIGIN}/account/`});
    return json(request, env, {url: session.url});
  } catch (error) {
    console.error('Portal session failed', error);
    return json(request, env, {error: error.message}, 502);
  }
}

async function verifyStripeSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  let timestamp = 0;
  const signatures = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't') timestamp = Number(value);
    if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || Math.abs(nowSeconds() - timestamp) > STRIPE_TOLERANCE_SECONDS || !signatures.length) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const expected = bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`)));
  for (const signature of signatures) {
    if (constantTimeHexEqual(expected, signature)) return true;
  }
  return false;
}

function constantTimeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function planFromPrice(env, priceId) {
  return priceId && (priceId === env.STRIPE_PRICE_PLUS_MONTHLY || priceId === env.STRIPE_PRICE_PLUS_ANNUAL) ? 'plus' : 'free';
}

async function resolveStripeUser(env, object) {
  const metadataId = object?.metadata?.sharecapsule_user_id;
  if (metadataId) {
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(metadataId).first();
    if (user) return user;
  }
  const customerId = typeof object?.customer === 'string' ? object.customer : object?.customer?.id;
  if (!customerId) return null;
  return env.DB.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').bind(customerId).first();
}

async function applyEntitlements(env, userId, plan, enabled) {
  await env.DB.prepare('DELETE FROM entitlements WHERE user_id = ? AND source = ?').bind(userId, 'stripe').run();
  if (plan !== 'plus' || !enabled) return;
  const statements = PLUS_FEATURES.map((feature) => env.DB.prepare(
    'INSERT INTO entitlements (user_id, feature, enabled, source, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(user_id, feature) DO UPDATE SET enabled = 1, source = excluded.source, updated_at = excluded.updated_at'
  ).bind(userId, feature, 'stripe', nowIso()));
  if (statements.length) await env.DB.batch(statements);
}

async function handleCheckoutCompleted(env, object) {
  const userId = object.client_reference_id || object?.metadata?.sharecapsule_user_id;
  const customerId = typeof object.customer === 'string' ? object.customer : object?.customer?.id;
  if (!userId || !customerId) return;
  await env.DB.prepare('UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?').bind(customerId, nowIso(), userId).run();
}

async function handleSubscription(env, object) {
  const user = await resolveStripeUser(env, object);
  if (!user) {
    console.warn('Stripe subscription event could not be mapped to a ShareCapsule user', object?.id);
    return;
  }
  const customerId = typeof object.customer === 'string' ? object.customer : object?.customer?.id;
  const firstItem = object?.items?.data?.[0] || null;
  const priceId = firstItem?.price?.id || null;
  const plan = planFromPrice(env, priceId);
  const status = String(object.status || 'unknown');
  const periodEnd = Number(object.current_period_end || firstItem?.current_period_end || 0) || null;
  const cancelAtPeriodEnd = object.cancel_at_period_end ? 1 : 0;
  const accessEnabled = ['active', 'trialing', 'past_due'].includes(status);
  const timestamp = nowIso();

  if (customerId && user.stripe_customer_id !== customerId) {
    await env.DB.prepare('UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?').bind(customerId, timestamp, user.id).run();
  }

  await env.DB.prepare(`
    INSERT INTO subscriptions (stripe_subscription_id, user_id, stripe_customer_id, price_id, plan, status, current_period_end, cancel_at_period_end, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stripe_subscription_id) DO UPDATE SET
      user_id = excluded.user_id,
      stripe_customer_id = excluded.stripe_customer_id,
      price_id = excluded.price_id,
      plan = excluded.plan,
      status = excluded.status,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end,
      updated_at = excluded.updated_at
  `).bind(object.id, user.id, customerId || user.stripe_customer_id || '', priceId, plan, status, periodEnd, cancelAtPeriodEnd, timestamp).run();
  await applyEntitlements(env, user.id, plan, accessEnabled);
}

async function stripeWebhook(request, env) {
  const rawBody = await request.text();
  const valid = await verifyStripeSignature(rawBody, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response('Invalid signature', {status: 400});

  let event;
  try { event = JSON.parse(rawBody); } catch { return new Response('Invalid JSON', {status: 400}); }
  if (!event?.id || !event?.type) return new Response('Invalid event', {status: 400});
  const duplicate = await env.DB.prepare('SELECT event_id FROM stripe_events WHERE event_id = ?').bind(event.id).first();
  if (duplicate) return new Response('ok', {status: 200});

  try {
    if (event.type === 'checkout.session.completed') await handleCheckoutCompleted(env, event.data.object);
    if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
      await handleSubscription(env, event.data.object);
    }
    await env.DB.prepare('INSERT INTO stripe_events (event_id, event_type, processed_at) VALUES (?, ?, ?)').bind(event.id, event.type, nowIso()).run();
    return new Response('ok', {status: 200});
  } catch (error) {
    console.error('Stripe webhook processing failed', event.id, event.type, error);
    return new Response('Webhook processing failed', {status: 500});
  }
}

async function featureCheck(request, env, feature) {
  const user = await userFromSession(request, env);
  if (!user) return json(request, env, {authenticated: false, allowed: Boolean(FREE_FEATURES[feature]), feature}, 200);
  const features = await entitlementsForUser(env, user.id);
  return json(request, env, {authenticated: true, allowed: Boolean(features[feature]), feature, userId: user.id});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      if (request.headers.get('Origin') !== env.APP_ORIGIN) return new Response(null, {status: 403});
      return new Response(null, {status: 204, headers: corsHeaders(request, env)});
    }

    if (request.method === 'POST' && url.pathname === '/v1/stripe/webhook') return stripeWebhook(request, env);
    if (request.method === 'GET' && url.pathname === '/v1/auth/google/start') return authStart(request, env);
    if (request.method === 'GET' && url.pathname === '/v1/auth/google/callback') return authCallback(request, env);
    if (request.method === 'GET' && url.pathname === '/v1/me') return me(request, env);
    if (request.method === 'POST' && url.pathname === '/v1/logout') return logout(request, env);
    if (request.method === 'POST' && url.pathname === '/v1/checkout') return checkout(request, env);
    if (request.method === 'POST' && url.pathname === '/v1/portal') return portal(request, env);
    if (request.method === 'GET' && url.pathname.startsWith('/v1/feature/')) {
      const feature = decodeURIComponent(url.pathname.slice('/v1/feature/'.length));
      return featureCheck(request, env, feature);
    }
    if (request.method === 'GET' && url.pathname === '/health') return json(request, env, {ok: true, service: 'sharecapsule-finance-billing'});
    return json(request, env, {error: 'Not found'}, 404);
  }
};

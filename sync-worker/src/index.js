const DEFAULT_ORIGIN = 'https://finance.sharecapsule.app';
const MAX_PAYLOAD_BYTES = 1_500_000;
const PAIR_TTL_MS = 5 * 60 * 1000;

export default {
  async fetch(request, env) {
    const origin = env.APP_ORIGIN || DEFAULT_ORIGIN;
    const headers = corsHeaders(request, origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    try {
      if (!allowedOrigin(request, origin)) return json({ error: 'Origin not allowed' }, 403, headers);
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      let match = path.match(/^\/v1\/vault\/([A-Za-z0-9_-]{22})$/);
      if (match) {
        if (request.method === 'GET') return getVault(request, env, match[1], headers);
        if (request.method === 'PUT') return putVault(request, env, match[1], headers);
        if (request.method === 'DELETE') return deleteVault(request, env, match[1], headers);
      }

      match = path.match(/^\/v1\/vault\/([A-Za-z0-9_-]{22})\/pairings$/);
      if (match && request.method === 'POST') return createPairing(request, env, match[1], headers);

      match = path.match(/^\/v1\/pairings\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]{11})$/);
      if (match && request.method === 'GET') return claimPairing(request, env, match[1], match[2], headers);

      return json({ error: 'Not found' }, 404, headers);
    } catch (error) {
      return json({ error: error?.message || 'Unexpected sync error' }, 500, headers);
    }
  }
};

function allowedOrigin(request, allowed) {
  const origin = request.headers.get('Origin');
  return !origin || origin === allowed;
}

function corsHeaders(request, allowed) {
  const origin = request.headers.get('Origin');
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '600'
  });
  if (origin && origin === allowed) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

function getToken(request, scheme) {
  const value = request.headers.get('Authorization') || '';
  const prefix = `${scheme} `;
  if (!value.startsWith(prefix)) return null;
  return value.slice(prefix.length).trim();
}

async function sha256Text(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function validateVaultPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.id !== 'primary' || payload.format !== 'sharecapsule-private-finance-v1') return false;
  if (typeof payload.ciphertext !== 'string' || typeof payload.iv !== 'string' || typeof payload.salt !== 'string') return false;
  if (typeof payload.updatedAt !== 'string') return false;
  return JSON.stringify(payload).length <= MAX_PAYLOAD_BYTES;
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_PAYLOAD_BYTES + 10000) throw new Error('Request is too large');
  return request.json();
}

async function authorizeVault(request, env, vaultId) {
  const token = getToken(request, 'Bearer');
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, status: 401 };
  const vault = await env.DB.prepare('SELECT vault_id, token_hash, revision, payload, updated_at, device_id FROM vaults WHERE vault_id = ?').bind(vaultId).first();
  if (!vault) return { ok: false, status: 404, token };
  const tokenHash = await sha256Text(token);
  if (!safeEqual(tokenHash, vault.token_hash)) return { ok: false, status: 403 };
  return { ok: true, token, vault };
}

function publicVault(vault) {
  return {
    revision: Number(vault.revision),
    payload: JSON.parse(vault.payload),
    updatedAt: vault.updated_at,
    deviceId: vault.device_id
  };
}

async function getVault(request, env, vaultId, headers) {
  const auth = await authorizeVault(request, env, vaultId);
  if (!auth.ok) return json({ error: auth.status === 404 ? 'Encrypted vault not found' : 'Unauthorized' }, auth.status, headers);
  return json(publicVault(auth.vault), 200, headers);
}

async function putVault(request, env, vaultId, headers) {
  const token = getToken(request, 'Bearer');
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return json({ error: 'Unauthorized' }, 401, headers);
  const body = await readJson(request);
  if (!validateVaultPayload(body.payload)) return json({ error: 'Invalid encrypted vault payload' }, 400, headers);
  if (!/^[A-Za-z0-9_-]{16}$/.test(String(body.deviceId || ''))) return json({ error: 'Invalid device identifier' }, 400, headers);

  const existing = await env.DB.prepare('SELECT vault_id, token_hash, revision, payload, updated_at, device_id FROM vaults WHERE vault_id = ?').bind(vaultId).first();
  const now = new Date().toISOString();

  if (!existing) {
    if (Number(body.baseRevision || 0) !== 0) return json({ error: 'Encrypted vault does not exist' }, 404, headers);
    const tokenHash = await sha256Text(token);
    await env.DB.prepare('INSERT INTO vaults (vault_id, token_hash, revision, payload, updated_at, device_id) VALUES (?, ?, 1, ?, ?, ?)')
      .bind(vaultId, tokenHash, JSON.stringify(body.payload), now, body.deviceId).run();
    return json({ revision: 1, updatedAt: now }, 201, headers);
  }

  const tokenHash = await sha256Text(token);
  if (!safeEqual(tokenHash, existing.token_hash)) return json({ error: 'Unauthorized' }, 403, headers);
  const currentRevision = Number(existing.revision);
  const baseRevision = Number(body.baseRevision || 0);
  if (!body.force && baseRevision !== currentRevision) return json({ error: 'Sync conflict', ...publicVault(existing) }, 409, headers);

  const nextRevision = currentRevision + 1;
  const result = await env.DB.prepare('UPDATE vaults SET revision = ?, payload = ?, updated_at = ?, device_id = ? WHERE vault_id = ? AND revision = ?')
    .bind(nextRevision, JSON.stringify(body.payload), now, body.deviceId, vaultId, currentRevision).run();

  if (!result.success || Number(result.meta?.changes || 0) !== 1) {
    const current = await env.DB.prepare('SELECT vault_id, token_hash, revision, payload, updated_at, device_id FROM vaults WHERE vault_id = ?').bind(vaultId).first();
    return json({ error: 'Sync conflict', ...publicVault(current) }, 409, headers);
  }
  return json({ revision: nextRevision, updatedAt: now }, 200, headers);
}

async function createPairing(request, env, vaultId, headers) {
  const auth = await authorizeVault(request, env, vaultId);
  if (!auth.ok) return json({ error: 'Unauthorized' }, auth.status, headers);
  const body = await readJson(request);
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(body.pairId || ''))) return json({ error: 'Invalid pairing identifier' }, 400, headers);
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(body.secretHash || ''))) return json({ error: 'Invalid pairing proof' }, 400, headers);
  if (typeof body.wrappedToken !== 'string' || body.wrappedToken.length > 256) return json({ error: 'Invalid wrapped token' }, 400, headers);
  if (!/^[A-Za-z0-9_-]{16}$/.test(String(body.wrapIv || ''))) return json({ error: 'Invalid wrapping IV' }, 400, headers);

  const now = Date.now();
  const expiresAt = now + PAIR_TTL_MS;
  await env.DB.prepare('DELETE FROM pairings WHERE expires_at < ?').bind(now).run();
  await env.DB.prepare('INSERT OR REPLACE INTO pairings (pair_id, vault_id, secret_hash, wrapped_token, wrap_iv, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(body.pairId, vaultId, body.secretHash, body.wrappedToken, body.wrapIv, expiresAt, now).run();
  return json({ pairId: body.pairId, expiresAt }, 201, headers);
}

async function claimPairing(request, env, vaultId, pairId, headers) {
  const secret = getToken(request, 'Pair');
  if (!secret || !/^[A-Za-z0-9_-]{22}$/.test(secret)) return json({ error: 'Invalid pairing authorization' }, 401, headers);
  const secretHash = await sha256Text(secret);
  const now = Date.now();

  const pair = await env.DB.prepare('DELETE FROM pairings WHERE pair_id = ? AND vault_id = ? AND secret_hash = ? AND expires_at >= ? RETURNING vault_id, wrapped_token, wrap_iv')
    .bind(pairId, vaultId, secretHash, now).first();
  if (!pair) return json({ error: 'Pairing expired, invalid, or already used' }, 410, headers);

  const vault = await env.DB.prepare('SELECT vault_id, revision, payload, updated_at, device_id FROM vaults WHERE vault_id = ?').bind(vaultId).first();
  if (!vault) return json({ error: 'Encrypted vault is no longer available' }, 404, headers);
  return json({ ...publicVault(vault), wrappedToken: pair.wrapped_token, wrapIv: pair.wrap_iv }, 200, headers);
}

async function deleteVault(request, env, vaultId, headers) {
  const auth = await authorizeVault(request, env, vaultId);
  if (!auth.ok) return json({ error: 'Unauthorized' }, auth.status, headers);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pairings WHERE vault_id = ?').bind(vaultId),
    env.DB.prepare('DELETE FROM vaults WHERE vault_id = ?').bind(vaultId)
  ]);
  return json({ deleted: true }, 200, headers);
}

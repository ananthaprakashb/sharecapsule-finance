CREATE TABLE IF NOT EXISTS vaults (
  vault_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pairings (
  pair_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  wrapped_token TEXT NOT NULL,
  wrap_iv TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pairings_vault ON pairings(vault_id);
CREATE INDEX IF NOT EXISTS idx_pairings_expiry ON pairings(expires_at);

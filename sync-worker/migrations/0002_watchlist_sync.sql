CREATE TABLE IF NOT EXISTS watchlists (
  watchlist_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist_pairings (
  pair_id TEXT PRIMARY KEY,
  watchlist_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  wrapped_token TEXT NOT NULL,
  token_wrap_iv TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  key_wrap_iv TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watchlist_pairings_watchlist ON watchlist_pairings(watchlist_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_pairings_expiry ON watchlist_pairings(expires_at);

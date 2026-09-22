-- DayFlow: one row per isolated store ID (opaque secret in URL/header).
CREATE TABLE stores (
  id TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_stores_updated ON stores(updated_at);

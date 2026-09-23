-- Phase 3 (post-refunds): audit log for configuration mutations.
--
-- Additive on purpose. The deployed Worker may already hold real sales and
-- refunds, so nothing is dropped or modified on existing tables.
--
-- THE CENTRAL IDEA: log every mutation to settings, items, and item images
-- with before/after JSON snapshots. This creates an immutable audit trail
-- for compliance (who changed GST rate/price/registration when) and
-- debugging. The table is append-only; no row is ever updated or deleted.
--
-- Why NOT trigger-based: D1 SQLite trigger support is unverified. A migration
-- that relies on triggers silently fails would leave no audit trail at all.
-- Better to add the logging explicitly in each write path where we already
-- have the before/after values.
--
-- Why NOT a separate side table: Adding a column to the main audit table
-- requires a table rewrite in older SQLite, but ADD COLUMN with constant
-- default is safe. The schema below uses only constant defaults, so it's
-- safe to apply to a database holding real money.
--
-- actor_id is nullable because user identity/RBAC (phase 5) is not yet
-- implemented. When that arrives, existing rows will have NULL actor_id,
-- and new rows will record the admin token's actor_id. The audit trail
-- still works: we know WHO (admin token), WHAT (mutation type), and WHEN.
--
-- JSON serialization is deliberate: flexible enough to hold any column set,
-- and SQLite handles TEXT naturally. A columnar audit table would need
-- ALTER TABLE per new field and still couldn't capture full row state.

-- ---------------------------------------------------------------------------
-- Audit log table. One row per mutation event.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NULL until phase 5 RBAC is implemented. When present, matches an actor
  -- table that doesn't exist yet.
  actor_id    TEXT,
  entity      TEXT    NOT NULL,
  -- The primary key value of the mutated row, as TEXT so it works for
  -- string keys (products.id) and integer keys (settings are implicit).
  entity_id   TEXT    NOT NULL,
  -- action: 'create' | 'update' | 'delete' | 'put' (settings upsert)
  action      TEXT    NOT NULL,
  -- Full row state BEFORE the mutation, as JSON. NULL for create (nothing
  -- existed). Stored as TEXT because SQLite has no JSON type, but the
  -- value is always valid JSON.
  before_json TEXT,
  -- Full row state AFTER the mutation, as JSON. For delete, this is the
  -- last known state. Stored as TEXT, always valid JSON.
  after_json  TEXT    NOT NULL
);

-- Index for common queries: audit a specific entity type, or audit a
-- specific entity by id.
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);

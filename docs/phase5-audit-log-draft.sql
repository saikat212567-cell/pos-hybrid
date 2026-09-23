-- Phase 3 (post-refunds): audit log for configuration mutations.
--
-- Additive on purpose. The deployed Worker may already hold real sales and
-- refunds, so nothing is dropped or modified on existing tables.
--
-- THE CENTRAL IDEA: log every mutation to settings, items, and item images
-- with before/after JSON snapshots. This creates an immutable audit trail
-- for compliance (what changed, when, and by whom once identity exists).
-- The table is append-only; no application path updates or deletes rows.
--
-- Why NOT trigger-based: D1 SQLite trigger support is unverified. A migration
-- that relies on triggers silently failing would leave no audit trail at all.
-- Better to add the logging explicitly in each write path where we already
-- have the before/after values.
--
-- SAFE AGAINST A LIVE DATABASE: this migration only CREATEs a new table and
-- its indexes. It does not ALTER, rewrite, or even read `sales`, `sale_lines`,
-- `stock_lots`, `cogs_allocations`, `vouchers` or `voucher_lines`. The money
-- tables are untouched, so there is no copy-and-rename step and nothing to
-- lose if the migration is interrupted half way: either audit_log exists or
-- it does not, and the POS sells correctly in both cases.
--
-- actor_id is nullable because user identity (phase 5 RBAC) does not exist
-- yet. Until it does, every row is written with actor_id NULL and this table
-- answers WHAT changed and WHEN, but NOT WHO — a request authenticated by a
-- single shared admin token carries no identity to record. That is the known
-- ceiling, and it is why this migration is worth applying before phase 5
-- rather than with it: the before/after history cannot be reconstructed
-- retrospectively, whereas actor_id can be populated from the day identity
-- lands. Do not read a NULL actor_id as "unknown user"; read it as
-- "pre-identity".
--
-- JSON serialization is deliberate: flexible enough to hold any column set,
-- and SQLite handles TEXT naturally. A columnar audit table would need
-- ALTER TABLE per new field and still could not capture full row state.

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_id    TEXT,
  entity      TEXT    NOT NULL,
  entity_id   TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  -- NULL only for create, when no previous row existed.
  before_json TEXT,
  -- Full row state after create/update/deactivate/image upload.
  after_json  TEXT    NOT NULL
);

-- Timeline for one object; global chronological views use the second index.
CREATE INDEX IF NOT EXISTS audit_log_entity_idx
  ON audit_log (entity, entity_id, id);
CREATE INDEX IF NOT EXISTS audit_log_at_idx
  ON audit_log (at DESC, id DESC);

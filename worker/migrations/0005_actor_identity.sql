-- worker/migrations/0005_actor_identity.sql
-- Phase 3 seam: actor identity and business date for audit trail and offline sales
--
-- actor_identity: who did this? The device or user that created the document.
-- Required for MCA 2023 audit trail (Rule 3(2) of Companies (Meetings of Board
-- and its Powers) Rules, 2014 — all entries must show "Dy. Manager / Clerk who
-- has attended the transaction".
--
-- business_date_document: the calendar date the transaction actually occurred,
-- not when it was synced to the server. An offline till might sell at 11pm and
-- sync at 8am next day — the GST period, the invoice series and the books must
-- all reflect 11pm's date, not 8am's.
--
-- Both columns allow NULL for historical rows that predate this migration.

-- ---------------------------------------------------------------------------
-- Sales: add actor and business date
-- ---------------------------------------------------------------------------
ALTER TABLE sales ADD COLUMN actor_id       TEXT;
ALTER TABLE sales ADD COLUMN business_date TEXT;

-- ---------------------------------------------------------------------------
-- Purchases: add actor and business date
-- ---------------------------------------------------------------------------
ALTER TABLE purchases ADD COLUMN actor_id       TEXT;
ALTER TABLE purchases ADD COLUMN business_date TEXT;

-- ---------------------------------------------------------------------------
-- Credit notes: add actor and business date (credit notes already exist via 0004)
-- ---------------------------------------------------------------------------
ALTER TABLE credit_notes ADD COLUMN actor_id       TEXT;
ALTER TABLE credit_notes ADD COLUMN business_date TEXT;

-- ---------------------------------------------------------------------------
-- Indexes for audit queries (actor_id is high-selectivity, business_date is
-- range‑selective; compound index supports the most common query: "show all
-- documents by this actor on this date")
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS sales_actor_date_idx       ON sales (actor_id, business_date);
CREATE INDEX IF NOT EXISTS purchases_actor_date_idx   ON purchases (actor_id, business_date);
CREATE INDEX IF NOT EXISTS credit_notes_actor_date_idx ON credit_notes (actor_id, business_date);

-- ---------------------------------------------------------------------------
-- No migration of historical data: NULL means "unknown actor" and the column
-- is optional in the API, so existing documents keep working unchanged.
-- ---------------------------------------------------------------------------
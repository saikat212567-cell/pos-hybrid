-- worker/migrations/0004_refunds.sql
-- Phase 3: credit notes, refunds, stock return. Additive, like 0002 and 0003.
--
-- THE CENTRAL IDEA: a sale line and a cogs_allocation are each a "lot" of
-- returnable value. stock_lots already proved the pattern in 0002 — store what
-- REMAINS, never a unit rate, and let the last unit out take the remainder.
-- Applying the same pattern one level up is what makes a return restore a lot
-- to its exact pre-sale state, in integers, with no paisa invented or stranded.
--
-- The counters count DOWN with CHECK (>= 0), deliberately mirroring
-- stock_lots.qty_remaining. Unguarded subtraction plus a CHECK is the
-- concurrency control (see the long comment in fifo.js): two tills refunding
-- the same sale both pass the application-level check, the loser drives a
-- counter negative, the CHECK fires, and the WHOLE batch rolls back. A
-- `WHERE qty_returnable >= ?` guard would be worse — the UPDATE would match no
-- rows and succeed silently, refunding cash against nothing.

-- ---------------------------------------------------------------------------
-- What is still returnable, per sale line.
--
-- Seeded from the sale's own stored figures, never recomputed from price and
-- rate. That is what makes a credit note immune to everything that can change
-- after a sale: the item renamed, repriced, moved from inclusive to exclusive
-- pricing, its GST slab revised, the shop switching registration type. The
-- credit note can only ever give back numbers the invoice actually stated.
--
-- Five counters, not one, because each must be bounded independently. Bounding
-- only qty and deriving tax by SUM() lets two concurrent 1-of-2 returns both
-- read cgst_returnable = 1501 and both take divRound(1501,2) = 751, reversing
-- 1502 paise of a tax that was only ever 1501. A paisa of output tax invented
-- from nothing, and the trial balance still nets to zero.
-- ---------------------------------------------------------------------------
ALTER TABLE sale_lines ADD COLUMN qty_returnable           INTEGER NOT NULL DEFAULT 0 CHECK (qty_returnable >= 0);
ALTER TABLE sale_lines ADD COLUMN taxable_returnable_paise INTEGER NOT NULL DEFAULT 0 CHECK (taxable_returnable_paise >= 0);
ALTER TABLE sale_lines ADD COLUMN cgst_returnable_paise    INTEGER NOT NULL DEFAULT 0 CHECK (cgst_returnable_paise >= 0);
ALTER TABLE sale_lines ADD COLUMN sgst_returnable_paise    INTEGER NOT NULL DEFAULT 0 CHECK (sgst_returnable_paise >= 0);
ALTER TABLE sale_lines ADD COLUMN igst_returnable_paise    INTEGER NOT NULL DEFAULT 0 CHECK (igst_returnable_paise >= 0);

-- ADD COLUMN takes a constant default, so historical rows are backfilled here.
-- Every past sale becomes fully returnable, which is the correct default: a
-- genuine return of old goods must be possible. Note this seeds from the
-- _paise columns, not the legacy `total`, so a sale recorded by an old client
-- with total_mismatch = 1 is refundable consistently with the BOOKS rather
-- than with the figure that client believed.
UPDATE sale_lines SET
  qty_returnable           = qty,
  taxable_returnable_paise = taxable_paise,
  cgst_returnable_paise    = cgst_paise,
  sgst_returnable_paise    = sgst_paise,
  igst_returnable_paise    = igst_paise;

-- ---------------------------------------------------------------------------
-- What is still returnable, per allocation — i.e. per (sale line, lot) pair.
--
-- This is the source of truth the whole design turns on. cogs_allocations
-- already records which lot each sold unit came from and the exact paise taken
-- from that lot. Decrementing a copy of those two numbers, with the same
-- remainder rule, is what makes N partial returns restore the lot's cost
-- EXACTLY, not approximately: 1000 paise over three single-unit returns comes
-- back as 333 + 334 + 333, never 3 x 333 with a paisa left behind.
--
-- The original qty and cost_paise columns are never touched. They are the
-- audit record of the sale and must stay immutable.
-- ---------------------------------------------------------------------------
ALTER TABLE cogs_allocations ADD COLUMN qty_returnable        INTEGER NOT NULL DEFAULT 0 CHECK (qty_returnable >= 0);
ALTER TABLE cogs_allocations ADD COLUMN cost_returnable_paise INTEGER NOT NULL DEFAULT 0 CHECK (cost_returnable_paise >= 0);

UPDATE cogs_allocations SET qty_returnable = qty, cost_returnable_paise = cost_paise;

-- ---------------------------------------------------------------------------
-- Credit note header.
--
-- All money is a POSITIVE MAGNITUDE. A credit note is conventionally printed
-- with positive figures under a "CREDIT NOTE" heading, and bill.js is built for
-- that: amountInWords() returns '' for a negative (bill.js:110), and
-- buildVoucher() rejects negative lines outright (ledger.js:60) precisely
-- because two negatives on opposite sides cancel and pass the balance check
-- while posting the wrong total. Storing a refund as a negative sale would
-- fight both.
--
-- Column names match `sales` wherever the meaning matches, so billHtml() can
-- render this row with no data massaging.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_notes (
  -- Device-generated, exactly like sales.client_ref. This is the whole of the
  -- idempotency story: an offline retry collides here and cannot refund twice.
  client_ref            TEXT    PRIMARY KEY,
  source                TEXT    NOT NULL DEFAULT 'web',

  -- CN/26-27/0001. Assigned server-side from invoice_series, so it is gapless
  -- per device and per financial year. Rule 53(1A)(c): <= 16 chars, alphabets,
  -- numerals, '-' and '/' only, consecutive, unique within the FY.
  note_no               TEXT,
  note_date             TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Rule 53(1A)(g): a credit note must carry the serial number AND date of the
  -- invoice (or bill of supply) it corrects. One sale per note — see
  -- credit_note_lines for why consolidation across invoices is out of scope.
  sale_ref              TEXT    NOT NULL REFERENCES sales(client_ref),
  -- Copied, not joined, for the same reason sale_lines.name is copied: the
  -- document must still read correctly years later.
  original_invoice_no   TEXT,
  original_invoice_date TEXT    NOT NULL,

  -- return | deficient | price_correction. 'deficient' is the s.34(1) limb that
  -- covers services, where nothing is physically returned.
  reason                TEXT    NOT NULL DEFAULT 'return',

  -- Snapshot of gst_registration AT THE TIME OF THE NOTE. A shop that moves
  -- from composition to regular must not retrospectively turn its old
  -- bills-of-supply credit notes into tax invoices.
  registration          TEXT    NOT NULL,
  place_of_supply       TEXT,
  customer_gstin        TEXT,
  -- Also a snapshot: this, not a mutable customer row, decides the GSTR-1
  -- bucket. Re-deriving it at return-filing time would move a note between
  -- tables months after it was filed.
  customer_registered   INTEGER NOT NULL DEFAULT 0,

  taxable_paise         INTEGER NOT NULL DEFAULT 0 CHECK (taxable_paise      >= 0),
  cgst_paise            INTEGER NOT NULL DEFAULT 0 CHECK (cgst_paise         >= 0),
  sgst_paise            INTEGER NOT NULL DEFAULT 0 CHECK (sgst_paise         >= 0),
  igst_paise            INTEGER NOT NULL DEFAULT 0 CHECK (igst_paise         >= 0),
  -- Signed: a credit note can round either way, same as a sale.
  round_off_paise       INTEGER NOT NULL DEFAULT 0,
  -- What is actually handed back, after rounding. Authoritative.
  total_paise           INTEGER NOT NULL DEFAULT 0 CHECK (total_paise        >= 0),
  -- Sum of cost put back into lots (or written off). Zero for a services-only
  -- note and for a pure price correction.
  cogs_reversed_paise   INTEGER NOT NULL DEFAULT 0 CHECK (cogs_reversed_paise >= 0),

  -- original_lot | new_lot | none. Stored per note, not read from settings at
  -- report time: the setting is only the DEFAULT, and "these ones came back
  -- damaged" is a fact about one transaction.
  stock_return_mode     TEXT    NOT NULL,

  -- 1 = output tax reversed (s.34(2) window open). 0 = financial/commercial
  -- credit note: value reversed in the books, NO GST reversed, not reported in
  -- GSTR-1. Decided from the ORIGINAL SUPPLY DATE, never the note date.
  tax_adjusted          INTEGER NOT NULL DEFAULT 1,

  -- cdnr | cdnur_b2cl | b2cs_net | none. Computed and frozen at issue.
  gstr1_table           TEXT    NOT NULL DEFAULT 'none',

  -- How the money goes back. Frequently NOT the sale's payment_mode: a card
  -- sale is routinely refunded in cash at a small counter.
  refund_mode           TEXT    NOT NULL DEFAULT 'cash'
);

-- Same partial-unique shape as sales_invoice_no_idx: a GST document number is
-- unique, and NULL is permitted so a row can exist before numbering.
CREATE UNIQUE INDEX IF NOT EXISTS credit_notes_note_no_idx
  ON credit_notes (note_no) WHERE note_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS credit_notes_sale_idx ON credit_notes (sale_ref);
CREATE INDEX IF NOT EXISTS credit_notes_date_idx ON credit_notes (note_date DESC);

-- ---------------------------------------------------------------------------
-- Credit note lines. Mirrors sale_lines so rateWise() and billHtml() work
-- unchanged, with ONE deliberate divergence:
--
--   qty CHECK (qty >= 0), not (qty > 0).
--
-- A partly-deficient service has no quantity to give back. GST has no concept
-- of un-consuming a service; the only lever is value reduction. Borrowing
-- sale_lines' qty > 0 would make the commonest service credit note
-- inexpressible, so qty = 0 with a positive taxable_paise is a first-class
-- shape here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_note_lines (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  note_ref            TEXT    NOT NULL REFERENCES credit_notes(client_ref),
  -- The line being credited. Not just product_id: this is what the returnable
  -- counters hang off, and what makes the credit provably traceable to one
  -- invoice line.
  sale_line_id        INTEGER NOT NULL REFERENCES sale_lines(id),
  product_id          TEXT    NOT NULL REFERENCES products(id),
  name                TEXT    NOT NULL,
  -- Drives which income account is debited (4000 vs 4100) and whether stock
  -- moves at all. The goods/services branch has to reach the return path too.
  kind                TEXT    NOT NULL DEFAULT 'good',
  -- HSN for goods, SAC for services, copied from the sale line: a credit note
  -- must carry the same code as the invoice it corrects.
  tax_code            TEXT    NOT NULL DEFAULT '',
  unit                TEXT    NOT NULL DEFAULT 'PCS',
  qty                 INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  price_paise         INTEGER NOT NULL DEFAULT 0 CHECK (price_paise >= 0),
  gst_rate_bps        INTEGER NOT NULL DEFAULT 0,
  taxable_paise       INTEGER NOT NULL DEFAULT 0 CHECK (taxable_paise >= 0),
  cgst_paise          INTEGER NOT NULL DEFAULT 0 CHECK (cgst_paise    >= 0),
  sgst_paise          INTEGER NOT NULL DEFAULT 0 CHECK (sgst_paise    >= 0),
  igst_paise          INTEGER NOT NULL DEFAULT 0 CHECK (igst_paise    >= 0),
  cogs_reversed_paise INTEGER NOT NULL DEFAULT 0 CHECK (cogs_reversed_paise >= 0)
);

-- D1's batch() returns nothing to thread ids between statements, so
-- return_allocations has to find its parent line by sub-select. This index is
-- what makes (note_ref, sale_line_id) a legitimate key for that — the same
-- trick recordSale relies on with (sale_ref, product_id), and the reason a
-- consolidated multi-invoice credit note is out of scope for now.
CREATE UNIQUE INDEX IF NOT EXISTS credit_note_lines_key_idx
  ON credit_note_lines (note_ref, sale_line_id);
CREATE INDEX IF NOT EXISTS credit_note_lines_note_idx
  ON credit_note_lines (note_ref);

-- ---------------------------------------------------------------------------
-- Where the cost went back to. The exact mirror of cogs_allocations, and the
-- reason the restoration is auditable rather than merely asserted: for any lot
-- you can prove cost_in = SUM(taken) - SUM(given back) + cost_remaining.
--
-- lot_id is NULLABLE, for stock_return_mode = 'none': the cost was released
-- from the allocation but went to an expense account, not to a lot. Recording
-- the row anyway is what stops a second credit note from later "returning" the
-- same units to stock.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS return_allocations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_note_line_id INTEGER NOT NULL REFERENCES credit_note_lines(id),
  cogs_allocation_id  INTEGER NOT NULL REFERENCES cogs_allocations(id),
  lot_id              INTEGER REFERENCES stock_lots(id),
  qty                 INTEGER NOT NULL CHECK (qty > 0),
  cost_paise          INTEGER NOT NULL CHECK (cost_paise >= 0),
  -- original_lot | new_lot | none. Per allocation, because a single note can
  -- in principle restore some lines and write off others.
  mode                TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS return_allocations_line_idx
  ON return_allocations (credit_note_line_id);
CREATE INDEX IF NOT EXISTS return_allocations_alloc_idx
  ON return_allocations (cogs_allocation_id);

-- ---------------------------------------------------------------------------
-- Two new accounts.
--
-- 5100 exists because stock_return_mode = 'none' has nowhere to put the cost.
-- The sale already did Dr COGS / Cr Stock. The goods came back and were
-- scrapped, so there is no longer a sale for that cost to be matched against:
-- it must leave COGS and be recognised as a loss. Leaving it in COGS would
-- silently overstate cost of sales and hide breakage from the P&L.
--
-- 5910 exists because a time-barred (financial) credit note refunds the
-- customer the GST but cannot recover it from the government. That tax becomes
-- a cost of the business. Without this account the reversing voucher for a
-- financial credit note simply cannot balance, and buildVoucher would throw.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO accounts (code, name, type) VALUES
  ('5100', 'Goods Written Off',   'expense'),
  ('5910', 'GST Not Recoverable', 'expense');

-- ---------------------------------------------------------------------------
-- Settings. Nothing about tax, dates or thresholds is hardcoded (invariant 10).
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO settings (key, value) VALUES
  -- Its own consecutive series, separate from invoice_series. GSTR-1 Table 13
  -- wants a contiguous from-to range PER DOCUMENT TYPE, which is unachievable
  -- on a shared counter. One series per device, like invoice_series, so an
  -- offline till can number its own credit notes.
  -- Budget check: 'CN' + '/' + '26-27' + '/' + '0001' = 13 of the 16 allowed.
  ('credit_note_series',      'CN'),

  -- original_lot | new_lot | none. The DEFAULT for this shop; a single note may
  -- override it (damaged goods are a per-transaction fact). See stock modes.
  ('stock_return_mode',       'original_lot'),

  -- B2C Large threshold for the GSTR-1 CDNUR bucket. A rupee figure set by
  -- notification, so it is a setting, not a constant in the code.
  ('b2cl_threshold_paise',    '25000000'),

  -- Last date for adjusting tax via a credit note, as MM-DD following the end
  -- of the FY of supply. Finance Act 2022 moved this from 09-30 to 11-30
  -- effective 1 Oct 2022 — a value that has already changed once and can
  -- change again has no business being a literal in the source.
  ('credit_note_cutoff_mmdd', '11-30');

-- An earlier cutoff applies if the annual return was filed before the MM-DD
-- date. Recorded per FY as an optional key, read only if present:
--   INSERT INTO settings VALUES ('gstr9_filed_24-25', '2025-10-15');
-- No migration needed to add one, which is the point of a key-value settings
-- table.

-- ---------------------------------------------------------------------------
-- One matching change in worker/src/index.js recordSale(): the sale_lines
-- INSERT must seed the new counters, or nothing sold from now on is
-- returnable.
--
--   INSERT INTO sale_lines
--     (..., taxable_paise, cgst_paise, sgst_paise, igst_paise, cogs_paise,
--      qty_returnable, taxable_returnable_paise, cgst_returnable_paise,
--      sgst_returnable_paise, igst_returnable_paise)
--   VALUES (..., ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?)
--
-- and the cogs_allocations INSERT likewise:
--
--   INSERT INTO cogs_allocations
--     (sale_line_id, lot_id, qty, cost_paise, qty_returnable, cost_returnable_paise)
--   VALUES ((SELECT id FROM sale_lines WHERE sale_ref = ? AND product_id = ?),
--           ?, ?, ?, ?, ?)
--
-- binding the same value twice in each case. Duplicating the value rather than
-- deriving it keeps the counter a plain column with a single-column CHECK,
-- which is what makes the >= 0 guard bulletproof.
-- ---------------------------------------------------------------------------
-- deriving it keeps the counter a plain column with a single-column CHECK,
-- which is what makes the >= 0 guard bulletproof.
-- ---------------------------------------------------------------------------

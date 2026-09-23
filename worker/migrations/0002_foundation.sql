-- Phase 1 foundation: FIFO stock lots, GST, double-entry books.
--
-- Additive on purpose. The deployed Worker may already hold real sales, so
-- nothing is dropped: `products.stock` and `sales.items` stay in place and
-- stop being the source of truth rather than disappearing.
--
-- MONEY IS INTEGER PAISE. The pre-existing columns say "cents" and are
-- already integers of 1/100 of the currency unit, so this is a change of
-- vocabulary, not of data. New columns are named `_paise` so the unit is
-- impossible to misread.

-- ---------------------------------------------------------------------------
-- Settings: key-value so a new knob is an INSERT, not a migration.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  -- regular | composition | unregistered. Drives the whole tax engine.
  ('gst_registration',    'regular'),
  ('gstin',               ''),
  -- Seller's state, as the 2-digit GST state code. 19 = West Bengal.
  -- Compared against the buyer's place of supply to pick CGST+SGST vs IGST.
  ('state_code',          '19'),
  ('legal_name',          ''),
  -- inclusive = the price typed is what the customer pays (Indian retail MRP).
  -- exclusive = tax is added on top (B2B/wholesale). Per-item override wins.
  ('price_mode',          'inclusive'),
  -- Financial year start, MM-DD. April 1 in India.
  ('fy_start',            '04-01'),
  ('invoice_series',      'A'),
  -- Flat turnover rate for composition dealers, in basis points. 100 = 1%.
  ('composition_rate_bps','100'),
  -- Round the invoice to the nearest rupee, posting the difference to Round Off.
  ('round_off_enabled',   '1');

-- ---------------------------------------------------------------------------
-- Items. Still called `products` — renaming it buys nothing and would churn
-- the client-facing /products route for no gain.
--
-- A service is NOT a good with zero stock: it has no lot to consume, no cost
-- of goods, a SAC rather than an HSN, and its revenue belongs in a different
-- account. `kind` is what those three branches read.
-- ---------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN kind         TEXT    NOT NULL DEFAULT 'good';
-- HSN for goods, SAC for services. One column: an item has exactly one of
-- them and never both.
ALTER TABLE products ADD COLUMN tax_code     TEXT    NOT NULL DEFAULT '';
-- GST rate in basis points (1800 = 18%). Integers so a rate can never arrive
-- as 0.17999999999999999.
ALTER TABLE products ADD COLUMN gst_rate_bps INTEGER NOT NULL DEFAULT 0;
-- Unit Quantity Code as GST returns expect it. 'NA' for services.
ALTER TABLE products ADD COLUMN unit         TEXT    NOT NULL DEFAULT 'PCS';
-- NULL = follow the `price_mode` setting. Set per item to mix retail and
-- wholesale pricing in one catalog.
ALTER TABLE products ADD COLUMN price_mode   TEXT;
ALTER TABLE products ADD COLUMN barcode      TEXT;
ALTER TABLE products ADD COLUMN is_active    INTEGER NOT NULL DEFAULT 1;

-- Scanning a barcode has to be instant at a counter, so it gets an index
-- rather than a table scan. Partial: unbarcoded items don't belong in it.
CREATE INDEX IF NOT EXISTS products_barcode_idx
  ON products (barcode) WHERE barcode IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Stock lots — the FIFO queue itself.
--
-- A lot stores COST REMAINING, not unit cost. Buy 3 for 1000 paise and the
-- unit cost is 333.33 paise, which no integer column can hold: rounding it
-- leaks a paisa per unit and the lot never empties. Instead, taking q of n
-- remaining costs round(cost_remaining * q / n), and the last unit takes
-- whatever is left. Total COGS then always equals total purchase cost exactly.
--
-- Services never get a row here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_lots (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id           TEXT    NOT NULL REFERENCES products(id),
  qty_in               INTEGER NOT NULL CHECK (qty_in > 0),
  qty_remaining        INTEGER NOT NULL CHECK (qty_remaining >= 0),
  cost_in_paise        INTEGER NOT NULL CHECK (cost_in_paise >= 0),
  cost_remaining_paise INTEGER NOT NULL CHECK (cost_remaining_paise >= 0),
  received_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NULL means opening stock rather than a recorded purchase.
  purchase_line_id     INTEGER REFERENCES purchase_lines(id)
);

-- This ordering IS the FIFO queue. id breaks ties so two lots received in the
-- same second still consume deterministically.
CREATE INDEX IF NOT EXISTS stock_lots_fifo_idx
  ON stock_lots (product_id, received_at, id);

-- ---------------------------------------------------------------------------
-- Purchases. One purchase line creates exactly one lot.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchases (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_name    TEXT    NOT NULL DEFAULT '',
  supplier_gstin   TEXT,
  -- The supplier's own invoice number, not ours.
  supplier_inv_no  TEXT,
  invoice_date     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  taxable_paise    INTEGER NOT NULL DEFAULT 0,
  cgst_paise       INTEGER NOT NULL DEFAULT 0,
  sgst_paise       INTEGER NOT NULL DEFAULT 0,
  igst_paise       INTEGER NOT NULL DEFAULT 0,
  total_paise      INTEGER NOT NULL DEFAULT 0,
  -- cash | bank | credit. credit posts to Sundry Creditors instead of paying.
  payment_mode     TEXT    NOT NULL DEFAULT 'cash',
  voucher_id       INTEGER REFERENCES vouchers(id)
);

CREATE TABLE IF NOT EXISTS purchase_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id   INTEGER NOT NULL REFERENCES purchases(id),
  product_id    TEXT    NOT NULL REFERENCES products(id),
  qty           INTEGER NOT NULL CHECK (qty > 0),
  -- Cost of the whole line excluding GST. Input GST is creditable, so it is
  -- never part of inventory cost.
  taxable_paise INTEGER NOT NULL CHECK (taxable_paise >= 0),
  gst_rate_bps  INTEGER NOT NULL DEFAULT 0,
  tax_paise     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS purchase_lines_purchase_idx
  ON purchase_lines (purchase_id);

-- ---------------------------------------------------------------------------
-- Sales.
--
-- `total` keeps holding exactly what the client sent, so /sales history and
-- the two shipped clients are unaffected. The server's own computed figures
-- live in the _paise columns beside it and are what the books use. When the
-- two disagree — an old client applying its hardcoded 5% — `total_mismatch`
-- records that rather than hiding it.
-- ---------------------------------------------------------------------------
ALTER TABLE sales ADD COLUMN invoice_no        TEXT;
ALTER TABLE sales ADD COLUMN taxable_paise     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN cgst_paise        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN sgst_paise        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN igst_paise        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN round_off_paise   INTEGER NOT NULL DEFAULT 0;
-- What the customer actually pays, after rounding. Authoritative.
ALTER TABLE sales ADD COLUMN total_paise       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN cogs_paise        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN total_mismatch    INTEGER NOT NULL DEFAULT 0;
-- Buyer's state code. Equal to ours -> CGST+SGST; different -> IGST.
ALTER TABLE sales ADD COLUMN place_of_supply   TEXT;
ALTER TABLE sales ADD COLUMN customer_gstin    TEXT;
ALTER TABLE sales ADD COLUMN payment_mode      TEXT    NOT NULL DEFAULT 'cash';
ALTER TABLE sales ADD COLUMN voucher_id        INTEGER REFERENCES vouchers(id);

-- A GST invoice number must be unique within a series; the partial index
-- enforces it while letting legacy rows keep a NULL.
CREATE UNIQUE INDEX IF NOT EXISTS sales_invoice_no_idx
  ON sales (invoice_no) WHERE invoice_no IS NOT NULL;

-- Line items as rows. The JSON blob in sales.items stays for the old clients
-- but stops being what reports read: you cannot group a blob by HSN.
CREATE TABLE IF NOT EXISTS sale_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_ref      TEXT    NOT NULL REFERENCES sales(client_ref),
  product_id    TEXT    NOT NULL REFERENCES products(id),
  -- Copied, not joined: an invoice must still read correctly years later
  -- after the item has been renamed, repriced or reclassified.
  name          TEXT    NOT NULL,
  kind          TEXT    NOT NULL DEFAULT 'good',
  tax_code      TEXT    NOT NULL DEFAULT '',
  unit          TEXT    NOT NULL DEFAULT 'PCS',
  qty           INTEGER NOT NULL CHECK (qty > 0),
  -- Unit price as entered, in the item's own price mode.
  price_paise   INTEGER NOT NULL CHECK (price_paise >= 0),
  gst_rate_bps  INTEGER NOT NULL DEFAULT 0,
  taxable_paise INTEGER NOT NULL DEFAULT 0,
  cgst_paise    INTEGER NOT NULL DEFAULT 0,
  sgst_paise    INTEGER NOT NULL DEFAULT 0,
  igst_paise    INTEGER NOT NULL DEFAULT 0,
  cogs_paise    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS sale_lines_sale_idx ON sale_lines (sale_ref);

-- Which lot each line drew from, how many, at what cost. Without this, FIFO
-- is a claim; with it, closing stock value and COGS are provable to an auditor.
CREATE TABLE IF NOT EXISTS cogs_allocations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_line_id INTEGER NOT NULL REFERENCES sale_lines(id),
  lot_id       INTEGER NOT NULL REFERENCES stock_lots(id),
  qty          INTEGER NOT NULL CHECK (qty > 0),
  cost_paise   INTEGER NOT NULL CHECK (cost_paise >= 0)
);

CREATE INDEX IF NOT EXISTS cogs_allocations_line_idx
  ON cogs_allocations (sale_line_id);

-- ---------------------------------------------------------------------------
-- Double-entry ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  -- asset | liability | equity | income | expense
  type        TEXT NOT NULL,
  parent_code TEXT REFERENCES accounts(code)
);

CREATE TABLE IF NOT EXISTS vouchers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  -- sale | purchase | payment | receipt | journal
  type      TEXT NOT NULL,
  date      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  narration TEXT NOT NULL DEFAULT '',
  -- Back-reference to what caused this entry, e.g. a sale's client_ref.
  ref       TEXT
);

-- One voucher must reference one source document at most once. This is what
-- stops an offline retry from posting the same sale to the books twice.
CREATE UNIQUE INDEX IF NOT EXISTS vouchers_ref_idx
  ON vouchers (type, ref) WHERE ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS voucher_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id   INTEGER NOT NULL REFERENCES vouchers(id),
  account_code TEXT    NOT NULL REFERENCES accounts(code),
  debit_paise  INTEGER NOT NULL DEFAULT 0 CHECK (debit_paise  >= 0),
  credit_paise INTEGER NOT NULL DEFAULT 0 CHECK (credit_paise >= 0),
  -- A line is one side or the other, never both and never neither. Catches a
  -- malformed entry at the database rather than in a report months later.
  CHECK ((debit_paise = 0) <> (credit_paise = 0))
);

CREATE INDEX IF NOT EXISTS voucher_lines_voucher_idx
  ON voucher_lines (voucher_id);
CREATE INDEX IF NOT EXISTS voucher_lines_account_idx
  ON voucher_lines (account_code);

-- Chart of accounts. Names follow Indian convention (Sundry Debtors rather
-- than Accounts Receivable) so the output reads like the books a local
-- accountant expects.
INSERT OR IGNORE INTO accounts (code, name, type) VALUES
  ('1000', 'Cash in Hand',      'asset'),
  ('1010', 'Bank Account',      'asset'),
  ('1100', 'Sundry Debtors',    'asset'),
  ('1200', 'Stock in Hand',     'asset'),
  -- Input GST is a receivable from the government, not a cost.
  ('1300', 'Input CGST',        'asset'),
  ('1310', 'Input SGST',        'asset'),
  ('1320', 'Input IGST',        'asset'),
  ('2000', 'Sundry Creditors',  'liability'),
  -- Output GST is collected on the government's behalf: a liability, never income.
  ('2100', 'Output CGST',       'liability'),
  ('2110', 'Output SGST',       'liability'),
  ('2120', 'Output IGST',       'liability'),
  ('3000', 'Capital Account',   'equity'),
  ('4000', 'Sales',             'income'),
  -- Separate from Sales so the P&L shows goods and service revenue apart.
  ('4100', 'Service Income',    'income'),
  ('5000', 'Cost of Goods Sold','expense'),
  ('5900', 'Round Off',         'expense');

-- ---------------------------------------------------------------------------
-- Invoice numbering. A GST invoice number must be consecutive within its
-- series and at most 16 characters. Multiple series are permitted, which is
-- what lets an offline till number its own bills: one series per device.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_series (
  series  TEXT    NOT NULL,
  -- Financial year label, e.g. '26-27'.
  fy      TEXT    NOT NULL,
  last_no INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (series, fy)
);

-- ---------------------------------------------------------------------------
-- Backfill.
--
-- Existing catalog rows predate GST fields. Give the seeded demo items
-- plausible Indian rates and codes so the engine has something real to chew
-- on, and add two services so a mixed invoice is testable out of the box.
-- ---------------------------------------------------------------------------
UPDATE products SET gst_rate_bps = 500,  tax_code = '2106', unit = 'PCS'
  WHERE category IN ('bakery', 'food') AND gst_rate_bps = 0;
UPDATE products SET gst_rate_bps = 1800, tax_code = '2202', unit = 'PCS'
  WHERE category = 'drinks' AND gst_rate_bps = 0;

INSERT OR IGNORE INTO products
  (id, name, price, stock, category, kind, tax_code, gst_rate_bps, unit) VALUES
  -- Services: no stock, SAC not HSN, 18%.
  ('delivery', 'Home Delivery', 4000, 0, 'services', 'service', '996813', 1800, 'NA'),
  ('catering', 'Catering Service', 250000, 0, 'services', 'service', '996334', 1800, 'NA');

-- Turn the old flat `stock` integer into opening lots so FIFO has a queue to
-- consume and the derived stock figure matches what it was before.
--
-- Cost is 0: the old schema never recorded what this stock cost, and inventing
-- a number would put a fiction into the books. Consequence: goods sold out of
-- opening stock show zero COGS and therefore inflated margin, until real
-- purchases replace them. Recording the truth we have beats fabricating the
-- rest.
INSERT INTO stock_lots
  (product_id, qty_in, qty_remaining, cost_in_paise, cost_remaining_paise, received_at)
SELECT id, stock, stock, 0, 0, '1970-01-01 00:00:00'
  FROM products
 WHERE kind = 'good'
   AND stock > 0
   AND id NOT IN (SELECT product_id FROM stock_lots);

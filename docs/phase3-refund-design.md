# Phase 3 design — refunds and credit notes

Raw output of a 3-design / 3-judge workflow run 2026-09-23. The
allocation-rewind design won on all three lenses (correctness 8/10,
compliance 8/10, fit 7–8/10). Kept verbatim so the reasoning is not lost.

The three GSTR/reports/client specs that were to follow failed on transient
API errors (503/502) and were never produced — they still need writing.

---

## Winning design

**Allocation-rewind: cogs_allocations as the source of truth, with returnable counters that count down like a lot does**

A return walks the sale line's `cogs_allocations` in reverse consumption order and puts back exactly the paise that came out of each lot, using the same "last unit takes the remainder" rule that `planConsume` uses to take it out. The credit note document and the reversing voucher are then just reports of that restoration, not independent calculations. Over-return is prevented the same way oversell already is: `*_returnable` counters that count DOWN with `CHECK (>= 0)`, so a concurrent or excessive refund fails the batch and rolls everything back.

## Schema

```sql
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
```

## Stock return modes — the setting

### `original_lot  (DEFAULT for general retail)`

**Behaviour.** Walk the sale line's cogs_allocations in REVERSE consumption order (ORDER BY id DESC, skipping rows with qty_returnable = 0) and put qty and cost back into the very lots they came from. Per allocation: take = min(need, qty_returnable), and cost = (take === qty_returnable) ? cost_returnable_paise : divRound(cost_returnable_paise * take, qty_returnable) — the identical rule fifo.js:79 uses to take it out, so the last unit back carries the remainder. Two statements per allocation: UPDATE stock_lots SET qty_remaining = qty_remaining + ?, cost_remaining_paise = cost_remaining_paise + ? WHERE id = ?, and UPDATE cogs_allocations SET qty_returnable = qty_returnable - ?, cost_returnable_paise = cost_returnable_paise - ? WHERE id = ?. A drained lot (0 qty, 0 cost) is revived; its received_at is untouched, so the returned goods re-enter at the head of the FIFO queue — correct, because they ARE the oldest stock. Reverse order is chosen because it is the exact inverse of the consumption operation, and because the youngest lot the sale touched is the one most likely to still be open, so ordinary partial returns rarely need to revive a retired lot at all.

**Accounting.** Dr 4000 Sales <taxable credited, goods lines> / Dr 4100 Service Income <taxable credited, service lines> / Dr 2100 Output CGST <cgst credited> / Dr 2110 Output SGST <sgst credited> / Dr 2120 Output IGST <igst credited> / Dr or Cr 5900 Round Off <adjustment, side flipped vs the sale> / Cr 1000 Cash (or 1010 Bank / 1100 Sundry Debtors, per refund_mode) <total_paise> / Dr 1200 Stock in Hand <cost restored> / Cr 5000 COGS <cost restored>. Worked: returning 1 of 4 units of rice — Dr Sales 9524, Dr Output CGST 238, Dr Output SGST 238, Cr Cash 10000, Dr Stock in Hand 8000, Cr COGS 8000. Debits 18000, credits 18000.

**When to use.** General retail, and the default for good reason. It is the only mode where the books can still reconcile SUM(stock_lots.cost_in_paise) against total recorded purchases, because no cost is ever re-created under a new row — it goes back where it was. It is also the only mode that leaves a lot bit-identical to its pre-sale state, which is the property that makes closing stock value provable to an auditor from the purchase documents alone. Groceries, apparel, hardware, anything where a returned unit is simply saleable stock again.

### `new_lot`

**Behaviour.** The cogs_allocations decrement is identical, and the cost taken is computed by the identical remainder rule, so not a paisa differs. The difference is only where it lands: instead of adding back to the original lot, lotInsert() creates ONE NEW LOT PER ORIGINATING ALLOCATION at the exact restored cost, carrying the ORIGINAL lot's received_at — not CURRENT_TIMESTAMP. Dating returned stock today would push genuinely old goods to the back of the FIFO queue, which for anything perishable is precisely backwards. Statement order in the batch is lotInsert, then the return_allocations row resolving lot_id via (SELECT MAX(id) FROM stock_lots), then the allocation decrement — the same ordered-batch sub-select idiom lotInsert already uses for purchase_line_id (fifo.js:143).

**Accounting.** Identical to original_lot: Dr 1200 Stock in Hand <cost restored> / Cr 5000 COGS <cost restored>, alongside the same revenue, tax, round-off and settlement lines. The ledger cannot tell the two modes apart, which is the point — the accounting follows the cost, and the cost is the same integer either way.

**When to use.** When returned stock must be physically or commercially distinguishable from never-sold stock: pharmacy and food where a returned pack is quarantined or sold at a markdown, electronics where an opened box becomes an open-box unit, or any shop whose process requires a separate bin. It buys traceability at a real price — SUM(cost_in_paise) across lots now exceeds total purchases by the returned amount, so purchase-to-stock reconciliation reports need to subtract return_allocations to balance. Choose it when you need the traceability and can live with that.

### `none`

**Behaviour.** No stock statements at all, and no new lot. The cogs_allocations counters are STILL decremented by the identical arithmetic, and return_allocations rows are STILL written, with lot_id NULL and mode 'none'. This is not bookkeeping for its own sake: without it, a later credit note against the same line would compute a cost to restore for units that were already written off and put value into stock that no longer exists. For a service line this mode is reached automatically and is a complete no-op — there are no allocations to walk, so it is silently correct rather than an error.

**Accounting.** Dr 5100 Goods Written Off <cost released> / Cr 5000 COGS <cost released>, in place of the Dr Stock / Cr COGS pair; every revenue, tax, round-off and settlement line is unchanged. Worked: returning 1 of 4 units of rice, damaged — Dr Sales 9524, Dr Output CGST 238, Dr Output SGST 238, Cr Cash 10000, Dr Goods Written Off 8000, Cr COGS 8000. Debits 18000, credits 18000. Net effect: Stock in Hand stays down 8000 (the goods are gone), COGS nets to nil (there is no sale for that cost to match), and the 8000 loss is visible on its own line in the P&L instead of hiding inside cost of sales.

**When to use.** Damaged, expired, opened-and-unsaleable goods, and goodwill refunds where the customer keeps the item. Always set per note rather than shop-wide — a shop whose default is 'none' would write off every perfectly good return. The one shop-wide use is a service business, where it is the honest setting because there is never stock to return.

## Voucher entries

```
GENERIC TEMPLATE — creditNoteVoucherLines(), a mirror of saleVoucherLines() (ledger.js:100) with the sides swapped, validated by the same buildVoucher() so it throws unless debits === credits. Zero lines are dropped by buildVoucher, which is what makes the composition and service cases need no branching at all.

  Dr 4000 Sales                  goodsTaxable        (taxable credited on goods lines)
  Dr 4100 Service Income         serviceTaxable      (taxable credited on service lines)
  Dr 2100 Output CGST            cgst                } only when tax_adjusted = 1
  Dr 2110 Output SGST            sgst                }
  Dr 2120 Output IGST            igst                }
  Dr 5910 GST Not Recoverable    cgst+sgst+igst      only when tax_adjusted = 0
  Dr/Cr 5900 Round Off           roundOff            side FLIPPED vs the sale:
                                                     roundOff >= 0 ? dr : cr
  Cr 1000/1010/1100              total_paise         settlementAccount(refund_mode)
  Dr 1200 Stock in Hand          cogsReversed        } mode original_lot | new_lot
  Cr 5000 COGS                   cogsReversed        }
  Dr 5100 Goods Written Off      cogsReversed        } mode none
  Cr 5000 COGS                   cogsReversed        }

Note settlementAccount() is currently private in ledger.js (line 33) — export it rather than writing a second copy. Same for divRound(), which already exists twice (gst.js:25, fifo.js:20); export it from gst.js and import it in fifo.js and refund.js instead of adding a third.

WORKED, with the full chain. Setup: state 19, regular, inclusive pricing, round-off on. Rice at 10000 paise MRP, 5% (500 bps). Lot A: 3 units for 21000. Lot B: 5 units for 40000.

SALE of 4 units. splitInclusive(40000, 500): taxable = divRound(40000*10000, 10500) = 38095, tax = 40000 - 38095 = 1905. splitByPlace(1905, '19', '19') = cgst 952, sgst 953. roundOff(40000) = 40000, adjustment 0. FIFO: lot A gives 3 at its whole remaining cost 21000; lot B gives 1 of 5 at divRound(40000*1, 5) = 8000. COGS 29000.
  Dr 1000 Cash                40000
  Cr 4000 Sales               38095
  Cr 2100 Output CGST           952
  Cr 2110 Output SGST           953
  Dr 5000 COGS                29000
  Cr 1200 Stock in Hand       29000
  debits 69000 = credits 69000

CREDIT NOTE CN/26-27/0001, 1 unit back, original_lot, cash. Apportion each stored figure independently, denominator qty_returnable = 4, take 1:
  taxable = divRound(38095*1, 4) = 9524
  cgst    = divRound(952*1, 4)   = 238
  sgst    = divRound(953*1, 4)   = 238
  9524 + 238 + 238 = 10000, roundOff(10000) = 10000, adjustment 0.
Cost: reverse-order walk hits allocation #2 (lot B) with qty_returnable 1 — take 1 === qty_returnable, so it takes the WHOLE remainder 8000. Lot B goes 4/32000 back to 5/40000, exactly its pre-sale state.
  Dr 4000 Sales                9524
  Dr 2100 Output CGST           238
  Dr 2110 Output SGST           238
  Cr 1000 Cash                10000
  Dr 1200 Stock in Hand        8000
  Cr 5000 COGS                 8000
  debits 18000 = credits 18000

CREDIT NOTE CN/26-27/0002, the remaining 3 units, original_lot, cash. Counters now read qty_returnable 3, taxable 28571, cgst 714, sgst 715. take 3 === qty_returnable, so every figure takes its whole remainder: taxable 28571, cgst 714, sgst 715, total 30000. Allocation #2 is skipped (qty_returnable 0); allocation #1 (lot A) takes its whole remainder 21000.
  Dr 4000 Sales               28571
  Dr 2100 Output CGST           714
  Dr 2110 Output SGST           715
  Cr 1000 Cash                30000
  Dr 1200 Stock in Hand       21000
  Cr 5000 COGS                21000
  debits 51000 = credits 51000

CLOSING THE LOOP. 9524 + 28571 = 38095, exactly the sale's taxable. 238 + 714 = 952, exactly the sale's CGST. 238 + 715 = 953, exactly its SGST. 8000 + 21000 = 29000, exactly its COGS. Sales, Output CGST, Output SGST, COGS, Stock in Hand and Cash all net to zero. Lot A is back to 3/21000, lot B to 5/40000 — bit-identical to before the sale, not approximately identical. That is the property no symmetric "negative sale" design can offer.

ROUND-OFF, showing it reverses cleanly. Price 9999, 5%: taxable = divRound(9999*10000, 10500) = 9523, tax 476, cgst 238, sgst 238, sum 9999, roundOff(9999) = 10000, adjustment +1. Sale: Dr Cash 10000 / Cr Sales 9523, Cr CGST 238, Cr SGST 238, Cr Round Off 1. Full credit note re-rounds the same 9999 and gets the same +1, posted on the flipped side: Dr Sales 9523, Dr CGST 238, Dr SGST 238, Dr Round Off 1, Cr Cash 10000. Round Off nets to zero. Re-rounding rather than negating the stored round_off_paise is what makes one rule cover both the full and the partial case — a partial return cannot apportion a 1-paisa adjustment without inventing paise.
```

## Atomicity and idempotency

ONE env.DB.batch(). Statement order matters, because batch() returns nothing to thread ids between statements, so every cross-row link is a sub-select resolved inside the same ordered transaction — the exact discipline recordSale already follows (index.js:823).

 1. Bump the series first, so the note row can read the new number:
      INSERT INTO invoice_series (series, fy, last_no) VALUES (?, ?, 1)
      ON CONFLICT(series, fy) DO UPDATE SET last_no = last_no + 1
    Rolled back with everything else on a duplicate, which is what keeps credit
    note numbering gapless — a requirement for GSTR-1 Table 13's from-to range.
 2. INSERT INTO credit_notes (...), with note_no built by the same sub-select
    recordSale uses for invoice_no:
      (SELECT ? || '/' || ? || '/' || printf('%04d', last_no)
         FROM invoice_series WHERE series = ? AND fy = ?)
 3. INSERT INTO credit_note_lines, one per credited sale line.
 4. Per line: UPDATE sale_lines SET qty_returnable = qty_returnable - ?,
    taxable_returnable_paise = taxable_returnable_paise - ?, cgst/sgst/igst
    likewise, WHERE id = ?.
 5. Per allocation, in this order so the sub-selects resolve:
      original_lot: UPDATE stock_lots (+qty, +cost);
                    INSERT return_allocations (lot_id bound directly);
                    UPDATE cogs_allocations (-qty, -cost)
      new_lot:      lotInsert(...) with the original lot's received_at;
                    INSERT return_allocations with
                      lot_id = (SELECT MAX(id) FROM stock_lots);
                    UPDATE cogs_allocations (-qty, -cost)
      none:         INSERT return_allocations with lot_id NULL;
                    UPDATE cogs_allocations (-qty, -cost)
    return_allocations finds its parent by
      (SELECT id FROM credit_note_lines WHERE note_ref = ? AND sale_line_id = ?),
    which the UNIQUE index on that pair makes unambiguous.
 6. voucherStatements(db, { type: 'credit_note', ref: client_ref,
    narration: `Credit note against ${original_invoice_no}` }, voucher.lines).

IDEMPOTENCY has two independent locks and needs both.

credit_notes.client_ref is the PRIMARY KEY, exactly as sales.client_ref is. An offline till that stored the refund but lost the response retries with the same ref, collides at statement 2, and the whole batch rolls back — no second refund, no second stock movement, no second voucher, and the series counter is not advanced.

The voucher carries ref = client_ref with type = 'credit_note', which is NON-NULL by construction. This is deliberate and load-bearing given the known voucherStatements() null-ref hazard: (type, ref) is covered by vouchers_ref_idx UNIQUE ... WHERE ref IS NOT NULL, so the ledger has its own collision detection independent of credit_notes, and two credit-note vouchers can never silently share an identity the way two null-ref purchase vouchers could.

Post-batch error handling copies recordSale's idiom (index.js:887) but splits the CHECK case differently, because the two systems fail for opposite reasons:

  UNIQUE constraint failed / PRIMARY KEY  ->  re-check
      SELECT 1 FROM credit_notes WHERE client_ref = ?
    Row present: return 200 { ok: true, duplicate: true }. Row absent: the
    batch died on some OTHER unique constraint (note_no, the voucher ref, the
    series key) and nothing was written — 500 'credit note not recorded'. Never
    report success for a refund that was not stored; the cash leaves the drawer
    on the strength of that response.

  CHECK constraint failed  ->  409 { error: 'more than was sold has already
    been returned', retryable: FALSE }.
    Note the difference from recordSale, which maps CHECK to retryable: true.
    There, a CHECK means another till took the stock and a retry can re-plan.
    Here it means the returnable counters are exhausted, and no amount of
    retrying will make a line refundable twice. A genuine offline retry cannot
    reach this branch at all — batch() stops at the first error, and the
    PRIMARY KEY on credit_notes is checked at statement 2, long before any
    counter is touched at statement 4.

The one runnable check that proves this holds: a test that fully refunds a sale twice with DIFFERENT client_refs and asserts the second gets 409 with the sale_lines counters unchanged. If ALTER TABLE ADD COLUMN ... CHECK were not enforced on this SQLite build, that test fails loudly instead of the guard evaporating in silence.

## FIFO handling

The rule, stated once and applied at two levels: take what REMAINS, and let the last unit take the remainder.

planReturn(db, saleLineId, qtyWanted, mode) reads
  SELECT id, lot_id, qty_returnable, cost_returnable_paise
    FROM cogs_allocations
   WHERE sale_line_id = ? AND qty_returnable > 0
   ORDER BY id DESC
and for each row takes take = min(need, qty_returnable) with
  cost = (take === qty_returnable)
       ? cost_returnable_paise
       : divRound(cost_returnable_paise * take, qty_returnable)

That is character-for-character the rule in fifo.js:79, and it is the whole reason nothing strands or is invented.

NO COST INVENTED. cost <= cost_returnable_paise <= cogs_allocations.cost_paise, and cost_paise is money that provably came OUT of that lot when the sale was recorded. So the cost returned to a lot can never exceed what the sale removed from it. Per lot, over its whole life:
  cost_in_paise = SUM(taken by sales) - SUM(given back by returns) + cost_remaining_paise
holds exactly, in integers, forever, and return_allocations is the row-level evidence for the middle term.

NO COST STRANDED. Stranding means qty_remaining = 0 with cost_remaining_paise > 0. It cannot arise, at either level. Inside an allocation, the (take === qty_returnable) branch makes the final take carry cost_returnable_paise in full, so qty_returnable and cost_returnable_paise reach zero in the same statement. Inside a lot, every statement that adds cost also adds qty, since take >= 1 always. Prove it on a deliberately awful number — 3 units bought for 1000 paise, sold together, returned one at a time:
  return 1: take 1 != 3  -> divRound(1000*1, 3) = 333; counters 2 / 667
  return 1: take 1 != 2  -> divRound(667*1, 2)  = 334; counters 1 / 333
  return 1: take 1 === 1 -> remainder            333; counters 0 / 0
  333 + 334 + 333 = 1000 exactly. Naive per-unit division would have given
  3 x 333 = 999 and stranded a paisa in a lot with full quantity and missing
  value, which is the identical bug fifo.js was written to avoid.
The one legal asymmetry is quantity with zero cost: an opening-stock lot has cost 0 (0002 line 305), so returning to it adds qty and adds nothing. That is the truth about that lot, not a leak, and stockReport() already sums it correctly.

RESTORED STOCK REJOINS THE QUEUE WITHOUT A FABRICATED DATE. original_lot leaves received_at untouched, so a revived lot sits back in the FIFO order it always occupied — which is right, because the returned goods genuinely are that old. new_lot copies the ORIGINATING lot's received_at rather than stamping CURRENT_TIMESTAMP, which is why it creates one lot per originating allocation rather than one per product: each carries its own age. Stamping today's date would sell two-month-old returned stock after this morning's delivery.

REVERSE-ORDER WALK. ORDER BY id DESC undoes the most recent allocation first. It is the exact inverse of the consumption operation, and practically it means an ordinary partial return usually touches the lot the sale finished on — the one FIFO left partly open — instead of reviving a lot that was fully drained. Both orders are arithmetically exact; this one disturbs less.

WHY EXACT RESTORATION BEATS SYMMETRY. The symmetric design is seductive: treat a return as a negative sale, run the FIFO machinery backwards, post a mirror voucher. It fails on three counts, all of them money.
  1. It invents cost. A "negative consumption" has to value the unit somehow, and the only figure available at return time is today's FIFO cost. Take back one bag of rice bought at 70 while the current lot cost 90, and you have just credited 20 paise of inventory nobody ever paid for. Stock value ratchets upward with every return, violating invariant 2, and no report can detect it because the ledger still balances perfectly.
  2. It requires negatives in exactly the places the schema forbids them. sale_lines.qty and cogs_allocations.qty both CHECK (> 0), and buildVoucher rejects negative lines outright (ledger.js:60) with a comment explaining why: two negatives on opposite sides cancel out, pass the balance check, and post an entry for the wrong total. A symmetric refund means relaxing every one of those guards — trading provable correctness for elegance.
  3. It gives up the one property an auditor can actually test. After exact restoration, a lot is bit-identical to its pre-sale state, and closing stock can be reconstructed from purchase documents alone. Symmetry gives you a trial balance that nets to zero and a stock valuation that is quietly wrong, which is the worse of the two failures because it survives every aggregate check and is found by an accountant months later.
The document and the ledger are the easy part: once you know precisely which paise went back into which lot, the credit note's COGS reversal and its Dr Stock / Cr COGS pair are just that number, reported. Start from the ledger instead and you are left guessing at the stock.

## Edge cases

- PARTIAL REFUND (1 of 4 units). Every stored figure is apportioned independently with the remainder rule, denominator qty_returnable. From the worked sale: taxable divRound(38095*1,4) = 9524, cgst divRound(952*1,4) = 238, sgst divRound(953*1,4) = 238, total 10000. The second note for the remaining 3 takes each counter's whole remainder: 28571 + 714 + 715 = 30000. Sums reconcile to the invoice exactly (9524+28571 = 38095, 238+714 = 952, 238+715 = 953). Apportioning each account separately rather than apportioning total tax and re-splitting is deliberate: re-splitting 751 of 1501 through splitByPlace yields 375/376 then 375/375, which reverses 750 CGST against a 751 CGST liability. Right total, wrong accounts, one paisa of Output CGST over-reversed and SGST under-reversed forever.
- SERVICE REFUND, partial value, no quantity. Catering at 250000 inclusive, 18%: taxable 211864, cgst 19068, sgst 19068. The customer is credited 50000 for a partly-delivered engagement. qty stays 0 (credit_note_lines.qty CHECK is >= 0 precisely for this), and the denominator becomes the line's returnable GROSS (250000) instead of its quantity: taxable divRound(211864*50000, 250000) = 42373, cgst divRound(19068*50000, 250000) = 3814, sgst 3814. Those sum to 50001, not the 50000 typed — so roundOff() absorbs the 1 paisa residue as adjustment -1 and the refund is 50000, with the voucher balancing at 50001 each side via Cr 5900 Round Off 1. Independent per-account rounding cannot sum to a pre-chosen total; the round-off account exists exactly to hold that difference (invariant 3 says the lines are the truth and the total follows). If round_off_enabled = 0 the refund is 50001 and the operator's figure is treated as a target, which the UI must say. No stock statements: kind = 'service' means no cogs_allocations exist, so planReturn returns nothing and stock_return_mode is a silent no-op rather than an error. The voucher debits 4100 Service Income, never 4000. SAC copied from the sale line, matching the original.
- REFUND AFTER THE LOT IS FULLY CONSUMED. In the worked example, lot A is at 0/0 when the second credit note arrives, and is restored to exactly 3/21000. The CHECK constraints are >= 0, so additions are never blocked, and received_at is untouched so the revived lot re-enters at the head of the FIFO queue — correct, it is the oldest stock in the shop. The lot row itself is always resolvable because nothing in the system ever deletes stock_lots. A shop that does not want revived lots re-selling first sets stock_return_mode = 'new_lot', which is the trade this setting exists to offer.
- REFUND ACROSS FINANCIAL YEARS. The note is numbered in the CURRENT year's series (CN/26-27/0007) because a series must be consecutive within the FY it is issued in, while original_invoice_no and original_invoice_date carry the old year's invoice per Rule 53(1A)(g). tax_adjusted is decided from the ORIGINAL SUPPLY DATE against its own FY's cutoff, never the note date. So a March 2027 return against a March 2025 invoice is time-barred even though both look 'recent'. The GSTR-1 period is the note's month; the invoice reference points backwards, which is exactly what the return format expects.
- TIME-BARRED / FINANCIAL CREDIT NOTE. cutoff = min(credit_note_cutoff_mmdd following the end of the FY of supply, settings['gstr9_filed_<fy>'] if present). Note date past the cutoff sets tax_adjusted = 0, and the voucher does NOT touch 2100/2110/2120. The customer is still refunded the full amount including GST, so that tax has to land somewhere or buildVoucher throws: Dr 5910 GST Not Recoverable. Worked, same 1-of-4 rice return on a two-year-old invoice: Dr Sales 9524, Dr GST Not Recoverable 476, Cr Cash 10000, Dr Stock in Hand 8000, Cr COGS 8000 — debits 18000, credits 18000, output tax untouched. gstr1_table is frozen as 'none' so the builder cannot pick it up. Stock restoration and the returnable counters behave identically: the value was consumed and must not be claimable twice, whatever the tax treatment.
- COMPOSITION DEALER. Needs no special case in the money path at all, which is the strongest evidence the design sits in the right place. lineTax() already returns zero tax for a non-regular registration (gst.js:97), so the sale's stored cgst/sgst/igst are 0, so the returnable tax counters are 0, so the apportioned tax is 0, so buildVoucher drops those lines (ledger.js:67). A full 10000 return posts Dr 4000 Sales 10000 / Cr 1000 Cash 10000 plus the Dr Stock / Cr COGS pair. The document differs, not the arithmetic: docType() gains a document-kind argument so the title is 'CREDIT NOTE', the header references the BILL OF SUPPLY number rather than a tax invoice, showTax stays false so no tax column can appear, and the Rule 5(1)(f) composition declaration is carried through. gstr1_table = 'none'; the turnover reduction feeds CMP-08 / GSTR-4. An unregistered business takes the same path with the title 'REFUND RECEIPT' and no GST reporting anywhere.
- DOUBLE REFUND, offline retry. Same client_ref: PRIMARY KEY collision on credit_notes at statement 2, whole batch rolls back, post-batch SELECT 1 FROM credit_notes WHERE client_ref = ? finds the row, respond 200 { ok: true, duplicate: true }. Nothing moved twice and the series counter was not advanced, so numbering stays gapless. If that re-check finds NOTHING, the batch died on a different unique constraint and the correct answer is 500 'credit note not recorded' — telling a till a refund succeeded when nothing was written means cash leaves the drawer against no record.
- DOUBLE REFUND, two devices, different refs. Both plan against the same counters and both look valid; whichever commits second drives qty_returnable (or one of the four value counters) negative, the CHECK fires, and the entire batch rolls back — no note, no stock, no voucher. Response is 409 with retryable FALSE, unlike recordSale's retryable CHECK: a retry cannot make a line refundable twice. This is the same failure mode, and the same safe shape, as two tills selling the last unit of stock.
- REFUND EXCEEDING SOLD QTY, or exceeding sold value. Caught twice over. The application refuses at plan time by reading qty_returnable, and the database refuses at write time via CHECK (qty_returnable >= 0). The second guard is the one that matters, because the first has a read-then-write gap. The value case is guarded identically and independently — a price_correction credit note for more taxable value than the line carried fails on CHECK (taxable_returnable_paise >= 0) even though its qty is 0 and would have passed a qty-only check.
- SECOND REFUND OF WRITTEN-OFF GOODS. Mode 'none' still decrements cogs_allocations and still writes return_allocations with lot_id NULL. Without that, a later credit note against the same line would walk allocations that still claim returnable cost and put value into stock for units that were scrapped — inventing stock out of a write-off. The decrement is not bookkeeping tidiness, it is the guard.
- ITEM CHANGED AFTER THE SALE. Renamed, repriced, moved from inclusive to exclusive pricing, its GST slab revised, deactivated (is_active = 0), or the shop's registration switched from composition to regular. None of it reaches the credit note, because every figure is apportioned from the sale line's own stored columns and name/kind/tax_code/unit are copied again onto credit_note_lines. A credit note can only ever give back numbers that appeared on the invoice.
- LEGACY SALE with total_mismatch = 1. The counters were backfilled from the _paise columns, which are what the books were posted from, not from the legacy `total` the old client sent. So the refund reverses the ledger exactly and stays consistent with the trial balance, while diverging from what that old till printed. Surface the original mismatch flag in the refund UI rather than silently reconciling it — the same choice 0002 made when it kept both figures.
- NUMBER FORMAT. 'CN' + '/' + '26-27' + '/' + '0001' is 13 characters, inside Rule 53(1A)(c)'s 16, using only alphanumerics and '/'. Validate the credit_note_series setting on write against /^[A-Za-z0-9/-]{1,6}$/ so a 9-character prefix cannot silently produce an illegal 20-character document number four months into the year.
- GSTR-1 BUCKET, frozen at issue into credit_notes.gstr1_table: 'none' if tax_adjusted = 0 or registration != 'regular'; else 'cdnr' if customer_gstin is present; else 'cdnur_b2cl' if inter-state and the ORIGINAL invoice total exceeded b2cl_threshold_paise; else 'b2cs_net'. The consequence that matters for a retail till: the ordinary walk-in return is b2cs_net, reported by NETTING inside Table 7 aggregates and not as a note-level 9B entry. Pushing every counter credit note into cdnr would be wrong for the large majority of volume. GSTR-3B has no credit note row at all — notes reduce Table 3.1(a) on a net basis, and the builder must carry a net-NEGATIVE period as negative rather than clamping to zero, since clamping silently discards reclaimable tax.

## Tradeoffs

Seven added columns on two existing tables is the price of the design, and it buys the only thing that cannot be bolted on later: a database-enforced ceiling on every returnable figure. The cheaper alternative — derive what remains by SUM() over credit_note_lines and return_allocations — reads well and fails under concurrency, because two simultaneous partial returns read the same stale remainder and between them reverse a paisa of tax that never existed. Counters that count down with CHECK (>= 0) are the pattern stock_lots already uses for exactly this reason, so this is reuse of a proven mechanism rather than a new one.

Counters go on the existing tables instead of into a pair of side tables because a single-column CHECK (>= 0) leaves no doubt about ALTER TABLE semantics, needs no copied ceiling column, and makes "what is left to return" a plain indexed SELECT with no joins. It does mean cogs_allocations is no longer append-only; the original qty and cost_paise stay immutable and only the new counters move, so the sale's audit record survives intact.

One sale per credit note, and therefore no consolidated multi-invoice note, even though Rule 53(1A)(g) permits one. This is what lets return_allocations resolve its parent through (note_ref, sale_line_id) — the same ordered-batch sub-select idiom recordSale already depends on — and one sale per note is the shape a counter refund actually takes. Consolidation is a wholesale office workflow; it can arrive as a second table when someone needs it.

Revenue is debited straight back to 4000 / 4100 rather than to a contra 'Sales Returns' account. Net revenue is what GSTR-1 Table 7 and GSTR-3B Table 3.1(a) report, so netting in the ledger keeps the books and the returns telling the same story with no reconciliation step, and credit_notes is already a complete, queryable record of return volume. An accountant who wants Sales Returns visible in the P&L gets it by adding one account and changing one line in creditNoteVoucherLines.

original_lot as the default costs something real: returned goods revive retired lots and re-sell first. That is correct cost accounting and wrong for a shop that must quarantine returns, which is precisely why the mode is a setting rather than a decision baked into the code. The trade runs the other way for new_lot — it gains traceability and loses the ability to reconcile SUM(stock_lots.cost_in_paise) against total purchases without subtracting return_allocations.

Credit notes cannot be cancelled or amended. GSTR-1 Table 13 gets cancel = 0, and Table 9C (CDNRA) is unimplemented. A mistaken credit note is corrected the way GST intends — by a debit note — which is a separate document this phase does not build. Skipped deliberately; add it when a user actually needs to amend a filed note.

The operator-entered refund amount on a value-only credit note is a target, not a guarantee: independent per-account rounding can land a paisa either side, absorbed by 5900 Round Off. Honouring the typed figure exactly would mean fudging one tax account, which trades a visible paisa of round-off for an invisible paisa of misstated tax.

## Risks

- ALTER TABLE ADD COLUMN ... CHECK must actually be enforced on D1's SQLite build. SQLite's documented ADD COLUMN restrictions cover PRIMARY KEY, UNIQUE, non-constant defaults and NOT NULL, and say nothing prohibiting CHECK — but if it were silently ignored, the over-return guard would evaporate with no symptom and the trial balance would keep netting to zero. Mitigation is one runnable test, not a code review: refund a sale fully twice with different client_refs and assert 409 plus unchanged counters. If it fails, fall back to a side table with the ceiling copied in and the CHECKs declared at CREATE time, where there is no ambiguity. Verify this before the migration touches a database holding real sales.
- The GSTR-1 and GSTR-3B JSON shapes in the research were reconstructed from secondary sources — cbic-gst.gov.in returned 404s and the GSTN schema on developer.gst.gov.in was not retrievable. Field names (cdnr.nt[].ntty, cdnur.typ, itms[].itm_det) and the Table 13 document-type numbering need checking against the live schema before anything is submitted. Portal-ready JSON that is one key name off is rejected at upload, which is a loud failure and therefore the acceptable kind — but it is still a blocker, so build a schema-shape test against a downloaded sample before wiring the export button.
- The 30 November cutoff is now a setting (credit_note_cutoff_mmdd), which moves the risk from a stale literal to a misconfigured value. An operator who sets it wrong, or who never records settings['gstr9_filed_<fy>'] after filing GSTR-9, will have notes classified tax_adjusted = 1 that legally cannot adjust tax. Surface the computed cutoff and the resulting tax_adjusted decision in the refund UI before the note is issued, not afterwards in a report.
- A financial (time-barred) credit note refunds the customer the GST and books it to 5910 GST Not Recoverable. That is the right treatment when the shop chooses to bear it, but some shops would rather refund net of tax. Not offering the choice means the loss is silent — it appears as an expense line nobody chose. One setting would fix it; deferred deliberately so the first release has one behaviour to test.
- new_lot makes SUM(stock_lots.cost_in_paise) exceed total recorded purchases by the returned amount. Any future purchase-to-stock reconciliation report must subtract return_allocations where mode = 'new_lot' or it will appear to find phantom inventory. Worth a comment in the reporting code the day that report is written, because the discrepancy looks exactly like a data-entry error.
- Reviving a drained lot puts returned goods at the head of the FIFO queue. Cost-correct, and for perishables it is what you want, but a shop that must not re-sell returns without inspection gets no help from the software here — nothing marks a revived lot as containing returned stock. That is what new_lot is for, and the admin UI should say so plainly rather than presenting three modes as interchangeable.
- credit_note_series is per device, like invoice_series. Two tills accidentally configured with the same series will collide on note_no and produce 500 'credit note not recorded' at the counter — correct behaviour, terrible timing. Validate uniqueness when a device is provisioned, not when it first issues a refund.
- The reverse-order allocation walk (ORDER BY id DESC) is arithmetically exact but is a policy choice about which lot gets the unit back when a sale drew from several. If a shop's stock valuation is audited against physical lot identity — serialised or batch-tracked goods — the physical unit returned may not be from the lot the walk credits. Nothing in the schema tracks serial numbers, so this cannot currently be detected, let alone honoured. Out of scope, and worth stating out loud before someone sells pharmaceuticals with it.

---

## Judge verdicts

**Judge 1** picked: Design 2: Allocation-rewind with returnable counters (CHECK-guarded)

- **8/10** — Design 2: Allocation-rewind with returnable counters (CHECK-guarded)
- **7/10** — Design 1: Mirror of recordSale (symmetric credit_notes, derived residual)
  - flaw: Per-account CGST/SGST tax reversal can drift by a paisa on partial returns because tax is recomputed via splitByPlace rather than apportioned from stored figures; trial balance still nets zero so the GST-split misstatement is invisible
  - flaw: No database-enforced ceiling on return_allocations: over-draw is prevented only by arithmetic plus the seq lock, so any future write path bypassing planReturn can silently over-return
- **6/10** — Design 3: Append-only stock_movements log, lots demoted to cache
  - flaw: Recomputing note tax from scratch means a line returned in multiple partial notes may not exactly reverse Output CGST/SGST/Sales, leaving per-account GST residue that trial-balance-zero conceals
  - flaw: Existential staleness risk: correctness of the entire stock+ledger story depends on modifying the working sale and purchase money paths in lockstep with the migration; a split PR corrupts silently
  - flaw: Append-only immutability relies on D1 trigger support that the design itself admits was not verified

**Judge 2** picked: Design 2: Allocation-rewind with returnable counters that count down under CHECK(>=0)

- **7/10** — Design 1: Mirror of recordSale (inverse sale, allocation-level un-consume)
  - flaw: Multi-partial output-tax drift: reversing per-note tax recomputed from apportioned taxable can over/under-reverse Output CGST/SGST by a paisa versus what was charged, an invisible-in-trial-balance GST reconciliation defect
  - flaw: Over-refund ceiling is an app-level read plus an optimistic UNIQUE(sale_ref,sale_seq) lock, not a DB CHECK on quantity/value; correct only while validation and INSERT share one request (self-flagged), weaker than a DB-enforced counter
- **8/10** — Design 2: Allocation-rewind with returnable counters that count down under CHECK(>=0)
- **5/10** — Design 3: Append-only stock_movements log; lots demoted to a reconcilable cache
  - flaw: Silent stale-log risk: correctness of every audit claim depends on retrofitting the sale AND purchase money paths to append movements; if any path is missed the log rots invisibly while the POS keeps working
  - flaw: Over-engineered for the stated goal — an append-only ledger + triggers to ship credit notes is a speculative stock-audit platform (YAGNI); none of it makes the credit note more compliant
  - flaw: Depends on unverified D1 trigger support for its append-only guarantee; if triggers are ignored, immutability degrades to convention

**Judge 3** picked: Design 1: Mirror of recordSale (credit_notes as inverse sale, allocation-level un-consume)

- **8/10** — Design 1: Mirror of recordSale (credit_notes as inverse sale, allocation-level un-consume)
- **7/10** — Design 2: Allocation-rewind with returnable counters (CHECK>=0 on existing tables)
- **5/10** — Design 3: Append-only stock_movements log, lots demoted to a reconcilable cache
  - flaw: Rewrites recordSale AND the purchase path; if either is not taught to append movements in the same PR, the reconciliation silently fails on day one while the POS keeps working — the design's own stated worst case
  - flaw: Depends on D1 SQLite trigger support (RAISE ABORT) that the design admits it never tested; without it append-only degrades to convention
  - flaw: Doubles hot-path write volume and risks exceeding batch size on large new_lot notes (~200 lots + ~600 movements in one batch)

## Ideas grafted from the losing designs

- Adopt Design 1's symmetric document shape and creditNoteVoucherLines() = saleVoucherLines() with sides swapped, run through the same buildVoucher() — it is the cleanest way to guarantee debits===credits with zero new arithmetic, and pairs naturally with Design 2's counter-based figures.

- Keep Design 2's independent per-account remainder apportionment as THE tax-reversal method and explicitly reject the recompute-via-splitByPlace approach of Designs 1 and 3: apportioning each stored cgst/sgst/igst counter with the remainder rule is the only method that reverses each GST account exactly on partial returns (verified on the tax-3, thirds case).

- Graft Design 3's stock_movements audit log as a later, separate phase (its own PR) — returned-vs-purchased distinguishability and the cache-vs-projection reconciliation query are genuinely valuable; ship that reconciliation query as a CI test even against the winner's schema.

- Take the shared, uncontroversial pieces from all three: add accounts 5100 Goods Written Off and 5910 Irrecoverable GST; decide tax_adjusted from the ORIGINAL supply date (s.34(2) cutoff) not the note date; give credit notes their own per-FY CN series; snapshot place_of_supply/customer_gstin/registration on the note; freeze the GSTR-1 bucket at issue with ordinary walk-in returns as b2cs_net (not CDNR).

- Carry Design 1's sale_seq UNIQUE(sale_ref,seq) as a secondary whole-note idempotency guard, but keep Design 2's per-line CHECK(>=0) counters as the primary over-refund ceiling.

- Adopt Design 3's explicit rule that the GSTR-3B builder must carry a net-negative period rather than clamp to zero, and validate the credit_note_series length/charset on settings write (Rule 53(1A)(c) 16-char limit) — both are cheap correctness guards all three flagged.

- Ship one runnable check that Design 2 demands: refund a sale fully twice with different client_refs and assert the second gets 409 with counters unchanged — this proves ADD COLUMN ... CHECK is actually enforced on the D1 build, the one real risk in the winner.

- From Design 1: the true-mirror creditNoteVoucherLines() with sides swapped through the same buildVoucher(), leaning on zero-line dropping so composition/service/financial cases need no branching — the cleanest articulation, and it makes reversal a provable column-by-column undo. Also export settlementAccount() and export divRound() from gst.js to kill the fifo.js duplicate rather than adding a third copy (all three call for this; do it).

- From Designs 1 and 3: a pure taxAdjustable(supplyDate, noteDate, fyStart, annualReturnFiledDate) helper deciding tax_adjusted from the ORIGINAL SUPPLY date (not the note date) against the 30-Nov cutoff and any earlier annual-return date, reusing fyLabel's IST shift — testable with no D1, and it keeps the Finance Act 2022 cutoff as a setting not a literal.

- From Design 3: carry a GSTR-3B net-negative period explicitly rather than clamping Table 3.1(a) to zero (clamping silently loses reclaimable tax); and freeze the GSTR-1 bucket (cdnr / cdnur_b2cl / b2cs_net) plus customer_registered at issue so a filed return never changes shape when a mutable customer row later changes.

- From Design 1: validate the credit_note_series setting on save against length<=6 and charset [A-Za-z0-9/-] so a per-device prefix cannot silently produce a >16-char number that a tax portal rejects months later.

- From Design 3's risk note and Design 1's: ship a stock/tax integrity report and one runnable concurrency test — refund a sale fully twice with different client_refs, assert the second gets 409 and the returnable counters are unchanged — which also proves the ADD COLUMN...CHECK guard is actually enforced on D1.

- Model stock_return_mode='none' write-off through the same account/mechanism a future standalone scrap-stock feature would use (Design 3's observation), but do NOT build the movement log now — note it as the upgrade path only.

- From Design 2: add a DB-enforced ceiling to close Design 1's one real gap. The cheapest graft is qty_returnable/cost_returnable_paise CHECK(>=0) counters on cogs_allocations only (decremented in the return batch), giving a per-allocation constraint that catches any future non-planReturn writer — without Design 1 needing to touch recordSale for the sale_lines value counters. Accept the small cost of making cogs_allocations mutable, or keep Design 1 as-is and ship the reconciliation report below instead.

- From Design 2/3: ship the stock-integrity / cost-conservation reconciliation query as a CI test and an admin report regardless of winner — per lot, cost_in = SUM(consumed) - SUM(returned) + cost_remaining. It is the cheap detector for the silent over-draw risk Design 1 discloses.

- From Design 2: the independent value tripwire (taxable_returnable) as the sole over-credit guard for service value-only notes where qty=0 — Design 1 needs the same parallel value bound and states it, but make it explicit in the validation join.

- From Design 3: keep stock_movements as DEFERRED future work, to be introduced only when a SECOND stock-mutating feature actually arrives (stock adjustments, standalone damage write-off, physical-count correction, branch transfer). At that point the 'none' write-off reason and the log pay for themselves; today they are YAGNI.

- Common to all three and worth adopting verbatim: non-null voucher ref = client_ref (the design-around for the null-ref voucher collision); a separate CN series reusing invoice_series(series, fy); accounts 5100 Goods Written Off and 5910 Unrecoverable Output GST; tax_adjusted decided from the ORIGINAL supply date (not the note date) via a pure taxAdjustable() helper with the cutoff as a setting; freezing the GSTR-1 bucket and customer_registered snapshot at issue; per-note override of the stock_return_mode setting; copying name/kind/tax_code/unit/price from sale_lines rather than re-reading products; and exporting settlementAccount() and divRound() instead of duplicating them.

- Validate credit_note_series length/charset on write (<=16 chars total incl FY+sequence, alphanumerics plus - and /) so a long per-device prefix cannot silently produce an illegal note number months later.

- Ensure the GSTR-3B builder carries a net-negative Table 3.1(a) period explicitly rather than clamping to zero, and that ordinary walk-in returns net into GSTR-1 Table 7 (b2cs) rather than being pushed into CDNR — flagged consistently by all three.

## The other two designs, for the record

### Mirror of recordSale: credit_notes as the inverse sale, one atomic batch, allocation-level un-consume

A refund is a sale run backwards, so it gets the same shape: `credit_notes` mirrors `sales`, `credit_note_lines` mirrors `sale_lines`, `return_allocations` mirrors `cogs_allocations`, and the voucher is `saleVoucherLines` with debits and credits swapped. The cost arithmetic is the exact inverse of `planConsume` — un-consume each `cogs_allocations` row with the same take-the-remainder rule, so total COGS reversed over a line's life equals what was charged, to the paisa. Symmetry is the safety property: there is no second model of money to keep in sync, every invariant that already holds for a sale holds for its reverse by construction, and `stock_return_mode` changes exactly one account code and one statement — never the arithmetic.

Tradeoffs: Symmetry is the case for this design, and it is a correctness argument rather than an aesthetic one.

There is only one model of money. A refund that invented its own shape -- negative rows in `sales`, or a status column, or a separate reversal engine -- would create a second place where GST rounding, the CGST/SGST split, FIFO cost and double-entry all have to be right, and a second place for them to drift apart. Here there is no new arithmetic at all: splitByPlace, splitExclusive, roundOff, divRound, buildVoucher, lotInsert and voucherStatements are reused unchanged, and the only genuinely new code is planReturn -- which is planConsume's loop with the sign flipped and a residual read in front of it. 171 green tests keep covering the tax and FIFO math on the refund path for free, because it is the same math.

The invariants come along for free instead of being re-argued. Money stays integer paise because no new money path exists. GST still rounds per line because the note is built from lines. debits === credits because the note goes through the same buildVoucher. One atomic batch because the statement list is assembled the same way. Idempotency by client-generated PK because the table is shaped like `sales`. Each of those is a property of the shape, not of a rule someone has to remember while editing refund code later.

Reversal is provable, not approximate. Because the note stores the same columns as the sale, "did this refund fully undo that sale" is a column-by-column comparison, and the trial balance returns to its pre-sale state exactly. An asymmetric design can only assert that.

The deliberate asymmetries are few, and each earns its place: credit_note_lines.qty allows 0 (services are credited by value, which a qty-driven schema cannot express); sale_seq exists because a sale competes for stock while a refund competes for one invoice's remaining refundable quantity; tax_adjusted and customer_registered exist because a note carries legal facts an invoice does not. Four exceptions, each one line of schema.

What symmetry costs. Roughly 40 columns duplicate `sales` and `sale_lines`, and any future column added to a sale should be considered for the note -- a real maintenance tax, paid in exchange for reports that can UNION the two without a translation layer. It also means a credit note cannot span multiple invoices, since sale_ref is singular; Rule 53(1A)(g) does permit a consolidated note, but a counter refund is always against one bill, and the escape hatch is n notes rather than a many-to-many table nobody needs yet. Storing positive magnitudes and inferring direction from the table means every revenue report must read both tables, which is exactly why 4000/4100 are debited directly rather than routed through a contra Sales Returns account: the P&L then shows net revenue, which is what GSTR-3B and the ITR both want, and gross-vs-net is recoverable from credit_notes whenever anyone asks. A contra account would show returns in the trial balance but would break the mirror and leave every revenue query needing to remember to net two accounts.

Skipped on purpose: debit notes (one column of room reserved, no code), consolidated multi-invoice notes, refund vouchers for advances (s.31(3)(e) only applies once you take advances, which this POS does not), and amendment notes for GSTR-1 Table 9C. Add each when the feature that needs it arrives.

### Append-only stock_movements log; lot columns demoted to a reconcilable cache

Every stock event — purchase, opening, sale, return, write-off — becomes an immutable row in one `stock_movements` table carrying a signed qty/cost delta, a reason, and the document that caused it. A refund never edits history: it appends. `stock_lots.qty_remaining` / `cost_remaining_paise` survive untouched as a materialised cache, written in the same batch from the movements, so `planConsume`, the CHECK-constraint oversell guard, and `stockReport` all keep working unchanged — and a one-query reconciliation proves cache equals projection. Credit notes get their own table, their own per-FY gapless `CN` series, a device-generated `client_ref` primary key for idempotency, and a per-line stock-return mode driven by a setting.

Tradeoffs: WHAT THE LOG BUYS. Four things, and the fourth is the one that pays for the migration. (1) A returned unit stays distinguishable from a purchase forever — `reason = 'sale_return'` is a fact, where a bumped qty_remaining is an opinion. (2) A revived lot is explained: instead of a mysterious non-zero remainder on a lot that FIFO had retired, there is a row saying which note revived it and against which sale line. (3) The reconciliation query exists at all. In-place mutation has exactly one number per lot, so there is nothing to compare it against and no test that can catch a leak; here, cache-versus-projection disagreement is one query and belongs in CI. (4) Every stock feature after this one is a new `reason` value and zero new tables: stock adjustments, damage write-off, physical-count corrections, branch transfers, expiry scrapping. The `writeoff` reason that mode `none` needs is already, unmodified, the standalone scrap-stock feature.

WHAT IT COSTS, honestly. The backfill itself is cheap and nearly exact — lots reconstruct their 'in' movements from qty_in/cost_in_paise/received_at/purchase_line_id, and cogs_allocations reconstructs every 'out' row lot by lot and paisa by paisa. That second part is only true because cogs_allocations was built in phase 1; without it this migration would be guesswork. The real cost is elsewhere: the sale and purchase paths must start appending movements alongside the stock UPDATEs they already emit, or the log goes stale within a day of deploying and every claim above quietly becomes false. That is a change to working, tested code in the middle of the money path — roughly three statements added to recordSale's batch and two to the purchase path, plus their tests. It is the price, it is bounded, and it has to be in the same PR as the migration.

WHY NOT A PURE PROJECTION. The maximalist version of this angle drops qty_remaining and cost_remaining_paise and derives everything from SUM(qty_delta). I am not proposing it, and the reason is specific rather than conservative: `CHECK (qty_remaining >= 0)` is this system's entire oversell protection. fifo.js:85-104 spells it out — the lot SELECT happens before the batch opens, so two tills can both pass the availability check, and the loser's subtraction driving a remainder negative is what rolls the batch back. An aggregate has no CHECK constraint. Going pure would mean inventing a replacement concurrency control for the sale path in the same change as the refund feature, which is how you get a POS that oversells under load. The hybrid keeps the guard bit-for-bit and pays for it with one reconciliation query. A correctness-critical constraint that already works is not worth trading for architectural purity.

WHY NO credit_note_allocations TABLE. The obvious mirror of cogs_allocations would record which original allocation each return unwinds. It is unnecessary: `src_sale_line_id` on the movement rows already answers that question, and the rule "every return re-enters the original lot first, then the mode decides what happens next" makes the residual query mode-free — so `none` and `new_lot` need no special case and there is no second table to drift out of step with the log. That uniform rule is also why write-off is modelled as two movements rather than as skipped stock: it is what actually happened, and it keeps the returned units marked so a second refund of them is blocked.

WHAT THE LEDGER DOES NOT GET. There is no 4010 Sales Returns contra-income account. Returns debit 4000/4100 directly, which nets correctly for GSTR-3B table 3.1(a) and for the P&L, and the credit_notes table itself gives the gross-returns figure to any report that wants it. Add 4010 only if someone actually asks to see gross sales and returns as separate lines on the face of the P&L. By contrast 5100 and 5910 are not optional: without them, mode `none` and the financial-only note respectively can only be posted by unbalancing a voucher or by writing a number the books do not mean.

STORAGE. One movement row per sale line per lot, so a 10-line bill drawing from 1-2 lots each writes 10-20 rows where today it writes 10 allocations and 10-20 UPDATEs. Roughly double the write volume on the hot path, all appends, all indexed. For a single-shop POS this is noise; the note under risks about pruning is there for the multi-year case.

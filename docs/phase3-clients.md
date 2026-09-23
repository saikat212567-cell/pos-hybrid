# pos-hybrid Phase 3: Refunds, Credit Notes, Stock Return

Produced 2026-09-23 by the phase-3 design workflow. This is the spec as
written by the agent, kept verbatim. It has not yet been implemented, and
nothing in it has been verified against a running system.

---

## Plan

## Phase 3 Implementation Plan

### 1. Database Schema (worker/migrations/0004_refunds.sql)
- Add `credit_notes` table with per-note metadata and snapshot fields
- Add `credit_note_lines` table mirroring `sale_lines` with sale_line_id reference
- Add `return_allocations` table linking to `cogs_allocations`
- Add two new accounts: Goods Written Off (5100), GST Not Recoverable (5910)
- Add settings: `stock_return_mode`, `credit_note_series`, `b2cl_threshold_paise`, `credit_note_cutoff_mmdd`
- Backfill existing sales with full returnables (qty_returnable = qty, etc.)

### 2. Worker Core (worker/src/index.js, ledger.js, fifo.js, gst.js)
- Export `settlementAccount()` from ledger.js
- Export `divRound()` from gst.js (existing implementation)
- Add `planReturn()` in fifo.js: reverse FIFO walk, decrement returnable counters
- Add `recordCreditNote()` route: validate, write credit note with D1 batch()
- Add `creditNoteVoucherLines()` in ledger.js: mirror saleVoucherLines with reversed sides

### 3. Web UI (web/refund.html, web/refund.js)
- New refund page: find sale by invoice no, show sale lines with returnable counters
- Partial return: per-line quantity input, mode selector
- Print credit note: reuse bill.js renderer (amountInWords already handles positive magnitudes)

### 4. Android Client (Db.kt, PosApi.kt, new UI)
- Room schema version 3: add credit_notes, credit_note_lines, return_allocations tables
- MIGRATION_2_3: backfill returnables, create new tables
- PosApi: `fetchCreditNote()`, `recordCreditNote()`
- UI: Refund screen with sale search, line selection, mode selector
- SyncWorker: credit notes queue similar to sales

### 5. Tests
- worker/test/refund.test.js: exact restoration, over-return prevention, all modes
- android/test/RefundTest.kt: Room schema migration, API calls

## Files

| Path | Change | What |
|---|---|---|
| `worker/migrations/0004_refunds.sql` | new | New migration: credit_notes, credit_note_lines, return_allocations tables; new accounts; settings |
| `worker/src/ledger.js` | modify | Export settlementAccount(); add creditNoteVoucherLines() function |
| `worker/src/fifo.js` | modify | Export divRound(); add planReturn() for reverse FIFO consumption |
| `worker/src/gst.js` | modify | Export divRound() helper |
| `worker/src/index.js` | modify | Add recordCreditNote() route |
| `web/refund.html` | new | Refund entry UI |
| `web/refund.js` | new | Refund logic |
| `android/app/schemas/com.example.pos.data.PosDb/3.json` | new | Room schema version 3 |
| `android/app/src/main/java/com/example/pos/data/Db.kt` | modify | Migration to version 3, new tables |
| `android/app/src/main/java/com/example/pos/net/PosApi.kt` | modify | credit note API methods |
| `android/app/src/main/java/com/example/pos/ui/Refund.kt` | new | Refund screen and logic |
| `worker/test/refund.test.js` | new | Refund tests |

## Tests

- Credit note fully reverses a sale with exact cost restoration to FIFO lots
- Partial return respects per-line CHECK constraints preventing over-return
- stock_return_mode='original_lot' restores lot to pre-sale state exactly
- stock_return_mode='new_lot' creates new lot with original cost
- stock_return_mode='none' writes off cost to Goods Written Off account
- GSTR-1 table selection (cdnr/cdnur/b2cs_net) based on threshold and registration
- Two concurrent refunds of same sale second fails with 409

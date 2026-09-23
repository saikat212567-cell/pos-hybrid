# Phase 3 accounting-report API specification for the Cloudflare Worker/D1 POS

Produced 2026-09-23 by the phase-3 design workflow. This is the spec as
written by the agent, kept verbatim. It has not yet been implemented, and
nothing in it has been verified against a running system.

---

## Plan

Use the ledger as the accounting source and document/lot tables as audit subledgers. All amounts stay signed only in report output; persisted sales and credit-note columns remain positive magnitudes. All response money fields are integer `*_paise`.

Period convention

Every reporting endpoint accepts India business calendar dates. Convert `from` to the start of that date in IST and `to` to the start of the day after the supplied inclusive end date in IST; bind the resulting D1-compatible UTC strings as `:from` and `:to_exclusive`. Every report uses `[from, to_exclusive)`, never `<= to`. This avoids omitting documents later on the end date and keeps the indexed `v.date`, `sold_at`, `invoice_date`, and `note_date` columns usable. Return the normalized values, for example:

```json
{
  "period": {
    "timezone": "Asia/Kolkata",
    "from": "2026-04-01",
    "to": "2026-04-30",
    "to_exclusive": "2026-05-01"
  },
  "currency": "INR",
  "unit": "paise"
}
```

For all account reports, the normal signed balance is `debit - credit` for assets and expenses, and `credit - debit` for liabilities, equity, and income. The following roll-forward is the common query to put in `ledger.js`; it is the useful reusable core, while the existing `trialBalance()` remains the debit/credit control total.

```sql
SELECT
  a.code, a.name, a.type,
  COALESCE(SUM(CASE WHEN v.date < :from THEN vl.debit_paise  - vl.credit_paise ELSE 0 END), 0) AS opening_raw_paise,
  COALESCE(SUM(CASE WHEN v.date >= :from AND v.date < :to_exclusive
                    THEN vl.debit_paise - vl.credit_paise ELSE 0 END), 0) AS movement_raw_paise,
  COALESCE(SUM(CASE WHEN v.date < :to_exclusive THEN vl.debit_paise - vl.credit_paise ELSE 0 END), 0) AS closing_raw_paise
FROM accounts a
LEFT JOIN voucher_lines vl ON vl.account_code = a.code
LEFT JOIN vouchers v ON v.id = vl.voucher_id AND v.date < :to_exclusive
GROUP BY a.code, a.name, a.type
ORDER BY a.code;
```

Transform each raw field in JavaScript according to account type, so the response can expose `opening_paise`, `movement_paise`, and `closing_paise` in its natural sign without repeating SQL. `trialBalance()` should use the same half-open bounds but retain its current raw debit/credit response and `net === 0` assertion.

P&L

The P&L is period movement, not balances since inception. Revenue is every income account, explicitly grouped into goods Sales (`4000`) and Service Income (`4100`). COGS is `5000`; all other expense accounts are operating/other expenses, including `5900 Round Off`, `5100 Goods Written Off`, and `5910 GST Not Recoverable`. GST control accounts are assets/liabilities and never P&L revenue or expense.

```sql
WITH account_period AS (
  SELECT a.code, a.name, a.type,
         COALESCE(SUM(vl.debit_paise), 0) AS debit_paise,
         COALESCE(SUM(vl.credit_paise), 0) AS credit_paise
    FROM accounts a
    LEFT JOIN voucher_lines vl ON vl.account_code = a.code
    LEFT JOIN vouchers v ON v.id = vl.voucher_id
                         AND v.date >= :from AND v.date < :to_exclusive
   GROUP BY a.code, a.name, a.type
), figures AS (
  SELECT code, name, type,
         CASE WHEN type = 'income'  THEN credit_paise - debit_paise
              WHEN type = 'expense' THEN debit_paise - credit_paise
              ELSE 0 END AS amount_paise
    FROM account_period
)
SELECT code, name, type, amount_paise
  FROM figures
 WHERE (type = 'income' OR type = 'expense')
   AND amount_paise <> 0
 ORDER BY code;
```

Build this response from the returned rows:

```json
{
  "revenue": {"goods_paise": 0, "services_paise": 0, "other_paise": 0, "total_paise": 0},
  "cost_of_goods_sold_paise": 0,
  "gross_profit_paise": 0,
  "expenses": [{"code":"5100","name":"Goods Written Off","amount_paise":0}],
  "total_other_expenses_paise": 0,
  "net_profit_paise": 0
}
```

`gross_profit_paise = total revenue - 5000 COGS`; `net_profit_paise = total revenue - all expense balances`. Opening lots migrated by `0002_foundation.sql` deliberately have zero cost, so sales from them carry zero COGS and inflate gross profit. Surface `zero_cost_opening_stock_caveat: true` when any sold allocation came from `cost_in_paise = 0`; do not invent an estimated margin.

Credit notes change this automatically through the reversing voucher: the credit note debits `4000`/`4100`, so revenue falls; a returned good credits `5000`, so COGS falls. A `none`/damaged return credits COGS but debits `5100`, preserving the cancellation of sale COGS while showing the loss separately. A time-barred financial note leaves Output GST untouched and debits `5910`, so the unrecoverable tax is visible as an expense rather than silently reducing GST payable. Price corrections and service notes have zero COGS and work without a special report branch.

Balance sheet

Use all vouchers before `:to_exclusive`; `from` is optional only to display account roll-forward, never to calculate the actual closing balance sheet. Group `asset` accounts into Cash 1000, Bank 1010, Sundry Debtors 1100, Stock in Hand 1200, and Input GST 1300/1310/1320 (with an `other_assets` remainder). Group liabilities into Sundry Creditors 2000 and Output CGST/SGST/IGST 2100/2110/2120; equity includes Capital 3000 and Opening Stock Adjustment 3100.

```sql
WITH balances AS (
  SELECT a.code, a.name, a.type,
         COALESCE(SUM(vl.debit_paise - vl.credit_paise), 0) AS raw_paise
    FROM accounts a
    LEFT JOIN voucher_lines vl ON vl.account_code = a.code
    LEFT JOIN vouchers v ON v.id = vl.voucher_id AND v.date < :to_exclusive
   GROUP BY a.code, a.name, a.type
)
SELECT code, name, type,
       CASE WHEN type IN ('asset', 'expense') THEN raw_paise ELSE -raw_paise END AS normal_balance_paise
  FROM balances
 ORDER BY code;
```

There is no period-close mechanism yet. Therefore report the accumulated, unclosed result as `earnings_to_date_paise = SUM(income normal balances) - SUM(expense normal balances)` and place it on the equity side. This is necessary for the control equation to hold without making a fake year-end journal:

```text
assets_paise = liabilities_paise + posted_equity_paise + earnings_to_date_paise
```

Return `{assets, liabilities, equity, earnings_to_date_paise, totals:{assets_paise, liabilities_and_equity_paise}, balanced}` plus each account's opening/movement/closing roll. A refund lowers Cash/Bank/Debtors, a tax-adjusted note lowers Output GST, original/new-lot return raises Stock in Hand, and damaged mode leaves Stock in Hand unchanged while raising the 5100 expense captured in earnings.

Registers

Sales register is a document register, not a rederived tax calculation. It must use stored invoice/credit-note figures because a later GST rate, item edit, registration switch, or customer update cannot rewrite a legal document. Emit both sales and credit notes with signed accounting amounts; retain the original positive note figures only in optional `document_amounts` if the UI needs to print a credit note. The `gst_return_*` fields intentionally exclude a financial (`tax_adjusted = 0`) credit note.

```sql
WITH documents AS (
  SELECT 'sale' AS document_type, s.sold_at AS document_date,
         s.client_ref AS document_ref, s.invoice_no AS document_no,
         NULL AS original_invoice_no, 1 AS tax_adjusted,
         s.place_of_supply, s.customer_gstin,
         s.taxable_paise, s.cgst_paise, s.sgst_paise, s.igst_paise,
         s.round_off_paise, s.total_paise, s.cogs_paise,
         s.cgst_paise AS gst_return_cgst_paise,
         s.sgst_paise AS gst_return_sgst_paise,
         s.igst_paise AS gst_return_igst_paise,
         0 AS gst_not_recoverable_paise
    FROM sales s
   WHERE s.sold_at >= :from AND s.sold_at < :to_exclusive
  UNION ALL
  SELECT 'credit_note', cn.note_date, cn.client_ref, cn.note_no,
         cn.original_invoice_no, cn.tax_adjusted,
         cn.place_of_supply, cn.customer_gstin,
         -cn.taxable_paise, -cn.cgst_paise, -cn.sgst_paise, -cn.igst_paise,
         -cn.round_off_paise, -cn.total_paise, -cn.cogs_reversed_paise,
         CASE WHEN cn.tax_adjusted = 1 THEN -cn.cgst_paise ELSE 0 END,
         CASE WHEN cn.tax_adjusted = 1 THEN -cn.sgst_paise ELSE 0 END,
         CASE WHEN cn.tax_adjusted = 1 THEN -cn.igst_paise ELSE 0 END,
         CASE WHEN cn.tax_adjusted = 0
              THEN cn.cgst_paise + cn.sgst_paise + cn.igst_paise ELSE 0 END
    FROM credit_notes cn
   WHERE cn.note_date >= :from AND cn.note_date < :to_exclusive
)
SELECT * FROM documents
ORDER BY document_date, document_type, document_ref;
```

The response includes document identity, source invoice identity, place/customer snapshots, registration, `gstr1_table`, `tax_adjusted`, payment/refund mode, tax values, COGS reversal, and signed net totals. Aggregate register totals from this result; GST returns must use the frozen GSTR bucket and `gst_return_*`, not a mutable customer record or the accounting register's total.

Purchase register takes invoice values from purchases and inventory cost from linked lots, rather than assuming `taxable_paise` is always the stock cost. That distinction matters for composition/unregistered purchases, where non-creditable tax is inside the lot cost.

```sql
SELECT p.id AS purchase_id, p.invoice_date, p.supplier_name, p.supplier_gstin,
       p.supplier_inv_no, p.payment_mode,
       p.taxable_paise, p.cgst_paise, p.sgst_paise, p.igst_paise, p.total_paise,
       COALESCE(SUM(l.cost_in_paise), 0) AS stock_added_paise,
       COALESCE(SUM(pl.qty), 0) AS quantity_received
  FROM purchases p
  LEFT JOIN purchase_lines pl ON pl.purchase_id = p.id
  LEFT JOIN stock_lots l ON l.purchase_line_id = pl.id
 WHERE p.invoice_date >= :from AND p.invoice_date < :to_exclusive
 GROUP BY p.id
 ORDER BY p.invoice_date, p.id;
```

There is no purchase-return feature in the stated phase, so do not fabricate a negative purchase register path. Add it only when supplier debit notes are actually implemented.

Stock register is a FIFO subledger. For current stock, `stock_lots.qty_remaining` and `stock_lots.cost_remaining_paise` are authoritative per-item physical carrying values. For an historical as-of report, reconstruct movements from immutable source events; do not use a new-lot's copied `received_at` as the return date. A `new_lot` is excluded from base-lot receipts and included once at its credit-note date. `none` appears as an audit disposition with zero stock delta, rather than falsely adding damaged goods back to stock.

```sql
WITH stock_events AS (
  SELECT l.product_id, l.received_at AS occurred_at, 'receipt' AS event_type,
         l.id AS event_id, l.qty_in AS qty_delta, l.cost_in_paise AS value_delta
    FROM stock_lots l
   WHERE NOT EXISTS (
     SELECT 1 FROM return_allocations ra
      WHERE ra.lot_id = l.id AND ra.mode = 'new_lot'
   )
  UNION ALL
  SELECT sl.product_id, s.sold_at, 'sale', ca.id, -ca.qty, -ca.cost_paise
    FROM cogs_allocations ca
    JOIN sale_lines sl ON sl.id = ca.sale_line_id
    JOIN sales s ON s.client_ref = sl.sale_ref
  UNION ALL
  SELECT cnl.product_id, cn.note_date,
         CASE WHEN ra.mode = 'none' THEN 'return_written_off' ELSE 'return_to_stock' END,
         ra.id,
         CASE WHEN ra.mode = 'none' THEN 0 ELSE ra.qty END,
         CASE WHEN ra.mode = 'none' THEN 0 ELSE ra.cost_paise END
    FROM return_allocations ra
    JOIN credit_note_lines cnl ON cnl.id = ra.credit_note_line_id
    JOIN credit_notes cn ON cn.client_ref = cnl.note_ref
), opening AS (
  SELECT product_id, COALESCE(SUM(qty_delta), 0) AS opening_qty,
         COALESCE(SUM(value_delta), 0) AS opening_value_paise
    FROM stock_events
   WHERE occurred_at < :from
   GROUP BY product_id
), period_events AS (
  SELECT e.*, p.name, p.unit, p.tax_code,
         SUM(e.qty_delta) OVER (
           PARTITION BY e.product_id ORDER BY e.occurred_at, e.event_type, e.event_id
         ) AS cumulative_qty,
         SUM(e.value_delta) OVER (
           PARTITION BY e.product_id ORDER BY e.occurred_at, e.event_type, e.event_id
         ) AS cumulative_value_paise
    FROM stock_events e
    JOIN products p ON p.id = e.product_id
   WHERE e.occurred_at >= :from AND e.occurred_at < :to_exclusive
)
SELECT pe.*, COALESCE(o.opening_qty, 0) AS opening_qty,
       COALESCE(o.opening_value_paise, 0) AS opening_value_paise
  FROM period_events pe
  LEFT JOIN opening o ON o.product_id = pe.product_id
 ORDER BY pe.occurred_at, pe.event_type, pe.event_id;
```

The endpoint returns grouped opening/received/sold/returned/written-off/closing totals and optionally paginated movement rows. For a current snapshot, also return the direct lot rows from `stockReport()`; they are the drill-down proof of the closing total. Services naturally have no stock events. A zero-cost opening lot can produce positive quantity with zero value and is legitimate, not a mismatch.

Cash book and day book both come entirely from vouchers. Cash book selects account 1000, calculates opening from all prior cash lines, and exposes each receipt/payment so sales refunds are cash payments automatically. The same query with `:account_code = '1010'` is a bank book later, not a second implementation.

```sql
WITH opening AS (
  SELECT COALESCE(SUM(vl.debit_paise - vl.credit_paise), 0) AS opening_paise
    FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
   WHERE vl.account_code = :account_code AND v.date < :from
), movements AS (
  SELECT v.id AS voucher_id, v.date, v.type, v.ref, v.narration,
         vl.id AS line_id, vl.debit_paise AS receipt_paise,
         vl.credit_paise AS payment_paise,
         vl.debit_paise - vl.credit_paise AS movement_paise
    FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
   WHERE vl.account_code = :account_code
     AND v.date >= :from AND v.date < :to_exclusive
)
SELECT m.*, o.opening_paise,
       o.opening_paise + SUM(m.movement_paise) OVER (ORDER BY m.date, m.voucher_id, m.line_id)
         AS running_balance_paise
  FROM movements m CROSS JOIN opening o
 ORDER BY m.date, m.voucher_id, m.line_id;
```

```sql
SELECT v.id AS voucher_id, v.date, v.type, v.ref, v.narration,
       vl.id AS line_id, vl.account_code, a.name AS account_name,
       vl.debit_paise, vl.credit_paise
  FROM vouchers v
  JOIN voucher_lines vl ON vl.voucher_id = v.id
  JOIN accounts a ON a.code = vl.account_code
 WHERE v.date >= :from AND v.date < :to_exclusive
 ORDER BY v.date, v.id, vl.id;
```

The day-book handler should group those rows in JavaScript into `{voucher_id, date, type, ref, narration, debit_paise, credit_paise, lines}` and assert each selected header's debit equals credit before serializing. Phase-3 credit-note vouchers must have a unique non-null `ref` equal to `credit_notes.client_ref`, avoiding the known null-ref misattribution class.

Closing-stock control/reconciliation

Do not choose either stock lots or account 1200 when they differ. `stock_lots` is the inventory subledger and physical FIFO valuation; account 1200 is the general-ledger control account used on the balance sheet. They must reconcile exactly, in paise. For a current report, use the direct lot balance and all posted 1200 movements through the same as-of instant:

```sql
WITH lot_value AS (
  SELECT COALESCE(SUM(cost_remaining_paise), 0) AS value_paise
    FROM stock_lots
), ledger_value AS (
  SELECT COALESCE(SUM(vl.debit_paise - vl.credit_paise), 0) AS value_paise
    FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
   WHERE vl.account_code = '1200' AND v.date < :to_exclusive
)
SELECT lot_value.value_paise AS fifo_stock_paise,
       ledger_value.value_paise AS stock_in_hand_paise,
       lot_value.value_paise - ledger_value.value_paise AS difference_paise
  FROM lot_value CROSS JOIN ledger_value;
```

For a historical `as_of`, replace `lot_value` with `SUM(value_delta)` from the stock-events CTE above, bounded by the same `:to_exclusive`. A nonzero difference is an integrity failure, not rounding: likely causes are a stock mutation outside the atomic document batch, a purchase/opening lot without its Stock voucher, an incorrect `none` return posting to Stock, a return allocation missing its lot/ledger pair, or a date-attribution bug for a copied-date new lot. Return `reconciled: false`, both figures, and the difference; do not silently overwrite a balance-sheet number from the lot table. This is a real control worth shipping because a balanced trial balance cannot detect a balanced-but-wrong Stock/COGS pair.

Implementation scope is intentionally report-only: no dashboard, no cached aggregates, no supplier-return register, and no stock-movement table. The immutable lots, allocations, return allocations, and double-entry rows already provide the necessary evidence; add a projected movement table only when another stock-mutating feature makes query cost or audit ergonomics demonstrably inadequate.

## Endpoints

- `GET /reports/trial-balance?from=YYYY-MM-DD&to=YYYY-MM-DD — raw debit/credit movement control report; reuse trialBalance() after its upper-bound semantics are made exclusive.`
- `GET /reports/profit-loss?from=YYYY-MM-DD&to=YYYY-MM-DD — period revenue, COGS, gross profit, operating expenses, and net profit in paise.`
- `GET /reports/balance-sheet?as_of=YYYY-MM-DD — closing assets, liabilities, equity, unclosed earnings, control total, and opening/movement/closing account rolls.`
- `GET /reports/sales-register?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=…&cursor=… — invoices and credit notes as signed commercial documents, retaining GST-adjustment status and original-invoice linkage.`
- `GET /reports/purchase-register?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=…&cursor=… — supplier purchases, input GST, payment mode, and the actual cost added to inventory.`
- `GET /reports/stock?as_of=YYYY-MM-DD — FIFO stock subledger: opening, movements, closing quantity/value, plus an inventory-control reconciliation against account 1200.`
- `GET /reports/cash-book?from=YYYY-MM-DD&to=YYYY-MM-DD — opening cash, cash receipts/payments, voucher references, and running cash balance; the same query can later parameterize 1010 for a bank book.`
- `GET /reports/day-book?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=…&cursor=… — chronological voucher headers with balanced debit/credit lines.`
- `GET /reports/integrity/stock?as_of=YYYY-MM-DD — explicit lot/subledger versus Stock in Hand control-account check; return the figures even when reconciled is false so the accountant can investigate.`

## Files

| Path | Change | What |
|---|---|---|
| `C:\Users\swastika\OneDrive\Desktop\pos-hybrid\worker\src\ledger.js` | modify | Extract a shared account roll-forward query beside trialBalance(), add report-facing normal-balance helpers, and extend ACC with 5100 and 5910. Keep trialBalance() as the raw debit/credit control report. |
| `C:\Users\swastika\OneDrive\Desktop\pos-hybrid\worker\src\reports.js` | new | Implement the bounded P&L, balance sheet, sales/purchase/stock registers, cash book, day book, and inventory-control reconciliation queries without putting report SQL into the route file. |
| `C:\Users\swastika\OneDrive\Desktop\pos-hybrid\worker\src\index.js` | modify | Add admin-only report routes, normalize Indian business-date query parameters into indexed half-open D1 timestamp bounds, and retain the existing trial-balance and stock routes as compatible aliases. |
| `C:\Users\swastika\OneDrive\Desktop\pos-hybrid\worker\test\reports.test.js` | new | Exercise roll-forward/P&L/balance-sheet reconciliation, lot-to-Stock-in-Hand reconciliation, credit-note effects, and period boundaries against real SQLite. |

## Tests

- A report fixture containing a purchase, goods sale, service sale, tax-adjusted original-lot credit note, financial/damaged credit note, and cash refund proves cumulative P&L net profit equals balance-sheet unclosed earnings and that Assets = Liabilities + Equity + unclosed earnings.
- A stock-control fixture proves FIFO lot value and account 1200 both close at the same paise amount after purchase, sale, original-lot return, new-lot return, and mode=none write-off; it fails if either side diverges.
- A credit-note register test proves every credit note is negative in commercial totals, only tax_adjusted=1 reverses GST-return tax columns, and a mode=none return creates no stock-in movement.
- A business-date boundary test proves a voucher at the start of the next India business day is excluded from the prior period; no report uses SQL DATE() or an inclusive end timestamp.
- A day-book and cash-book test proves every selected voucher remains balanced, refunds are cash payments, and the running balance equals opening plus period debit minus credit.

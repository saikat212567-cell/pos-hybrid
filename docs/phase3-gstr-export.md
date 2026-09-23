# GSTR-1/GSTR-3B portal JSON export specification

Produced 2026-09-23 by the phase-3 design workflow. This is the spec as
written by the agent, kept verbatim. It has not yet been implemented, and
nothing in it has been verified against a running system.

---

## Plan

Implement worker/src/gstr.js with pure builders for GSTR-1 and GSTR-3B. Export functions produce portal-ready JSON matching government schemas (v4.2). GSTR-1 builder reads sales, sale_lines, voucher_lines, settings, invoice_series. Credit notes (phase 3) will join the same ledger; for now include test stubs showing net aggregation. Core design: GSTR-1 sections b2cs (B2C unregistered), hsn_b2c (HSN/SAC summary), doc_issue (invoice series ranges), optionally cdnr (registered buyer credit notes). Composition/unregistered dealers refuse GSTR-1 with helpful error; regular dealers compute net taxable per (pos, rate) across ledger, not just sales. Use decimal-string paise conversion (never paise/100). Admin routes: GET /reports/gstr1?period=MMYYYY, GET /reports/gstr3b?period=MMYYYY, with same auth as other reports (needsAdmin: true). Export includes validation: HSN 2-8 digits, UQC letters-only, POS state codes, Inum length ≤16, charset, non-zero. GSTR-3B builder aggregates voucher_lines across accounts: 2100/2110/2120 for output tax, 1300/1310/1320 for ITC, 4000/4100 for taxable revenue. Do not clamp negative net outward figures; preserve net-negative rows per official schema. SQL includes CTEs for net taxable/tax per (pos, rate), ITC summary, etc. No database migration needed—existing tables suffice.

## Endpoints

- `GET /reports/gstr1?period=MMYYYY (admin)`
- `GET /reports/gstr3b?period=MMYYYY (admin)`

## Files

| Path | Change | What |
|---|---|---|
| `C:/Users/swastika/OneDrive/Desktop/pos-hybrid/worker/src/gstr.js` | new | Pure GSTR-1 and GSTR-3B builders. Functions: paiseToRupees(n), periodParts(MMYYYY), b2csRows(db, settings, period), hsnRows(db, settings, period), docIssueRows(db, settings, period), cdnrRows(db, period), gstr1(env, period), gstr3b(env, period). Validate HSN, UQC, POS, Inum. Composition/unregistered early exit. |
| `C:/Users/swastika/OneDrive/Desktop/pos-hybrid/worker/src/index.js` | modify | Add admin routes /reports/gstr1 and /reports/gstr3b. Integrate with existing route pattern, token check. Query param period=MMYYYY, default current month. Validate period format, call gstr.js builders. Return JSON envelope {gstin, fp, data, validation}. |
| `C:/Users/swastika/OneDrive/Desktop/pos-hybrid/worker/test/gstr.test.js` | new | Unit tests for paise conversion, net aggregation, HSN/UQC validation, period formatting, composition refusal, schema whitelist. Mock DB results covering edge cases: negative net taxable, malformed HSN, IST crossing. |

## Tests

- paiseToRupees(2510) yields 25.10 as JSON number (not float)
- b2cs rows aggregate net taxable across sales and credit notes
- HSN rows require tax_code 2-8 digits, unit letters-only
- doc_issue ranges reflect invoice_series(series,fy) and credit_note_series
- composition dealer returns 422 with CMP-08 reason
- GSTR-3B net taxable (osup_det.txval) equals ledger net
- GSTR-1 periods use MMYYYY, not YYYY-MM
- b2cs.txval signed (allows negative) per schema
- cdnr rows only when customer_gstin not null and credit note exists
- malformed place_of_supply (non-GST code) preflight fails

## Open questions — these need a decision

- Credit note series naming: 'CN' prefix? Incorporate into invoice_series table as separate series? Phase 3 will add migration 0004 and settings credit_note_series.

# Roadmap — from POS to Indian bookkeeping software

Written 2026-09-23. Combines the functional specification for Indian
double-entry bookkeeping software with the actual state of this repo.

[HANDOFF.md](HANDOFF.md) is the working status document: what is built, what is
verified, what to do next. **Read that first.** This file is the longer arc —
where the spec's scope sits against what exists, and in what order to close the
gap.

---

## The honest position

The spec describes a Tally-class ERP: multi-godown inventory, batch and serial
tracking, projects and timesheets, e-invoicing, TDS, party masters with MSME
interest, bank-statement AI extraction, geofenced party selection, RBAC, MFA,
VAPT.

What exists is a **correct double-entry POS core**. That is a smaller thing, but
it is the part everything else must sit on, and it is the part most easily got
wrong. Measured against the spec's own phasing (§13), the position is:

| Spec phase | Status |
|---|---|
| **1 — Core ledger, CoA, sales/purchase invoice, GST, simple inventory, cash/bank** | **Substantially done.** Ledger, chart of accounts, GST engine, FIFO inventory, sales, purchases, bills. |
| **2 — Multi-payment modes, returns/credit notes, damage/ITC reversal, GSTR** | **In progress.** Payment modes exist as a field; returns are designed but not built; ITC reversal and GSTR export not started. |
| **3 — Service module: projects, timesheets, milestone/recurring billing, WIP** | **Not started.** Services exist as a line-item kind; none of the project apparatus does. |
| **4 — E-invoicing, e-way bill, TDS, multi-godown, batch/serial** | **Not started.** |
| **5 — Advanced reporting, budgeting, audit trail, RBAC, offline sync** | **Partial.** Offline sync is done and is a genuine strength. Audit trail and RBAC absent. |
| **6 — Party module, security hardening, VAPT** | **Not started.** No party master exists. |
| **7 — AI features** | **Not started.** |

So: roughly **spec phase 1 complete, phase 2 underway.** Everything from phase 3
on is greenfield. Anyone reading the spec and this repo together should not
expect them to be close yet.

---

## What is actually built and verified

12 tables: `accounts`, `vouchers`, `voucher_lines`, `products`, `stock_lots`,
`cogs_allocations`, `sales`, `sale_lines`, `purchases`, `purchase_lines`,
`invoice_series`, `settings`.

17 routes. 187 worker tests and 34 Android tests, all passing.

**Against the spec's technical requirements (§8), what already holds:**

- **Ledger-first design (§8).** Every sale and purchase posts a balanced journal
  entry; `buildVoucher()` throws unless debits equal credits. No module writes
  stock or revenue without a voucher.
- **Decimal precision, never float (§8).** Integer paise everywhere, with one
  rounding helper. This is enforced by tests that assert exactness, not
  approximation.
- **Voucher numbering, gapless, FY-scoped (§8).** Per-device series
  (`A/26-27/0001`), assigned inside the same transaction as the sale so a
  rolled-back duplicate cannot consume a number.
- **FIFO valuation, Ind AS 2 (§3.2).** Lots store cost remaining rather than a
  unit cost, so total COGS over a lot's life equals its purchase cost exactly.
  LIFO is not implemented, correctly — Ind AS 2 forbids it.
- **Hybrid invoices (§5).** One invoice already mixes stock items and services
  with the GST rate applied per line, and revenue split to separate accounts so
  the P&L can show goods against services.
- **Offline-first with sync-on-reconnect (§8).** Android writes every sale to
  Room first and drains via WorkManager; a device-generated `client_ref` is the
  primary key, so a retry cannot double-charge.
- **Parameterized queries only (§10.2).** No raw SQL string concatenation of user
  input.
- **Idempotency keys on invoice creation (§10.2).** That is what `client_ref` is.

**What the spec asks for that is deliberately deferred, with reasons:**

- **Multi-currency (§2).** A single-shop Indian POS transacts in rupees. Adding
  Ind AS 21 revaluation before a single customer needs it would be cost with no
  return.
- **Weighted average as an alternative to FIFO (§3.2).** FIFO is implemented and
  proven. A second valuation method doubles the surface area of the most delicate
  arithmetic in the system.
- **Multi-godown (§3.2).** One shop, one location. The schema does not preclude
  it: `stock_lots` would gain a `godown_id`.

---

## Known gaps the spec exposes

Reading the spec against the code surfaced real omissions, beyond simply
"unbuilt features". These are recorded because they change existing code rather
than adding to it.

**1. No audit trail.** §8 and §10.2 require every edit and delete logged with
user, timestamp, and before/after value — mandatory under MCA's 2023 rule. There
is no `audit_log` table and no user identity to attribute a change to. Today a
`PATCH /items/:id` overwrites silently. This is a compliance gap, not a feature
request.

**2. No user identity or RBAC.** §10.2 wants role-based access enforced
server-side. The system has two tokens (till and admin) and no concept of a
person. An audit trail is impossible without fixing this first, so they are one
piece of work.

**3. No rate-history tables.** §8: "a June invoice must use the rate that was
valid then, even if rates changed later." `products.gst_rate_bps` is a single
current value. Editing it today changes nothing historical — invoices copy the
rate onto `sale_lines`, which is right — but a *reprint* of an old bill reads
current settings for the document type, which the concurrent review flagged as a
real bug. Date-effective rates would close the whole class.

**4. No ITC reversal on damage or write-off.** §3.6 calls this critical:
Section 17(5)(h) requires reversing input tax credit already claimed on damaged,
lost, stolen, or free-sample goods. There is no write-off voucher at all, so
stock can only leave by being sold. A shop with spoiled goods has no correct way
to record it.

**5. No party master.** §9 is an entire module. Sales record an optional
`customer_gstin` string and nothing else — no party ledger, no receivables
aging, no statements. `accounts` has Sundry Debtors as a single lump, so a credit
sale is tracked in total but not per customer. This blocks receivables reporting
entirely.

**6. Advance payments have nowhere to go.** §6 requires an advance booked as a
liability and later adjusted, with GST on advances for services under the
time-of-supply rules. There is no such account and no adjustment mechanism.

**7. Split payments are impossible.** §6 wants one invoice settled across
multiple modes. `sales.payment_mode` is a single column, so "₹5,000 cash +
₹15,000 UPI" cannot be recorded.

---

## Build order

The sequencing principle throughout has been: **make the ledger correct before
building anything that reads from it.** A report on wrong books is worse than no
report, because it is believed.

### Immediate — finish what is in flight

1. **Fix the confirmed review findings.** A nine-dimension adversarial review of
   the phase-2 code raised 24 findings. **Eleven are fixed and locked with
   regression tests** (201 worker tests, all passing) — see HANDOFF.md for the
   list. One is deliberately open: `billHtml` reads *current* registration when
   reprinting an old bill, and the fix is the registration snapshot that the
   phase-3 schema already introduces, so it is folded into that work.
2. **Refunds and credit notes** (§3.5, §4.4). **Designed, not built** —
   [docs/phase3-refund-design.md](docs/phase3-refund-design.md) and
   [docs/phase3-clients.md](docs/phase3-clients.md). Stock-return behaviour is a
   setting (`original_lot` / `new_lot` / `none`), because a grocer, a pharmacy and
   a repair shop genuinely differ. Cost is restored to the exact lot it came from
   using the same remainder rule that took it out, so a returned unit leaves the
   lot bit-identical to its pre-sale state. Over-return is blocked by
   `CHECK (>= 0)` counters — the same mechanism that already prevents overselling.
3. **GSTR-1 and GSTR-3B portal JSON** (§7 Tax/Compliance). **Designed** —
   [docs/phase3-gstr-export.md](docs/phase3-gstr-export.md). Needs no migration:
   the existing tables suffice. Credit notes flow into `cdnr`/`cdnur`, so returns
   come first. Note the paise-to-JSON conversion must avoid float division, and
   composition dealers file CMP-08 instead, so the route refuses them.
4. **Reports** (§7 Financial): P&L, balance sheet, registers, day book, cash book.
   **Designed** — [docs/phase3-reports.md](docs/phase3-reports.md), 9 endpoints.

### Next — the compliance floor

5. **User identity, RBAC, and the audit trail** (§8, §10.2) as one piece. This is
   the largest gap that is a legal requirement rather than a convenience, and
   retrofitting attribution onto existing rows is harder the longer it waits.
6. **Damage / write-off voucher with automatic ITC reversal** (§3.6). Needs the
   write-off account and the Section 17(5) calculation.
7. **Party master and party ledger** (§9.1, §9.2). Unlocks receivables aging,
   statements, and party-wise profitability. Sundry Debtors becomes a
   sub-ledger per party.
8. **Payment modes properly** (§6): split payments, advances as a liability,
   partial payment against an invoice.

### Then — breadth

9. **Service module** (§4): projects, timesheets, WIP, milestone and recurring
   billing. Substantial, and it is what the spec notes Tally and Busy do weakly —
   so it is where a new product can actually differentiate.
10. **E-invoicing and e-way bill** (§3.3): only once turnover thresholds make them
    mandatory. Both need a GSP/ASP integration.
11. **TDS** (§4.3, §6): receivable tracking and Form 26AS reconciliation.
12. **Multi-godown, batch, serial, expiry** (§3.1, §3.2): each is a schema
    extension to `stock_lots`.

### Later — the differentiators

13. **Ease-of-use features** (§9.3). Some are cheap and high-value now:
    WhatsApp invoice sharing is nearly free given bills already render and
    Android already shares via the OS sheet. A dashboard, smart auto-suggest, and
    bulk CSV import are modest work with real daily payoff.
14. **Security hardening** (§10): MFA, certificate pinning, encryption at rest,
    field-level encryption for PAN and bank details, WAF, then VAPT before public
    launch. Note the spec's own framing — no internet-connected system is
    unhackable; the goal is hard to attack, fast to detect, limited in damage.
15. **AI features** (§12): bank-statement extraction and reconciliation is the
    highest-value one for a real bookkeeper's day. Geofenced party selection only
    matters once there are field sales reps and a party master to geofence.

---

## Two rules to carry forward

**Everything configurable stays a setting.** The existing code has no hardcoded
tax rate, state code, pricing mode, or registration type — and stock-return
behaviour joins them. This is why one build can serve the spec's product,
service, and hybrid businesses (§1) without branching into three products.

**Nothing bypasses the ledger.** The spec says it in §8 and it has held so far:
every module is a front-end that generates journal entries. The moment a report
or an import writes stock or revenue directly, the books stop being trustworthy
and no test will tell you.

One caution from experience on this codebase: **a balanced trial balance does not
mean correct books.** A bug found this week misattributed two purchases' ledger
lines to the same voucher, and the trial balance still netted to zero throughout.
Aggregate checks cannot catch misattribution. Per-document assertions can.

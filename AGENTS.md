# AGENTS.md — Indian Bookkeeping Software (Ledger-First, GST-Compliant)

Read this file fully at the start of every session. The product spec lives at `docs/SPEC.md`
(the "Indian Double-Entry Bookkeeping Software — Functional Specification").
This file tells you HOW to work. The spec tells you WHAT to build. Where they conflict, stop and ask.

Your job is not to write code fast. Your job is to ship **small, correct, verified, reviewable changes**
in a system where **wrong numbers are worse than missing features**.

---

## 0. Core Principles

1. **Ledger first.** No feature may bypass the double-entry engine.
2. **Verify, don't assume.** Read code before changing it. Run code after changing it.
3. **Small steps.** One logical change at a time.
4. **Evidence over confidence.** "Done" means a command ran and passed.
5. **Match the codebase.** Follow existing patterns.
6. **Stay in scope and in phase.** Build only the current phase (Section 3).
7. **Be honest about tax and accounting.** If a GST/TDS/Ind AS rule is unclear, do not guess (Section 6).
8. **Money never moves silently.** Anything AI-generated is propose-and-confirm.

---

## 1. Project Facts (FILL THESE IN)

| Item | Value |
|---|---|
| Backend language / framework | `<e.g. Python 3.12 + FastAPI>` |
| Database | `<e.g. PostgreSQL 16>` |
| Frontend / mobile | `<e.g. React + React Native>` |
| Package manager | `<pnpm / uv / npm>` |
| Install | `<command>` |
| Run (dev) | `<command>` |
| Test (all) | `<command>` |
| Test (single file) | `<command>` |
| Lint / format | `<command>` |
| Type check / build | `<command>` |
| Migrations | `<command>` |
| Main branch | `<main>` |
| Architecture summary | `<folders, layers, module boundaries>` |
| **Never touch** | `<applied migrations, generated code, vendor, .env, docs/SPEC.md unless asked>` |
| **Needs approval** | `<new deps, schema changes, posting-logic changes, public API changes, deleting files>` |

If a command is missing or fails, tell me. Do not guess commands.

---

## 2. Session Start Routine

1. Read this file, `docs/SPEC.md` sections relevant to the task (see Section 4), and `PROGRESS.md`.
2. Run `git status` and `git log --oneline -10`.
3. Confirm you are on the correct branch (Section 12). Never work on `main`.
4. Run the full test suite once to record the **baseline**. Note pre-existing failures.
5. Confirm which **phase** is active (Section 3).

---

## 3. Phase Discipline (from spec Section 13)

Build in this order. Work only on the **current phase** listed in `PROGRESS.md`.

| Phase | Scope |
|---|---|
| 1 (MVP) | Core ledger, chart of accounts, basic sales/purchase invoice, GST calc, simple inventory, cash/bank payment |
| 2 | Multi-payment modes, returns / credit-debit notes, damage + ITC reversal, GSTR reports |
| 3 | Service module: projects, timesheets, milestone/recurring billing, WIP |
| 4 | E-invoice, e-way bill, TDS automation, multi-godown, batch/serial |
| 5 | Advanced reporting, budgeting, audit hardening, RBAC, offline sync |
| 6 | Party module, WhatsApp, full security hardening, VAPT |
| 7 | AI features (bank statement extraction, geofencing, OCR, forecasting) |

Rules:
- Do not build later-phase features early, even if "easy."
- **Do** design schemas and interfaces so later phases are not blocked (for example, include `company_id`, `gstin_id`, `cost_center_id`, and effective dates from day one).
- If a task needs a later-phase capability, stop and ask.

---

## 4. Spec Navigation (read only what the task needs)

| If the task involves... | Read these spec sections |
|---|---|
| Ledger, accounts, journal entries | 2, 8 |
| Items, stock, valuation, GRN, godowns | 3.1, 3.2, 3.4 |
| Sales invoice, GST split, e-invoice | 3.3, 5, 8 |
| Returns, credit/debit notes | 3.5, 4.4 |
| Damage, loss, write-off, ITC reversal | 3.6 |
| Services, timesheets, WIP, revenue recognition | 4 |
| Hybrid invoices (stock + service lines) | 5 |
| Payments, split payment, PDC, TDS receipt | 6 |
| Reports | 7 |
| Parties, statements, reminders | 9 |
| Auth, encryption, security | 10 |
| AI features | 12 |

Known spec issue: Section 3.2 "Stock in / Stock out" bullets are muddled about returns
(sales return brings stock **in**; purchase return sends stock **out**; a "sales return to vendor" does not exist).
Follow Section 3.5 as the correct definition. Flag anything else that looks contradictory.

---

## 5. Non-Negotiable Domain Rules

These come from the spec. Breaking any of them is a bug, even if tests pass.

### 5.1 Ledger and data integrity
- **Ledger-first:** inventory, sales, service, and payment modules only generate journal entries. They never write balances directly.
- **Double-entry invariant:** for every journal entry, total debits = total credits. Enforce in code **and** a database constraint or check.
- **Immutability:** posted entries are never edited or deleted. Corrections use reversal entries or credit/debit notes.
- **Decimal only:** never float for money or quantity. Use fixed-scale decimal/numeric types. Define rounding rules in one place and reuse them.
- **Voucher numbering:** sequential, gap-free, scoped per financial year and series, allocated inside the same transaction as the posting.
- **Audit trail:** every edit/delete logs user, timestamp, and before/after values. Prefer soft delete. Respect financial-year lock.
- **Date-effective rates:** GST rate, TDS rate, and price lists live in history tables with effective dates. A document uses the rate valid on its own date, not today's.
- **Tenant isolation:** every query is scoped by company/GSTIN. Every new query needs a cross-tenant leakage test.
- **RBAC on the server:** never trust roles or permissions sent from the client.

### 5.2 GST and stock
- GST is calculated **per line**, not per invoice (hybrid invoices mix HSN goods and SAC services).
- Intra-state: CGST + SGST. Inter-state: IGST. Derive from place of supply, not user choice.
- Sales return → credit note: reduces receivable, reverses output GST, adds stock back.
- Purchase return → debit note: reduces payable, reverses input GST, removes stock.
- **Damage / loss / theft / free sample:** separate voucher type, never a sale or purchase. Must auto-calculate and post **ITC reversal** (spec 3.6, Section 17(5)(h)).
- Stock valuation: FIFO or weighted average only. **LIFO is not allowed.**
- Stock updates at **GRN**, not at purchase invoice. Purchase invoice approval uses 3-way match (PO, GRN, invoice).
- Landed cost (freight, customs, insurance) is allocated across items by value or weight.

### 5.3 Services, payments, TDS
- Revenue recognition follows Ind AS 115 logic: unbilled revenue and deferred revenue ledgers.
- Advances are booked as liabilities until adjusted.
- TDS-adjusted receipt splits into Bank Dr + TDS Receivable Dr against the **full** invoice value.
- Split payments settle one invoice across multiple modes.
- Payment and invoice-creation APIs require **idempotency keys** so retries never duplicate transactions.

### 5.4 Compliance thresholds are configuration, not code
E-invoice turnover limits, e-way bill value limits, TDS rates and sections, and GST rates change over time.
Store them in date-effective config tables. Never hardcode them.

### 5.5 AI features (Phase 7)
- Propose-and-confirm only. Never silently post anything that touches money.
- Keep the audit trail intact for AI suggestions and user overrides.
- Location tracking is opt-in, disclosed, and limited to the sales-rep role (DPDP Act, 2023).

---

## 6. Handling Tax and Accounting Uncertainty

You are not a chartered accountant. When a rule is unclear or a threshold is unknown:
1. Do not invent a rule or number.
2. Implement the behavior behind configuration where possible.
3. Add the question to `PROGRESS.md` under "Open Compliance Questions" and list it in your report.
4. Ask me to confirm with a CA before treating it as correct.

---

## 7. Task Sizing

| Size | Description | Process |
|---|---|---|
| Tiny | One-line fix, typo | Do it, verify, commit. |
| Small | One function, one file | Short plan, test, implement, verify. |
| Medium | 2-5 files, one feature/bug | Full plan, approval, loop per step. |
| Large | New module, migration, posting-logic change | Stop. Split into medium tasks. Get approval. |

**Any change to posting logic, numbering, tax calculation, or schema is at least Medium.**

---

## 8. The Main Loop

### Step 1 — Understand
- Restate the task in 2-3 sentences and name the phase and spec sections involved.
- Read relevant code, callers, and tests. Find the closest existing example to imitate.
- Ambiguous? Ask at most 3 focused questions. Otherwise state assumptions.

### Step 2 — Plan
```
GOAL:
PHASE / SPEC SECTIONS:
ASSUMPTIONS:
FILES TO CHANGE (and why):
JOURNAL ENTRIES POSTED (Dr/Cr, if any):
STEPS (max 7, each verifiable):
RISKS / EDGE CASES:
OUT OF SCOPE:
```
Wait for approval on Medium/Large tasks.

### Step 3 — Define "Done" (tests first)
- Write acceptance criteria as checkable statements.
- Write a failing test first. Confirm it fails for the right reason.
- For bugs, write a reproducing test first.

### Step 4 — Implement one step
- Only what the current step needs. No drive-by refactors.
- Boring, readable code. No new dependencies without approval.
- Any code that posts entries goes through the ledger service. No shortcuts.

### Step 5 — Verify (Verification Ladder)
1. Build/syntax
2. Targeted tests
3. Domain checks (Section 9)
4. Full suite vs baseline
5. Lint and format
6. Type check
7. Run the real flow when possible

Never claim success without a passing run. Never weaken or delete a test. Never hardcode outputs.

### Step 6 — Self-review
Review `git diff` line by line with the Section 10 checklist. Fix, then re-run Step 5.

### Step 7 — Checkpoint and small push
- Commit only this step's files (`git add <paths>`).
- Push after verification passes.
- Update `PROGRESS.md`.

### Step 8 — Final report (Section 14)

---

## 9. Domain Verification Checks

For any change touching money, run or add tests for the relevant items:

- [ ] Sum of debits equals sum of credits for every posted entry
- [ ] Trial balance still balances after the scenario
- [ ] Expected journal entries (exact accounts and amounts) match for the transaction
- [ ] GST split is correct: intra-state CGST+SGST, inter-state IGST, per-line rates
- [ ] Rounding is consistent and uses the shared rule
- [ ] Rate change on a later date does not alter an earlier-dated document
- [ ] Voucher numbers stay gap-free and unique under concurrent requests
- [ ] Credit/debit note fully reverses GST and stock effects
- [ ] Damage voucher posts ITC reversal
- [ ] Edit or delete writes an audit log entry; locked-year edits are rejected
- [ ] Cross-tenant query returns nothing for another company
- [ ] Retried request with the same idempotency key creates no duplicate
- [ ] Amounts use Decimal end to end (API, DB, calculations, JSON serialization)

---

## 10. Self-Review Checklist

**Correctness:** meets acceptance criteria; edge cases (zero, negative, empty, huge, duplicate, unicode); failure paths.
**Accounting:** balanced entries, immutability kept, correct accounts, correct effective-dated rates.
**Security:** no secrets in code, logs, or commits; input validated server-side; parameterized queries only; no raw SQL concatenation; PAN and bank details not logged; least privilege.
**Maintainability:** matches patterns; no duplicated logic; no dead code, debug prints, or stray TODOs; comments explain why.
**Scope:** only requested changes; no new dependency; backward compatible where needed.

---

## 11. Debugging Protocol

1. Reproduce reliably with a minimal case.
2. Read the full error and quote the key line.
3. State a hypothesis.
4. Probe with the smallest check. Do not change logic yet.
5. Fix the root cause, not the symptom.
6. Add a regression test.
7. Re-run the Verification Ladder.

For "numbers don't match" bugs: check the trial balance first, then the journal entries, then the source voucher.
Never fix a wrong balance by editing posted entries. Post a correction.

---

## 12. Git and Push Rules

Branches (never push to `main`, `master`, or `production`):

| Work | Branch |
|---|---|
| Feature | `feat/<phase>-<name>` (e.g. `feat/p2-credit-notes`) |
| Bug fix | `fix/<name>` |
| Refactor | `refactor/<name>` |
| Docs | `docs/<name>` |
| Tests | `test/<name>` |
| Chore | `chore/<name>` |

- One logical change per commit, one commit per plan step. Format: `type: short imperative description`.
- Stage explicit paths. Check `git status` and `git diff --staged` first.
- Push small, after every verified step, to the correct branch.
- Pull/rebase if the remote moved, then re-verify.
- Never force push without approval.
- Keep schema migrations in their own commits, and never edit a migration that has already been applied.
- Unrelated problems go on their own branch or in the report.
- Open a PR when the plan is complete:

```
## What
## Why (phase + spec section)
## Journal entries affected
## How verified
## Compliance questions / risks
```

---

## 13. Stuck Rules

- Same error twice: stop, re-read, state a new hypothesis.
- Three failed attempts: stop and report what you tried and what you need.
- Unclear requirement, or spec conflicts with this file: ask.
- Unknown library or API: check docs or source. Never fabricate.
- Scope creep or wrong phase: stop and propose a split.
- Context feels long: update `PROGRESS.md`, summarize state, suggest a fresh session.

---

## 14. Communication

During work: brief status only.

Final report:
```
DONE:
PHASE / SPEC SECTIONS:
CHANGED (files + reason):
JOURNAL ENTRIES / TAX LOGIC AFFECTED:
VERIFIED (exact commands + results):
ASSUMPTIONS:
OPEN COMPLIANCE QUESTIONS:
LIMITATIONS / FOLLOW-UPS:
DECISIONS NEEDED FROM YOU:
```

Concise, no filler. Say "I don't know" when you don't.

---

## 15. Hard Rules

1. Never commit or push secrets, keys, tokens, or `.env` files.
2. Never run destructive commands (`rm -rf`, `git push --force`, `git reset --hard`, DB drops/truncates) without approval.
3. Never modify "Never touch" paths.
4. Never push to `main`/`master`/`production`.
5. Never bypass the ledger or edit posted entries.
6. Never use float for money or quantity.
7. Never hardcode tax rates, thresholds, or limits.
8. Never claim something works without running it.
9. Never weaken or delete tests to get green.
10. Never invent APIs, files, tax rules, or results.
11. Never build outside the current phase without asking.
12. Always disclose assumptions and open compliance questions.

---

## 16. Pre-Push Checklist

- [ ] Task in scope and in the current phase
- [ ] Failing test written first, now passing
- [ ] Domain checks (Section 9) done for anything touching money
- [ ] Full suite matches baseline
- [ ] Lint, format, type check clean
- [ ] Diff self-reviewed
- [ ] No secrets, debug code, or unrelated changes
- [ ] Right branch, right commit message, explicit paths staged
- [ ] `PROGRESS.md` updated

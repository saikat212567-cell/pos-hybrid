# Resume here

Last session: 2026-09-23. Everything below is committed.

**Read in this order:** this file, then [HANDOFF.md](HANDOFF.md) for detailed
status, then [ROADMAP.md](ROADMAP.md) for the long arc.

---

## Where things stand

A working, correct double-entry POS for Indian retail and services. Phase 1 and
phase 2 are built and verified; phase 3 is designed but not built.

- **202 worker tests** and **34 Android tests**, all passing.
- **12 tables, 17 routes.** ~9,000 lines across worker, web and Android.
- Roughly **12% of the 154 features** in the functional spec — but the hardest
  and most structural parts are done, so nearer 25–30% of the total effort.

**The Android APK compiles and its tests pass, but it has never run on a
phone.** That check is still outstanding.

---

## Start the day with this

```bash
cd worker
npm install                 # first time only
npm run migrate:local       # applies 0001, 0002, 0003
npm run dev:test            # shell 1 — local Worker on :8801
npm test                    # shell 2 — expect 202 passing
```

Two shells because killing wrangler's process tree from node on Windows hangs the
test runner. `npm run test:unit` needs no server.

Android (JDK, Gradle and SDK are installed under `C:\Users\swastika\tools\`):

```bash
export JAVA_HOME="/c/Users/swastika/tools/jdk-17.0.20.1+1"
export ANDROID_HOME="/c/Users/swastika/tools/android-sdk"
cd android
/c/Users/swastika/tools/gradle-8.9/bin/gradle assembleDebug test \
  -PbuildOut=C:/Users/swastika/tools/pos-build --no-daemon
```

`-PbuildOut` matters: this repo sits under OneDrive, which holds file handles open
while syncing and makes Gradle fail with `Unable to delete directory`. Building
outside the synced tree avoids it.

---

## Next, in order

1. **Build phase 3 refunds and credit notes.** Fully designed in
   [docs/phase3-refund-design.md](docs/phase3-refund-design.md) — the
   allocation-rewind approach, which won on all three judge lenses. Migration
   `0004_refunds.sql`. Stock-return behaviour is a setting: `original_lot`
   (default), `new_lot`, `none`.

   The design asks for three small refactors first, all worth doing:
   - export `divRound()` from `gst.js` and import it in `fifo.js` (it exists twice)
   - export `settlementAccount()` from `ledger.js` — **already done**
   - add accounts 5100 Goods Written Off and 5910 GST Not Recoverable

2. **GSTR-1 / GSTR-3B export.** [docs/phase3-gstr-export.md](docs/phase3-gstr-export.md).
   Needs no migration. Credit notes feed `cdnr`/`cdnur`, so refunds come first.

3. **Reports.** [docs/phase3-reports.md](docs/phase3-reports.md), 9 endpoints:
   P&L, balance sheet, registers, day book, cash book.

4. **Install the APK on a real phone** and check what only hardware shows: tile
   images, a barcode scanner typing into the entry field, thermal printing, the
   share sheet. `adb` is at `tools\android-sdk\platform-tools`. The build needs
   `-PapiBase=... -PapiToken=...` or the app cannot reach the server.

5. **Then the compliance floor** — user identity, RBAC and the audit trail as one
   piece. This is the largest gap that is a legal requirement (MCA 2023) rather
   than a convenience, and retrofitting attribution onto existing rows only gets
   harder.

---

## Two things left unfinished

**An extensibility-seams workflow was still running.** Eight agents mapping every
spec section against the code to decide which structural choices must be made
*before* production data exists versus which can safely wait. It never reported
back, so its output is lost — re-run it if the ordering question matters. That
was the direct answer to "add flexibility to implement new features later".

**One confirmed review finding is deliberately open.** `billHtml` derives the
document type from *current* settings rather than what the sale was recorded
under, so switching registration retroactively reprints old tax invoices as
tax-free documents whose totals still contain the collected tax. The fix is to
snapshot `registration` on the sale row — which the phase-3 credit-note schema
already does — so it is folded into that work rather than half-fixed now.

---

## Things that will bite you if you don't know them

**Money is integer paise.** `divRound(n, d) = floor((n + floor(d/2)) / d)` is the
only rounding. No float goes near money.

**A stock lot stores cost remaining, not unit cost.** Buy 3 for ₹10 and the unit
cost is 333.33 paise, which no integer column holds. Taking `q` of `n` costs
`divRound(cost_remaining * q, n)`, and the last unit takes the remainder, so total
COGS over a lot's life equals its purchase cost exactly. This is the most delicate
arithmetic in the system.

**FIFO is `ORDER BY received_at, id` — ascending.** Ind AS 2 forbids LIFO. During
the last session this line was briefly `DESC` and the test named *"consumes the
oldest lot first"* still passed, because the test mock hardcoded an ascending sort
instead of honouring the real query. That mock is fixed and now fails on `DESC` —
but treat it as a warning about mocks generally.

**A balanced trial balance does not mean correct books.** A bug found this session
misattributed two purchases' ledger lines to the same voucher and the trial
balance still netted to zero throughout. Aggregate checks cannot catch
misattribution; per-document assertions can.

**Nothing bypasses the ledger.** Every module generates journal entries.
`buildVoucher()` throws unless debits equal credits.

**Two tokens, deliberately.** The till token is public by design — it sits in
`web/config.js` and is extractable from the APK — and opens only catalog-read and
sale-insert. The admin token gates the books and the tax settings and must never
appear in a URL (it did, in every admin thumbnail; that is fixed).

**Concurrency is CHECK constraints, not locking.** Two tills selling the last unit
both pass the availability read; the loser drives a remainder negative, the CHECK
fires, the batch rolls back, and the client gets a retryable 409.

---

## Known data issue

The local test D1 holds rows created while reproducing bugs: a few sales with
malformed `place_of_supply` (`"nineteen"`, `"1 9"`, `"019"`), and five purchase
vouchers with zero ledger lines from the null-ref bug. Validation now prevents
new ones, but **the GSTR export would emit those invalid values into a filed
return**, so they need cleaning before the first real filing. Production is
unaffected — this is test data only.

---

## Before deploying

```bash
cd worker
npx wrangler r2 bucket create pos-images   # phase 2 needs this, once
npm run migrate                             # --remote
npm run deploy
```

Then set the shop's identity, because the defaults are placeholders and they
decide what every invoice says: `legal_name`, `gstin`, `state_code`,
`gst_registration`, `price_mode`, `invoice_series`. See HANDOFF.md for the curl.

Paste your `POS_TOKEN` into `web/config.js` locally. The committed value is the
placeholder `YOUR-POS-TOKEN` — keep it that way in git.

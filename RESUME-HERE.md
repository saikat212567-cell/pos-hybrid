# Resume here

Current checkpoint: **2026-10-03**, branch **`fix/refund-reversal-foundation`**. Live `/items` has returned HTTP 200 with catalog JSON using the newly rotated POS token; update Codemagic and rebuild the APK.

Android version metadata now lives in `android/version.json` (versionCode 2,
versionName 1.0.1; app ID remains `com.example.pos`). The next Codemagic run prints
the debug signing fingerprint. Compare it with the existing APK before upgrading;
never uninstall the old app to bypass a signature mismatch while offline sales
may be queued. GitHub Android run `37116201697` passed tests and debug assembly.
APK inspection found the installed-release candidate `app-debug.apk` is code 1
with signer SHA-256 `7b4d8e7b...`; two code-2 APKs have different signers from
each other and from the old app. Local default debug keystore is also different.
Do not install/uninstall. Find the original private keystore to retain upgrade
compatibility; otherwise make an explicit side-by-side/data-export plan.
`sts-permanent.keystore` belongs to the user's separate `SankarTeaShop` app and
must not be used for POS. Codemagic Code signing identities could not be inspected
because the browser session was unauthenticated. Owner should check the POS app's
Code signing identities and compare to `7b4d8e7b...`; never share passwords/keys.

## Exact verified continuation point — read this before coding

The admin-only commercial refund flow is implemented and verified in `af7390e`.
The implementation and mobile layout fix are committed and pushed. A full admin
refund browser flow passed against isolated local D1; details are recorded in
the current handoff in `PROGRESS.md`.

The atomic `POST /credit-notes` writer repair is present in committed `f9dff91` and
the new admin-only client flow extends it without exposing refund data to till
credentials. Do not redo the writer; review follow-up against the remaining
GST/history/ITC policy limits before changing posting behavior.

1. Confirm branch and Git status; do not reset, stash, overwrite, or batch-stage inherited work.
2. Run the serverless baseline (`cd worker && npm run test:unit`, verified **244 passed**).
    Then establish a disposable local D1 with migrations **0001–0005 only** for the full baseline (verified **371 passed**).
3. Reuse tested `planReturn` in `worker/src/refunds.js` and `creditNoteVoucherLines` in `worker/src/ledger.js`.
   Do not use the placeholder writer/voucher/tax helpers in `refunds.js`; do not redo the completed foundation.
4. Preserve the current policy boundary: GST-adjusting notes and non-`original_lot` stock modes remain disabled pending reviewed
    evidence and CA confirmation. Any change requires a new bounded plan and approval.
5. Admin page browser verification is complete at desktop/mobile widths; do not
   repeat it. The catalog table now scrolls within its container on narrow screens.
6. **CA reminder:** resolve GST cutoff/annual-return rules, original-supply
   registration/date evidence, commercial credit-note treatment, and damage ITC
   reversal with a CA before enabling tax-adjusted notes or damage/write-off.
7. User wants username/password admin login when the site is live. The current
   admin page uses a `POS_ADMIN_TOKEN` gate, not username/password auth; leave
   credentials/deployment untouched until a reviewed server-auth plan is approved.
8. Android heavy builds should use standard GitHub-hosted Actions (repo is
   public), which already passed run `37061589888`. Codemagic's
   `android-fast-verify` now uses free `mac_mini_m2`; `linux_x2` requires billing
   at $0.045/min. The Codemagic workflow runs tests and assembles a debug APK
   without publishing a release. It requires secure variable group `posapi`
   containing deployed Worker `API_BASE` and till `API_TOKEN`; otherwise the APK
   intentionally fails instead of silently showing an empty catalog.
9. Production has migrations `0002`–`0005` applied with user approval; `0006`
   remains pending and must never be applied. R2 exists. Worker version
   `ce03d335-655f-4e2f-bd11-4b6228efbe8a` is deployed; D1 contains 10 products
   and 0 sales. No-token `/items` returns expected 401; the owner's newly
   rotated POS token returns 200 with catalog JSON. Update Codemagic `API_TOKEN`
   with that same value, rebuild, install the new APK, and verify catalog there.
   Admin token rotation was requested but completion is not confirmed; never put
   `POS_ADMIN_TOKEN` in Codemagic or Android.

No test servers remain running. Temporary state/log paths in `PROGRESS.md` may expire; recreate test state rather than relying on them. Do not repeat credential, migration, bucket, or deploy setup unless verification fails.
Never apply unreviewed migration `0006` or use `git add .`.

---

**Read in this order:** [AGENTS.md](AGENTS.md), **Session parked** and the **Current checkpoint** in
[PROGRESS.md](PROGRESS.md), this file, then the historical [HANDOFF.md](HANDOFF.md)
and [ROADMAP.md](ROADMAP.md). The actual spec is
[Indian-BookKeeping-Software-Functional-Spec.md](Indian-BookKeeping-Software-Functional-Spec.md).

Legacy till/admin authentication and reports are repaired. The approved refund reversal foundation is now verified too:
actual refund-account settlement, exact allocation remainders, safe-integer checks, and transaction-aborting stale-plan guards.
**244 serverless/unit tests pass; the expanded full Worker suite passes 371/371.** A separate local D1.batch probe also
verified stale/missing-allocation rollback of preceding vouchers/numbering and exact 333+334+333 cost conservation.
The full run used Wrangler with unchanged migrations **0001–0005 only**, applied to a disposable local
D1 outside the repo; default local and remote databases were not touched. See `PROGRESS.md` for exact commands.
JWT/API-key/MFA routes and schema-dependent auditing remain inactive; migration 0006 was not applied.

**Verified continuation:** the atomic `POST /credit-notes` writer now creates one-batch document, stock, allocation and
ledger effects with idempotency, stable numbering, partial-return conservation and stale-plan rollback. GST-adjusting notes
and non-`original_lot` modes remain intentionally disabled. Planner statements must run together with the caller's
stock/document/journal writes in one D1 batch; planning alone restores no physical stock.
The admin UI now loads numeric line IDs/counters from `/admin/sales/:ref`, freezes
the exact request body and idempotency key across uncertain retries, and requires
confirmation for commercial notes. The isolated browser flow proved this UI
posts a balanced note and restores the requested stock; till credentials were
denied. The catalog's mobile horizontal overflow was fixed. Retain the
historical-registration snapshot/bill-reprint issue and unverified Android/device
flows. Stay in spec
Phase 2 stabilization, not expanded Phase 5/6 authentication.

The local draft migration `0006`, worktree metadata, and `__agent__` artifacts
remain excluded. Never use `git add .`; stage only reviewed product/test/docs
paths and never apply migration `0006`.

---

## Historical snapshot — 2026-09-23 (not current verification)

A working, correct double-entry POS for Indian retail and services. Phase 1 and
phase 2 are built and verified; phase 3 is designed but not built.

- **202 worker tests** and **34 Android tests**, all passing.
- **12 tables, 17 routes.** ~9,000 lines across worker, web and Android.
- Roughly **12% of the 154 features** in the functional spec — but the hardest
  and most structural parts are done, so nearer 25–30% of the total effort.

**The Android APK compiles and its tests pass, but it has never run on a
phone.** That check is still outstanding.

---

## Safe checks for the current recovery

```bash
cd worker
node --check src/index.js
node --check src/auth.js
npm run test:unit
node --test test/reports.test.js
```

These need no running server or persisted D1. `npm run test:unit` now includes report and auth tests;
its separate report command above is optional for focused verification. Full API verification uses disposable local
state with reviewed migrations 0001–0005; the default migration command also includes unreviewed 0006 and must not be used blindly.
See `PROGRESS.md` for the passing full-suite command and isolated-port setup.
On Windows, confirm owned Wrangler/workerd descendants actually stop after ending a dev command.

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

## Historical next steps — superseded by the current checkpoint

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

## Historical deployment notes — do not deploy the current unfinished integration

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

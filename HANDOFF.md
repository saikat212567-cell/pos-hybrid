# POS rebuild — status and handoff

Last updated: 2026-09-23. Nothing is committed yet; all of the work below is in
the working tree.

This project is turning a coffee-shop demo POS into an Indian retail and service
business system: FIFO stock costing, GST, double-entry books, fast counter entry,
and printed bills.

---

## Decisions that shape everything

These came from the shop owner and are not recoverable from the code alone.

| Decision | Choice | Consequence |
|---|---|---|
| GST status | **Flexible** | `regular` / `composition` / `unregistered` is a setting, never hardcoded. |
| Books | **Full double-entry** | Chart of accounts, vouchers, trial balance that ties out. |
| Pricing | **User selectable** | Inclusive (MRP) or exclusive, shop default with a per-item override. |
| Sells | **Goods and services** | `kind` on each item drives stock, COGS, HSN vs SAC, and which income account. |
| Entry | **Image tiles AND keyboard** | Most Indian retail stock has no barcode, so typed codes matter as much as scanning. |
| Bills | **58mm, 80mm, A4, PDF/share** | Plus a `bill_format` setting for the default. |
| Money | **Integer paise everywhere** | Only display code divides by 100. |

---

## Phase 1 — backend foundation. DONE and verified.

FIFO lots, GST engine, double-entry ledger, purchases, reports, settings.

`worker/migrations/0002_foundation.sql` — 12 tables. `worker/src/gst.js`,
`fifo.js`, `ledger.js`, and a rewritten `index.js`.

## Phase 2 — fast entry, item management, bills. Backend and web DONE. Android WRITTEN, NOT VERIFIED.

`worker/migrations/0003_items_images.sql`, plus `worker/src/items.js`,
`images.js`, `bill.js`. Web client split into `web/index.html` + `app.js` +
`bill.js` + `config.js` + `admin.html` + `admin.js`.

---

## What is verified, and what is not

**Verified — 168 worker tests pass, repeatably (three consecutive clean runs).**

Also verified by hand against a live local Worker: item creation and its
validation refusals, hide/restore, opening stock posting to equity with the
trial balance still netting to zero, image upload accepting a real PNG and
rejecting a mislabelled file and an oversized one, bills rendering in all three
formats with figures matching the recorded sale, and the old web/Android sale
payload still returning 201 with idempotent retry.

Worker test count is now **202**, all passing (plus 34 Android tests). Thirteen
confirmed review findings have been fixed and locked with regression tests
(2026-09-23):

1. **`voucherStatements` null-ref collision** — two cash purchases with no
   supplier invoice number posted their ledger lines to the same voucher; trial
   balance still netted to zero, so nothing caught it. Now resolves by `MAX(id)`.
   New `test/ledger.test.js` runs against real SQLite.
2. **`lotInsert` opening-stock attribution** — opening lots claimed an unrelated
   supplier's purchase line. Now takes an explicit `linkPurchaseLine` flag.
3. **Bill rate display** — the 0.25% slab printed as "0%", and a single-rate
   thermal invoice stated the rate nowhere (Rule 46(m)). Fixed with a
   `ratePercent` helper and always rendering the rate-wise breakup.
4. **GST registration ignored in both clients** — a composition/unregistered
   dealer's till showed tax the server neither records nor prints; on exclusive
   pricing the on-screen total exceeded the amount charged. Both clients now read
   `gst_registration` from `/shop`.
5. **`place_of_supply` / `state_code` unvalidated** — "19 ", "019", "nineteen"
   routed an intrastate sale entirely to IGST, letting a till-token request pick
   the tax head. New `normalizeStateCode()` validates all three trust boundaries
   (sale, purchase, settings write).
6. **`tax_code` accepted 5 and 7 digits** — an HSN is 4, 6 or 8 digits and a SAC
   is always 6, so a dropped keystroke passed validation and reached filed
   invoices and the GSTR-1 HSN summary.
7. **A PATCH could blank `tax_code`** on a registered dealer's item, because
   `has()` treats `''` as present and the mandatory check was gated on
   `!partial`. Every later invoice for that item would carry no HSN/SAC.
8. **`fy_start` unvalidated** — `fyLabel` parses it with
   `split('-').map(Number)`, so `"2026-04-01"` yields NaN and silently files
   sales into the wrong financial year while advancing the closed year's invoice
   counter. Now must be `MM-DD`.
9. **`invoice_series` unbounded** — concatenated straight into the invoice
   number, so a long series produced numbers past the 16 characters Rule 46(b)
   allows. Now 1–5 characters of `[A-Za-z0-9/-]`.
10. **`recordSale` ignored `is_active`** — a withdrawn item stayed sellable by id,
    and a withdrawn *service* forever, since services have no stock check.
11. **`payment_mode` unvalidated** — `settlementAccount()` fell through to Cash in
    Hand, so "cheque" booked a non-cash sale as cash and the drawer stopped
    reconciling. Now validated against an exported `PAYMENT_MODES`, and
    `settlementAccount()` throws rather than defaulting.

12. **The admin token rode in every thumbnail URL.** `admin.js` put the pasted
    admin token in each `<img src>` as `?t=`, and the Worker accepted *any* valid
    token there — so the token that gates the books and the tax settings went into
    Cloudflare logs, proxy logs and `Referer` headers, breaking the admin page's
    own promise to hold it in memory only. The page now uses the till token (which
    is public by design and opens only catalog-read and sale-insert), and the
    Worker accepts **only** the till token in `?t=`. The admin token still works in
    the `Authorization` header, where it does not leak.
13. **Both clients used stale shop settings.** `/shop` was fetched once at
    startup, but a till stays open all day and the pricing mode, rounding rule or
    registration can change mid-shift — after which the counter quotes one figure
    while the server records and prints another. Web now refreshes after each
    sale; Android refreshes in `onResume`, skipped while a cart is open so a sale
    in progress is never repriced under the cashier.

Also fixed: `routeId` called `decodeURIComponent` **before** the auth check, so
`PATCH /items/%` from an unauthenticated caller returned 500 instead of 401. Auth
now comes first and a malformed escape is a 400.

Findings 1, 2, 10 and 11 are in the exact code refunds will extend, which is why
the review was run before phase-3 implementation.

**One confirmed finding is deliberately left open:** `billHtml` derives the
document type from *current* settings rather than what the sale was recorded
under, so switching registration retroactively reprints old tax invoices as
tax-free documents whose totals still contain the collected tax. The fix is to
snapshot `registration` on the sale row — which is exactly what the phase-3
credit-note schema already does — so it is folded into that work rather than
half-fixed now.

**Android now compiles and its tests pass** (2026-09-23, after installing the
toolchain — see the next section). `gradle assembleDebug` produces a 7.4 MB
`app-debug.apk`, and `gradle test` runs 28 unit tests with 0 failures. The APK was
inspected with `aapt2`: package `com.example.pos`, minSdk 24, targetSdk 34, and
the FileProvider authority is `com.example.pos.fileprovider`, matching what
`BillPrinter.share()` builds — so sharing a bill will not throw.

**Still NOT verified: the app running on a real device.** Compiling proves the
code is well-formed, not that the screen behaves. Tile images, scanner input,
thermal printing and the share sheet have never been exercised on hardware.

### Android review done 2026-09-23 (by reading, not compiling)

Checked and **clean**: every `b.<id>` in `MainActivity` exists in
`activity_main.xml`, every `holder.b.<id>` in `Adapters.kt` exists in
`item_product.xml` / `item_cart.xml`, `stock: Int?` is null-safe at every use,
and the toolchain (Kotlin 2.0.20, AGP 8.5.2) supports everything used.

Five real defects found and fixed:

1. **Room would crash on upgrade.** `MIGRATION_1_2` gave `products` SQL `DEFAULT`
   clauses that no `@ColumnInfo(defaultValue)` declares. Room compares defaults
   when validating a schema after migration, so this was an
   `IllegalStateException` on first launch after an update. Defaults removed —
   they were never used anyway, since Room always supplies every column.
2. **Same defaults mismatch on `sales`** (`synced`, `failed`), same crash.
3. **The `sales` migration had an untestable branch.** `ALTER TABLE … RENAME
   COLUMN` needs SQLite 3.25+ (API 30) with `minSdk 24`, so a `try/catch`
   fallback meant one path that only ever runs on old phones — on the code that
   moves unsynced sales. Replaced with one copy-and-rename path that works on
   every supported version.
4. **`priceMode` was hardcoded to `"inclusive"` in both clients** despite being
   documented as coming from the server. At an exclusive-pricing shop every
   on-screen total was understated by the tax: the counter would quote ₹2.50 and
   the bill would print ₹3.00. Fixed by adding a till-readable `GET /shop`
   (pricing mode, rounding, registration, default bill format) and calling it at
   startup in both clients. The web till also ignored `round_off_enabled`
   outright; now honoured.
5. **Shared bills were always named `bill-draft.html`.** `lastInvoiceNo` was set
   to null and never populated. `fetchBill` now returns the invoice number too,
   read from the document's own `<title>`.

Verified after the fixes: 171 worker tests pass, repeatably; and an exclusive-mode
sale of a ₹2.50 item at 18% records taxable 250 + tax 45 → 295, rounded to 300
with a 5 paise round-off, which is what the counter now displays.

---

## Android toolchain (installed 2026-09-23)

Portable, under `C:\Users\swastika\tools\`, nothing registered with Windows:

| Tool | Version | Path |
|---|---|---|
| Temurin JDK | 17.0.20.1+1 | `tools\jdk-17.0.20.1+1` |
| Gradle | 8.9 | `tools\gradle-8.9` |
| Android SDK | platform 34, build-tools 34.0.0, platform-tools | `tools\android-sdk` |

Portable zips rather than installers because Temurin's MSI is machine-scope only
and raised a UAC prompt that could not be accepted from here (`winget` exit 1602,
and `--scope user` has no applicable installer). Both archives were SHA-256
verified against the published checksums before extraction. The installer zips
were deleted afterwards, reclaiming 606 MB.

**Gradle 8.9, not 9.x.** AGP 8.5.2 does not support Gradle 9 — it removed APIs
AGP still calls. Bump both together or neither.

`android/local.properties` points at the SDK. It is gitignored (`.gitignore:3`),
which is correct: the path is specific to this machine and Codemagic supplies its
own SDK. Anyone cloning this repo has to create their own.

Building needs both env vars set:

```bash
export JAVA_HOME="/c/Users/swastika/tools/jdk-17.0.20.1+1"
export ANDROID_HOME="/c/Users/swastika/tools/android-sdk"
cd android
/c/Users/swastika/tools/gradle-8.9/bin/gradle assembleDebug --no-daemon
/c/Users/swastika/tools/gradle-8.9/bin/gradle test --no-daemon
```

First `assembleDebug` takes ~10 minutes; later ones are much faster. `--no-daemon`
avoids leaving a background JVM holding file locks on Windows.

## Running it

```bash
cd worker
npm install
npm run migrate:local     # applies 0001, 0002, 0003

npm run dev:test          # shell 1 — local Worker on :8801
npm test                  # shell 2 — 168 tests
npm run test:unit         # no server needed; pure engines only
```

Two shells because killing wrangler's process tree from node on Windows is
unreliable and hangs the test runner.

For the web till: copy your `POS_TOKEN` into `web/config.js`, then open
`web/index.html`. No build step. `web/admin.html` asks for the admin token and
keeps it in memory only.

### Deploying

```bash
cd worker
npx wrangler r2 bucket create pos-images    # phase 2 needs this, once
npm run migrate                              # --remote
npm run deploy
```

Then set the shop's identity, because the defaults are placeholders and they
decide what every invoice says:

```bash
curl -X PUT -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"legal_name":"Your Shop","gstin":"19XXXXXXXXXXXZX","state_code":"19",
       "gst_registration":"regular","price_mode":"inclusive","invoice_series":"A"}' \
  https://pos-api.you.workers.dev/settings
```

---

## Invariants — do not break these

**Integer paise, never floats.** `divRound(n, d) = floor((n + floor(d/2)) / d)`
is the only rounding. A float anywhere near money reintroduces the drift the
whole design avoids.

**A lot stores cost remaining, not unit cost.** Buy 3 for ₹10 and the unit cost
is 333.33 paise, which no integer column holds. Taking `q` of `n` costs
`round(cost_remaining * q / n)`, and the last unit takes whatever is left. Total
COGS over a lot's life then equals its purchase cost exactly.
`worker/test/fifo.test.js` asserts this across every awkward quantity/cost pair.
This is the single most important piece of arithmetic in the project.

**Tax rounds per line, not per invoice.** A bill states a rate-wise breakup and
the printed lines must add up to the printed total.

**CGST/SGST splits by halving with the remainder to one side.** Rounding both
halves of an odd amount loses or invents a paisa.

**`sales.client_ref` is the PRIMARY KEY.** It is what makes an offline retry
safe. The sale, the stock movement and the journal entry share one D1 `batch()`,
so a duplicate rolls back all three — a retry cannot double the revenue, the
stock, or the ledger.

**Debits must equal credits.** `buildVoucher` throws otherwise. An unbalanced
ledger is worse than a failed request: it corrupts every report derived from it
and is found months later by an accountant.

**A price edit must never touch existing lots.** A lot records what that stock
actually cost. Rewriting it would falsify the FIFO history and retroactively
change the COGS of every sale already made from it.

**Invoice numbers are per device** (`A/26-27/0001`). GST requires a gapless
series but an offline till cannot ask the server for the next number, and GST
permits multiple series. One series per till.

**Never `fallbackToDestructiveMigration()` in Room.** It drops tables, and
`sales` is the only place an offline sale exists until it syncs.

---

## Known compromises

**Phase 1 migrated the old flat `stock` column into zero-cost opening lots.** The
old schema never recorded what that stock cost, and inventing a number would put
a fiction in the books. Consequence: goods sold from that stock show zero COGS
and inflated margin until real purchases replace them. `POST
/items/:id/opening-stock` now exists to record stock at a stated cost, which is
the fix — use it for anything still on the shelf.

**Services report a sentinel `stock` of 999999 on the legacy `/products`
route.** Both originally-shipped clients disable a tile at `stock <= 0`, so a
truthful `0` would make every service unsellable on builds already in the field.
`/items` reports `kind` and a null stock honestly. Delete the sentinel once no
client reads `/products`.

**No server-side image resizing.** Clients downscale before upload (canvas on
web, `BitmapFactory`/Coil on Android) and the route caps uploads at 2 MB. Add
Cloudflare Images only if the catalog grows past a few thousand items.

**Concurrency is handled by CHECK constraints, not locking.** Two tills selling
the last units both pass the availability check; the loser's subtraction drives a
remainder negative, the CHECK fires, the batch rolls back, and the client gets a
retryable 409. A `WHERE qty_remaining >= ?` guard would be worse — the UPDATE
would match no rows and silently commit a sale that never moved stock.

---

## Next steps, in order

~~1. Review the Android code.~~ **Done 2026-09-23** — see the review section
above. Five defects fixed, three of them crash-or-wrong-money bugs.

~~2. Compile and test Android.~~ **Done 2026-09-23.** Toolchain installed,
`assembleDebug` succeeds, 28 unit tests pass. The read-through review had already
caught the defects, so the compiler found nothing new — but that was not knowable
in advance.

1. **Install the APK on a real phone and use it.** `adb install -r
   app/build/outputs/apk/debug/app-debug.apk`, with `adb` at
   `tools\android-sdk\platform-tools`. Check what only hardware can show: tile
   images loading, a barcode scanner typing into the entry field, `3*12` entry,
   printing to a thermal roll, and the share sheet. The APK needs `apiBase` and
   `apiToken` — pass them as `-PapiBase=... -PapiToken=...` or the build produces
   an app that cannot reach the server.

2. **Run `/code-review`** over the phase-2 diff. The same review on phase 1 found
   ten real bugs including three that silently lost data, so this is not
   optional.

3. **Commit.** Nothing is committed yet. Suggested split: one commit for the
   worker (migrations, engines, routes, tests), one for the web client, one for
   Android.

4. **Consider `room.schemaLocation`.** The build warns that Room cannot export its
   schema. Exporting it to a checked-in JSON file is what lets a future migration
   be tested against the real previous schema rather than a remembered one — worth
   doing before the app is on a device holding unsynced sales.

Then phase 3: reports UI, GSTR-1/3B export, and refunds/credit notes. Refunds
need to return stock to the lot it came from and reverse a voucher — its own
design problem, deliberately deferred.

---

## Repo map

```
worker/
  migrations/0001_initial.sql        original demo schema
             0002_foundation.sql     FIFO lots, GST, ledger, settings  (phase 1)
             0003_items_images.sql   entry codes, images, bill settings (phase 2)
  src/index.js     routes; recordSale is the atomic batch
     gst.js        tax math, pure
     fifo.js       lot consumption, COGS, service short-circuit
     ledger.js     voucher posting, trial balance
     items.js      item validation, GST slabs, UQCs
     images.js     R2 upload with signature checks
     bill.js       58mm/80mm/A4 rendering, amount in words
  test/            171 tests; gst/fifo/fy/bill/items need no server
web/
  index.html  config.js  app.js  bill.js     the till (reads /shop at startup)
  admin.html  admin.js                       items and settings
android/                                     WRITTEN, NEVER COMPILED
```

Classic scripts, not ES modules, in `web/` — a module is fetched under CORS rules
and a `file://` page has an opaque origin, so imports would fail and the till
would only work behind a web server.

### Cleanup

`.tmproom/` at the repo root is 656 KB of Room source jars left by tooling. It is
untracked and safe to delete; it should not be committed.

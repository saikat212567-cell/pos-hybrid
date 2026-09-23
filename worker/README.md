# POS API — Cloudflare Workers + D1

Indian GST, FIFO stock costing and double-entry books over a D1 (SQLite)
database. Both clients talk only to this.

```
Till (POS_TOKEN)
GET  /products                 -> [{ id, name, price, stock }]   legacy shape
GET  /items                    -> catalog with kind, HSN/SAC, rate
POST /sales                    -> { ok: true }

Admin (POS_ADMIN_TOKEN)
GET  /sales?limit&since        -> { sales, count, totalPaise, grossProfitPaise }
POST /purchases                -> creates costed stock lots
GET  /reports/stock            -> quantity and FIFO value on hand
GET  /reports/trial-balance    -> every account, and `balanced: true`
GET  /settings, PUT /settings  -> GST registration, state, pricing mode
```

Money is integer **paise**. `POST /sales` returns 201 for a new sale, 200 with
`duplicate: true` if that `client_ref` already exists, and 409 if stock cannot
cover it.

A sale is one D1 `batch()` — one transaction. It consumes stock FIFO, computes
GST, assigns an invoice number and posts a journal entry, all together. Stock
decremented for a sale that was never recorded, or a sale with no matching
ledger entry, is corruption no later pass could reconstruct.

## Goods and services

`kind` on each item is `good` or `service`, and three things follow from it:

| | `good` | `service` |
|---|---|---|
| Stock | FIFO lots; overselling refused | none; always sellable |
| COGS | from the lots consumed | none |
| Tax code | HSN | SAC |
| Revenue posts to | Sales (4000) | Service Income (4100) |

One invoice can mix both — a repair job with a part and a labour charge. Splitting
the revenue accounts is what lets a P&L show which side of the business earns.

A service is deliberately not modelled as a good with zero stock: it would
become unsellable the moment stock hit zero, and it would post a cost of goods
with no cost.

## GST is configuration, not code

`PUT /settings` drives the tax engine. Nothing about the rates is compiled in.

- `gst_registration` — `regular` charges CGST/SGST or IGST. `composition` and
  `unregistered` charge nothing: their document is a bill of supply, and the
  engine emits zero tax lines even if an item still carries a rate.
- `state_code` — the seller's 2-digit GST state code. Compared against the
  buyer's place of supply to pick CGST+SGST (same state) or IGST (different).
- `price_mode` — `inclusive` (the price is what the customer pays, normal for
  Indian retail) or `exclusive` (tax added on top, normal for B2B). An item can
  override it, so one catalog can serve a counter and a wholesale desk.
- `round_off_enabled` — round the bill to the nearest rupee, posting the
  difference to Round Off so the books still balance.

## Two rounding rules

**Tax rounds per line, not per invoice.** A tax invoice states a rate-wise
breakup, and the printed lines have to add up to the printed total. Computing
tax on the subtotal instead gives a customer arithmetic that does not work.

**CGST/SGST splits by halving and giving the remainder to one side.** Rounding
both halves of an odd amount either loses or invents a paisa.

## Two tokens

`POS_TOKEN` is compiled into the APK and visible in the web page's source —
anyone holding either can extract it. So it only opens the two endpoints a till
needs: list products, insert a sale. A leaked till token means junk sales in
your data, not a breach.

`POS_ADMIN_TOKEN` gates everything that reveals or alters the books — sales
history, purchases, reports and the GST settings — and is deliberately **not**
shipped in either client. Purchases create inventory value and input tax credit
out of nothing, and the settings decide what appears on a legal document, so
neither belongs behind a token that ships inside an APK. You pass it by hand
when you want to see takings:

```bash
curl -H "Authorization: Bearer $ADMIN" \
  "https://pos-api.you.workers.dev/sales?limit=20"

# Just today
curl -H "Authorization: Bearer $ADMIN" \
  "https://pos-api.you.workers.dev/sales?since=$(date +%F)"
```

One token for both would mean extracting the APK exposes your entire revenue
history. The admin token also works on the till routes, so you can use it alone
while testing.

## Deploy

```bash
cd worker
npm install

# 1. Log in (opens a browser)
npx wrangler login

# 2. Create the database, then paste the printed database_id into
#    wrangler.jsonc, replacing PLACEHOLDER_RUN_D1_CREATE
npx wrangler d1 create pos

# 3. Create the tables and seed products
npm run migrate

# 4. Set both secrets (long random strings; keep copies).
#    POS_TOKEN goes into the clients. POS_ADMIN_TOKEN stays with you.
npx wrangler secret put POS_TOKEN
npx wrangler secret put POS_ADMIN_TOKEN

# 5. Ship it
npm run deploy
```

Deploy prints your URL — `https://pos-api.<your-subdomain>.workers.dev`. That
plus the token are what both clients need.

Then set who you are, because the defaults are placeholders and they decide
what every invoice says:

```bash
curl -X PUT -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"legal_name":"Your Shop","gstin":"19XXXXXXXXXXXZX","state_code":"19",
       "gst_registration":"regular","price_mode":"inclusive","invoice_series":"A"}' \
  https://pos-api.you.workers.dev/settings
```

## Test

Two shells, because killing wrangler's process tree from node on Windows is
unreliable and hangs the test runner:

```bash
npm run migrate:local   # once
npm run dev:test        # shell 1
npm test                # shell 2
```

73 tests. The tax and FIFO arithmetic needs no server or database:

```bash
npm run test:unit       # gst.test.js + fifo.test.js, one shell, instant
```

Those cover inclusive/exclusive splits, CGST/SGST/IGST by place of supply, all
three registration types, rounding, FIFO ordering and the paisa invariant below.
`npm test` adds the API tests, which check what only a real D1 can show: that a
sale is atomic, that overselling is refused, that goods and service revenue
reach different accounts, that the trial balance nets to zero, and that a retry
posts neither a second voucher nor a second stock movement.

## Money is integer paise

`price`, `total` and every `_paise` column are integers everywhere — database,
API, both clients. Floats lose fractions once you sum them, and a POS sums every
line of every sale. Only display code divides by 100.

### The unit-cost problem

Buy 3 units for ₹10.00 and each costs 333.33 paise, which no integer column can
hold. Storing a rounded unit cost leaks a fraction on every sale: the lot ends
up showing quantity with no cost left against it, inventory never drains to
zero, and COGS stops equalling what the goods cost.

So a lot stores **quantity remaining and cost remaining**, never a unit cost.
Taking `q` of `n` remaining costs `round(cost_remaining * q / n)`, and the last
unit out takes whatever is left. Total COGS over a lot's life always equals its
purchase cost exactly. `fifo.test.js` asserts this across every awkward
quantity/cost combination, not just one example — it is the invariant most
likely to be broken by a well-meaning refactor.

## Idempotency

`sales.client_ref` is the PRIMARY KEY, and the device generates it before
sending. If a sale is stored but the response is lost, the retry collides and
the API returns `200 {duplicate: true}` instead of recording a second sale.
The Android sync worker treats that as success.

This is the whole reason offline queueing is safe. Don't remove that key.

The guarantee now extends to the books. Because the sale, the stock movement and
the journal entry share one transaction, a collision rolls back all three — a
retry cannot double the revenue, the stock decrement or the ledger. The unique
index on `vouchers(type, ref)` backs this up independently.

## Invoice numbering is per device

A GST invoice number must be consecutive within its series, but an offline till
cannot ask the server for the next one — and a customer at the counter needs a
bill number now, not when connectivity returns.

GST permits multiple series, each gapless within itself, so each till gets its
own: `A/26-27/0001`, `B/26-27/0001`. Set `invoice_series` per device. The number
is assigned inside the same transaction as the sale, so a rolled-back duplicate
does not consume one and leave a gap.

## Backups

D1's free tier includes 7-day Time Travel — point-in-time restore:

```bash
npx wrangler d1 time-travel info pos
npx wrangler d1 time-travel restore pos --timestamp=<iso-timestamp>
```

For anything older than 7 days, export periodically:

```bash
npx wrangler d1 export pos --remote --output=backup-$(date +%F).sql
```

## Free tier limits

5 GB storage, 5M rows read/day, 100k rows written/day. A sale writes a handful
of rows, so a shop doing hundreds of sales a day uses a fraction of it.

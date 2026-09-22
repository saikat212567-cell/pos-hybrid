# POS API — Cloudflare Workers + D1

Two endpoints over a D1 (SQLite) database. Both clients talk only to this.

```
GET  /products          -> [{ id, name, price, stock }]   POS_TOKEN
POST /sales             -> { ok: true }                   POS_TOKEN
GET  /sales?limit&since -> { sales, count, totalCents }   POS_ADMIN_TOKEN
```

Money is in cents. `POST /sales` returns 201 for a new sale, 200 with
`duplicate: true` if that `client_ref` already exists.

## Two tokens

`POS_TOKEN` is compiled into the APK and visible in the web page's source —
anyone holding either can extract it. So it only opens the two endpoints a till
needs: list products, insert a sale. A leaked till token means junk sales in
your data, not a breach.

`POS_ADMIN_TOKEN` gates reading sales history and is deliberately **not**
shipped in either client. You pass it by hand when you want to see takings:

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

## Test

Two shells, because killing wrangler's process tree from node on Windows is
unreliable and hangs the test runner:

```bash
npm run migrate:local   # once
npm run dev:test        # shell 1
npm test                # shell 2
```

15 tests: auth rejection, catalog, sale recording, idempotent retry, stock
decrement, payload validation, 404s, and the token split — the till token must
get 401 on `GET /sales` while the admin token gets 200.

## Money is integer cents

`price` and `total` are integers everywhere — database, API, both clients.
Floats lose pennies once you sum them, and a POS sums every line of every
sale. Only display code divides by 100.

## Idempotency

`sales.client_ref` is the PRIMARY KEY, and the device generates it before
sending. If a sale is stored but the response is lost, the retry collides and
the API returns `200 {duplicate: true}` instead of recording a second sale.
The Android sync worker treats that as success.

This is the whole reason offline queueing is safe. Don't remove that key.

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

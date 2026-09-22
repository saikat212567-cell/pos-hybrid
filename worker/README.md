# POS API — Cloudflare Workers + D1

Two endpoints over a D1 (SQLite) database. Both clients talk only to this.

```
GET  /products   -> [{ id, name, price, stock }]   price in cents
POST /sales      -> { ok: true }                   201 new, 200 if duplicate
```

Every request needs `Authorization: Bearer <POS_TOKEN>`.

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

# 4. Set the shared secret (any long random string; keep a copy)
npx wrangler secret put POS_TOKEN

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

9 tests: auth rejection, catalog, sale recording, idempotent retry, stock
decrement, payload validation, 404s.

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

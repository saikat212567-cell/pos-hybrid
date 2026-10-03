# Hybrid POS — Web + Android

Cloudflare Workers + D1 backend, two clients. Nothing compiles on your PC: the
web app is a single HTML file you open in a browser, the APK is built by
Codemagic.

```
worker/                  API + D1 database (deploy this first)
web/index.html           the entire web terminal
android/                 Gradle project for the APK
codemagic.yaml           cloud APK build + GitHub Release publishing
```

## 1. Backend

Follow [worker/README.md](worker/README.md). Five commands and you have a URL
plus a token — that's all both clients need.

## 2. Web app

`API_BASE` in [web/index.html](web/index.html) already points at the deployed
Worker. Paste your `POS_TOKEN` into `API_TOKEN` just below it:

```js
const API_BASE = 'https://pos-api.saikat212567.workers.dev';
const API_TOKEN = 'the-till-token-you-set';
```

Then open the file. No server, no build.

Before you fill the token in it runs on a demo catalog, so you can click
through the UI without a backend.

### Serving the web app

The token sits in the page source, so anyone who can load the page can read it.
That's tolerable for the till token (it only lists products and inserts sales)
but it means **where you host this matters**:

- **Local file, or a machine on your own network** — fine. This is the default.
- **Public URL** (GitHub Pages, Netlify, Cloudflare Pages) — your token is then
  world-readable, so anyone could insert junk sales into your data. Put it
  behind access control, or keep the page off the public internet.

The repo keeps `YOUR-POS-TOKEN` as the committed placeholder so the real token
never lands in git history. Paste yours into your local copy only.

## 3. Android APK

The new Android app is branded **Hisab** and uses package ID `com.hisab.pos` so
it can be installed alongside the existing `com.example.pos` package. Its first
version is declared by `android/version.json` (`1.0.0`, version code `1`). Do not
change this application ID after publishing the Hisab app.

The old POS APK's signing key is unavailable; the new Hisab app therefore uses
a separate permanent signing identity. All future Hisab release APKs must use
the same Codemagic keystore. Setup:

1. Generate a new keystore locally with Java `keytool`; keep a secure backup and
   never commit it. Codemagic cannot recover it if lost.
   For this Windows setup, run in PowerShell:

   ```powershell
   & "C:\Users\swastika\tools\jdk-17.0.20.1+1\bin\keytool.exe" -genkeypair -v -keystore "$env:USERPROFILE\Downloads\hisab-upload-key.jks" -storetype JKS -keyalg RSA -keysize 2048 -validity 10000 -alias hisab-upload
   ```

   Keytool prompts for store/key passwords and certificate identity. Do not send
   passwords or the keystore to chat.
2. In Codemagic Team settings → `codemagic.yaml settings` → `Code signing
   identities` → `Android keystores`, upload it with reference
   `hisab-upload-key`, alias `hisab-upload`, and its passwords. Keep the JKS
   backup in a secure location separate from the repository.
3. Ensure `posapi` contains the deployed Worker URL (`API_BASE`) and till token
   (`API_TOKEN`, same as Cloudflare `POS_TOKEN`), both secrets as appropriate.
4. Manually start `android-fast-verify` after the keystore is uploaded. It runs
   Android tests and assembles a signed Hisab release APK; it does not publish an
   app-store release. The workflow fails closed if API or signing values are
   missing.
5. Compare the APK's certificate on its first build, install alongside the old
   POS app, and use the new Hisab keystore for every future Hisab update.

The existing `android-debug` workflow is an opt-in release path for tagged builds:

```bash
git tag v1.0 && git push origin v1.0
```

Open that release page on the phone and install the `.apk` directly.

The verification workflow uses `mac_mini_m2`, which is available on the free
individual plan. Codemagic's faster `linux_x2` machine requires billing and is
metered at `$0.045/minute`. Do not add API or GitHub release credentials to the
verification workflow.

To build locally instead (needs JDK 17 + Android SDK):

```bash
cd android
gradle assembleDebug -PapiBase=https://... -PapiToken=...
```

## How offline works

Every sale on Android is written to Room first, then a WorkManager job with a
`NetworkType.CONNECTED` constraint is enqueued. The UI never waits on the
network, so charging is instant whether or not there's signal. The job runs
when connectivity returns and survives app kill and reboot — which is why
there's no connectivity listener or retry timer in the code.

Each sale carries a device-generated `client_ref` UUID, and that column is the
PRIMARY KEY server-side. If an upload succeeds but the response is lost, the
retry collides and the API reports `duplicate: true`, which the sync worker
treats as success. A flaky connection cannot produce a double charge.

Products are cached locally on each successful fetch, and stock is decremented
locally on sale, so an offline device shows a plausible catalog and stops
selling what it has run out of.

If the server refuses a sale outright (bad token, rejected payload — a 4xx that
retrying can't fix), it leaves the retry queue so it can't block the sales
behind it, but it is flagged `failed` rather than marked synced, and the status
line turns red with a count. Marking it synced would disguise a lost sale as a
completed one and the money would vanish with nothing to show for it. A red
status line means those sales exist on the till and nowhere else.

## Money is integer cents

Prices and totals are integers everywhere — D1, the API, both clients. Floats
lose pennies once you sum them. Only display code divides by 100.

## Security: two tokens

`POS_TOKEN` is compiled into the APK and visible in the web page's source, so
anyone holding either can extract it. It opens only what a till needs — list
products, insert a sale. A leaked till token means junk sales in your data, not
a breach.

`POS_ADMIN_TOKEN` gates reading sales history and is **not** in either client.
You pass it by hand when you want to see takings:

```bash
curl -H "Authorization: Bearer $ADMIN" \
  "https://pos-api.you.workers.dev/sales?since=$(date +%F)"
```

One token for both would mean extracting the APK exposes your whole revenue
history. Rotate either with `wrangler secret put`, and rebuild the clients if
you change the till token.

## Backups

D1's free tier includes 7-day point-in-time restore (Time Travel). For longer
retention, `wrangler d1 export` on a schedule. Commands in
[worker/README.md](worker/README.md).

This is the main reason the backend is D1 rather than Supabase, whose free tier
has no point-in-time recovery.

## What's not here

- **Auth.** Every device shares one token; sales aren't attributed to a
  cashier. Add per-device tokens when you need that.
- **Atomic server-side stock.** Stock decrements happen in the same D1
  transaction as the sale, but two offline devices can still oversell the same
  item since neither sees the other until sync.
- **Refunds and receipt printing.** No support yet. Sales history is readable
  via `GET /sales` with the admin token, but there's no UI for it.
- **Release signing.** Builds produce a debug APK. Add a keystore to Codemagic
  and switch to `assembleRelease` when you distribute.

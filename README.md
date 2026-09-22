# Hybrid POS — Web + Android

Shared Supabase backend, two clients. Nothing compiles on your PC: the web app
is a single HTML file you open in a browser, the APK is built by Codemagic.

```
supabase/schema.sql      tables, RLS policies, seed products
web/index.html           the entire web terminal
android/                 Gradle project for the APK
codemagic.yaml           cloud APK build + GitHub Release publishing
```

## 1. Supabase

1. Create a project at supabase.com (free tier is fine).
2. SQL Editor → paste `supabase/schema.sql` → Run.
3. Settings → API → copy the **Project URL** and the **anon public** key.

The anon key is public — it ships inside the web page and inside the APK, so
anyone can read it out. The RLS policies in the schema are the actual security
boundary: with the anon key you can read products and insert a sale, nothing
else. Don't put the `service_role` key in either client.

## 2. Web app

Edit the two constants at the top of the `<script>` block in
`web/index.html`:

```js
const SUPABASE_URL = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-key';
```

Then open the file. No server, no build. To host it: drop it on GitHub Pages,
Netlify drop, or Cloudflare Pages — it's one static file.

Before you fill in the keys it runs on a demo catalog so you can click through
the UI.

## 3. Android APK

Built on Codemagic, delivered through GitHub Releases. Config is in
`codemagic.yaml`; the one-time UI setup is listed in the comment at the top of
that file.

Short version:

1. codemagic.io → sign up with GitHub → add `pos-hybrid` as an Android app.
2. Create two environment variable groups: `supabase` (`SUPABASE_URL`,
   `SUPABASE_ANON_KEY`) and `github` (`GH_TOKEN` with `repo` scope). Mark all
   three Secure.
3. Push to `main` → it builds and emails you the APK.
4. Tag a release → it builds and publishes the APK to GitHub Releases:

```bash
git tag v1.0 && git push origin v1.0
```

Then open the release page on the phone and install the `.apk` directly.

Unit tests run before the APK is assembled, so a broken build fails early.

Why not GitHub Actions: the original workflow worked, but this account's
Actions artifact storage is full (~1.6 GB of old APK builds in another repo),
so artifact uploads fail. Release assets don't count against that quota. The
old workflow is still in git history at the first commit if you want it back.

To build locally instead (needs JDK 17 + Android SDK):

```bash
cd android
gradle assembleDebug -PsupabaseUrl=... -PsupabaseAnonKey=...
```

## How offline works

Every sale on Android is written to Room first, then a WorkManager job with a
`NetworkType.CONNECTED` constraint is enqueued. The UI never waits on the
network, so charging is instant whether or not there's signal.

Each sale carries a device-generated `client_ref` UUID, and `sales.client_ref`
is `unique` in Postgres. If an upload succeeds but the response is lost, the
retry hits a 409 and the worker treats that as success — so a flaky connection
can't produce a double-charge. That constraint is the entire correctness
argument for the sync path; don't drop it.

Products are cached locally on each successful fetch, and stock is decremented
locally on sale, so an offline device shows a plausible catalog and stops
selling items it has run out of.

## What's not here

- **Auth.** Every device is anonymous. Add Supabase Auth when you need
  per-cashier attribution or want to lock sales reads down by user.
- **Server-side stock.** Local decrements are advisory; two offline devices can
  oversell the same item. Add a Postgres trigger or an RPC that decrements
  atomically on insert when that starts to matter.
- **Receipt printing, refunds, reporting.** Query the `sales` table from the
  Supabase dashboard for now.
- **Release signing.** The workflow produces a debug APK. Add a keystore secret
  and `assembleRelease` when you're ready to distribute.

/**
 * Where the API is and how to reach it. The only file you edit locally.
 *
 * NOT an ES module, deliberately. A `type="module"` script is fetched under CORS
 * rules, and a file:// page has an opaque origin, so every import fails — the
 * page would only work behind a web server. Classic scripts are not CORS
 * checked, so these files load straight off the disk and the till keeps its
 * "just open index.html" property. That is why these files talk to each other
 * through one global instead of import/export.
 *
 * API_TOKEN is your POS_TOKEN. It is visible to anyone who can load this page,
 * which is why it only opens what a till needs — read the catalog, insert a
 * sale. See "Serving the web app" in the README before putting this on a public
 * URL.
 *
 * The admin token is deliberately NOT here. admin.html asks for it and keeps it
 * in memory only: it gates the books and the tax settings, so it must not sit in
 * a file the till loads.
 */
var CONFIG = {
  API_BASE: 'https://pos-api.saikat212567.workers.dev',
  API_TOKEN: 'YOUR-POS-TOKEN',
};

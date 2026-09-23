/**
 * Bill output for the browser: print, open, share.
 *
 * The layouts themselves live in the Worker (`worker/src/bill.js`) and this only
 * puts the rendered HTML in front of a printer. Duplicating the templates
 * client-side would mean two implementations of a legal document drifting apart,
 * and the one that drifts is the one that gets a business fined.
 *
 * Classic script, not a module — see the note in config.js about file:// and
 * CORS.
 */

var Bill = (function () {

  /**
   * Print a bill.
   *
   * A hidden iframe rather than window.open: popups are blocked by default in
   * most browsers, and a counter losing its bill to a popup blocker is not
   * acceptable.
   */
  function printHtml(html) {
    var frame = document.createElement('iframe');
    // Off-screen rather than display:none. A display:none iframe is not laid out
    // in some browsers, and an unlaid-out document prints blank.
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText =
      'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
    document.body.appendChild(frame);

    frame.onload = function () {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } finally {
        // The print dialog needs the document to still exist while it takes its
        // snapshot; removing the frame synchronously cancels the job in Safari.
        setTimeout(function () { frame.remove(); }, 60000);
      }
    };

    // srcdoc keeps the frame same-origin so print() is callable on it. A blob:
    // URL would be cross-origin in Firefox and the call would throw.
    frame.srcdoc = html;
  }

  /** Open the bill in a tab — from there the browser's own Save as PDF works. */
  function openHtml(html) {
    var w = window.open('', '_blank');
    if (!w) return false;               // popup blocked; caller falls back
    w.document.write(html);
    w.document.close();
    return true;
  }

  /**
   * Share the bill through the OS share sheet.
   *
   * This is how "send it on WhatsApp" works without a line of WhatsApp-specific
   * code: the sheet lists whatever the user actually has installed. Unavailable
   * on most desktops, where the caller falls back to opening a tab.
   */
  async function shareHtml(html, filename) {
    if (!navigator.canShare) return false;

    var file = new File([html], filename || 'bill.html', { type: 'text/html' });
    if (!navigator.canShare({ files: [file] })) return false;

    try {
      await navigator.share({ files: [file], title: 'Bill' });
      return true;
    } catch (e) {
      // Dismissed, or refused by the browser. Not worth surfacing as an error —
      // printing still works.
      return false;
    }
  }

  return { printHtml: printHtml, openHtml: openHtml, shareHtml: shareHtml };
})();

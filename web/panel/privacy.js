/* Screen-capture privacy layer for the panel (retailer + admin console).
 *
 * HONEST SCOPE: a web page cannot truly block an OS screenshot or screen
 * recording — the browser has no such API. This layer provides deterrence and
 * traceability, which is what web allows:
 *   1. Identity watermark — a faint, repeating overlay of the signed-in user's
 *      id + time, so any screenshot / recording / screen-share is traceable to
 *      who captured it. This is the primary control.
 *   2. Exfil friction — disable right-click, copy/cut, text selection and image
 *      drag on the app, so content can't be trivially lifted.
 *   3. Hide-on-hidden — curtain the app when the tab is backgrounded, so the
 *      OS app-switcher / tab thumbnail doesn't expose balances.
 *   4. Print block — @media print (in index.html) blanks the page so
 *      "Save as PDF" / print can't capture it.
 *
 * TRUE blocking is native-app only (Android FLAG_SECURE, iOS capture
 * detection) — see docs/NATIVE_APP_PLAN.md. The watermark identity is read
 * from the panel's own auth state once the user logs in.
 */
(function () {
  'use strict';

  // ---- 1. Identity watermark ------------------------------------------
  function ensureWatermark() {
    if (document.getElementById('tp-watermark')) return document.getElementById('tp-watermark');
    var el = document.createElement('div');
    el.id = 'tp-watermark';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483646', 'pointer-events:none',
      'display:none', 'background-repeat:repeat', 'opacity:0.10',
      'mix-blend-mode:difference',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  // Build a tiled SVG of the identity label, rotated, as a CSS background.
  // The whole SVG is percent-encoded (single-quoted attrs, no raw <>/#/space)
  // so the data URI is valid in every browser.
  function watermarkTile(text) {
    var svg =
      "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'>" +
      "<text x='0' y='90' transform='rotate(-24 160 90)' " +
      "font-family='monospace' font-size='13' fill='#808080'>" + text + "</text></svg>";
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }

  // The panel's State is a top-level `const` (a lexical global, not a window
  // property), so read it by bare name inside try/catch rather than window.State.
  function currentUser() {
    try { return (State && State.user) || null; } catch (e) { return null; }
  }

  function identityLabel() {
    try {
      var s = currentUser();
      var who = s ? (s.phone || s.username || s.id || '') : '';
      var stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      // Keep it short + SVG-safe (no quotes / angle brackets).
      return (String(who) + '  ' + stamp).replace(/[<>"&]/g, ' ');
    } catch (e) { return ''; }
  }

  function refreshWatermark() {
    var el = ensureWatermark();
    var label = identityLabel();
    // Only show once someone is signed in (an identity to stamp).
    var signedIn = !!currentUser();
    if (signedIn && label.trim()) {
      el.style.backgroundImage = watermarkTile(label);
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  }

  // ---- 2. Exfil friction ----------------------------------------------
  function blockEvent(e) { e.preventDefault(); return false; }
  function guardExfil() {
    document.addEventListener('contextmenu', blockEvent);
    document.addEventListener('dragstart', function (e) {
      if (e.target && e.target.tagName === 'IMG') return blockEvent(e);
    });
    // Block copy/cut everywhere except inside form fields the user is editing
    // (they must be able to work with their own inputs).
    ['copy', 'cut'].forEach(function (type) {
      document.addEventListener(type, function (e) {
        var t = e.target;
        var editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
        if (!editable) return blockEvent(e);
      });
    });
    // Disable text selection app-wide, but keep inputs usable.
    var style = document.createElement('style');
    style.textContent =
      'body{-webkit-user-select:none;-moz-user-select:none;user-select:none}' +
      'input,textarea,[contenteditable]{-webkit-user-select:text;user-select:text}';
    document.head.appendChild(style);
  }

  // ---- 3. Hide-on-hidden (app-switcher / background thumbnails) --------
  function ensureCurtain() {
    if (document.getElementById('tp-curtain')) return document.getElementById('tp-curtain');
    var c = document.createElement('div');
    c.id = 'tp-curtain';
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647', 'display:none',
      'align-items:center', 'justify-content:center', 'flex-direction:column',
      'background:#0b1020', 'color:#fff', 'font-family:system-ui,sans-serif',
      'text-align:center', 'padding:24px',
    ].join(';');
    c.innerHTML =
      '<div style="font-size:40px;margin-bottom:12px">🔒</div>' +
      '<div style="font-size:16px;font-weight:600">Hidden for your privacy</div>' +
      '<div style="font-size:13px;opacity:.7;margin-top:6px">Return to this tab to continue.</div>';
    document.body.appendChild(c);
    return c;
  }
  function onVisibility() {
    var c = ensureCurtain();
    c.style.display = document.hidden ? 'flex' : 'none';
  }

  // ---- init -----------------------------------------------------------
  function init() {
    try { guardExfil(); } catch (e) {}
    try {
      ensureCurtain();
      document.addEventListener('visibilitychange', onVisibility);
    } catch (e) {}
    try {
      ensureWatermark();
      // Re-evaluate identity as the panel boots / routes / refreshes.
      refreshWatermark();
      setInterval(refreshWatermark, 15000);
      window.addEventListener('hashchange', refreshWatermark);
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

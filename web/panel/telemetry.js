/* Client-side error self-reporting. Captures uncaught errors + unhandled
   promise rejections in the panel and POSTs them to /telemetry/error, where
   they're grouped by signature for the admin Error Monitor. Best-effort and
   silent: it never shows anything to the user and never throws. */
(function () {
  'use strict';
  var seen = Object.create(null);
  var MAX_DISTINCT = 25; // cap per page load, so a loop can't spam the endpoint

  function apiBase() {
    try {
      return (window.TUTIPAYS_API || window.RBPAYS_API || (location.origin + '/api/v1')).replace(/\/$/, '');
    } catch (e) { return '/api/v1'; }
  }

  function report(message, stack) {
    try {
      if (!message) return;
      var key = String(message).slice(0, 200);
      if (seen[key]) return;                       // dedupe within this page load
      if (Object.keys(seen).length >= MAX_DISTINCT) return;
      seen[key] = 1;
      fetch(apiBase() + '/telemetry/error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: String(message).slice(0, 2000),
          stack: stack ? String(stack).slice(0, 8000) : undefined,
          url: String(location.href).slice(0, 300),
        }),
        keepalive: true,                           // survive a page unload
      }).catch(function () {});
    } catch (e) { /* never throw from telemetry */ }
  }

  window.addEventListener('error', function (e) {
    // Skip resource-load errors (img/script failures carry no message).
    if (e && e.message) report(e.message, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    report((r && r.message) || ('Unhandled rejection: ' + String(r)), r && r.stack);
  });
})();

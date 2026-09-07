/* Applies admin-configured branding (name, logo, colour, contact emails,
   company details) from /api/v1/site/settings to any page that includes it.
   Progressive: the page's built-in defaults show first, then get overridden. */
(async () => {
  // SEO: ensure a self-referencing canonical + og:url on every page (query and
  // hash stripped). Runs regardless of the settings fetch below.
  try {
    const canonical = location.origin + location.pathname;
    let link = document.head.querySelector('link[rel="canonical"]');
    if (!link) { link = document.createElement('link'); link.rel = 'canonical'; document.head.appendChild(link); }
    link.href = canonical;
    let og = document.head.querySelector('meta[property="og:url"]');
    if (!og) { og = document.createElement('meta'); og.setAttribute('property', 'og:url'); document.head.appendChild(og); }
    og.setAttribute('content', canonical);
  } catch (_) { /* non-fatal */ }
  try {
    const res = await fetch('/api/v1/site/settings', { cache: 'no-store' });
    if (!res.ok) return;
    const { settings: s } = await res.json();
    if (!s) return;

    // ---- Front-end visibility toggles (admin-managed, no redeploy) ----
    // Standalone-page guard: if this page's flag is explicitly 'false', the
    // admin has taken it down — replace the whole page with an "unavailable"
    // notice so a direct link can't bypass the hide. Runs before anything else.
    const pageFlag = document.body.getAttribute('data-page-flag');
    if (pageFlag && s[pageFlag] === 'false') {
      const bn = s.brand_name || 'TutiPays';
      const accent = s.primary_color || '#7C3AED';
      document.body.style.margin = '0';
      document.body.innerHTML =
        '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:40px;box-sizing:border-box;font-family:inherit">'
        + '<div style="max-width:460px">'
        + '<div style="font-size:46px;margin-bottom:14px">🔒</div>'
        + '<h1 style="font-size:23px;margin:0 0 10px;color:#1a1633">This page is currently unavailable</h1>'
        + '<p style="color:#6b7280;line-height:1.6;margin:0 0 24px">It has been temporarily taken down. Please check back later.</p>'
        + '<a href="/" style="display:inline-block;background:' + accent + ';color:#fff;padding:12px 24px;border-radius:11px;text-decoration:none;font-weight:600">Back to ' + bn + '</a>'
        + '</div></div>';
      if (/TutiPays/.test(document.title)) document.title = document.title.replace(/TutiPays/g, bn);
      return;
    }
    // Remove any element whose data-toggle setting is explicitly 'false'.
    // Absent or any other value = visible (fail-open: if config is missing the
    // marketing site still renders in full).
    document.querySelectorAll('[data-toggle]').forEach((el) => {
      const key = el.getAttribute('data-toggle');
      if (key && s[key] === 'false') el.remove();
    });

    // Per-service gating: remove any element tagged data-service="<code>" when
    // that service is disabled in the admin Services desk. One master switch
    // per service, applied across every page (home, terms, refund, …).
    try {
      if (document.querySelector('[data-service]')) {
        const sr = await fetch('/api/v1/site/service-status', { cache: 'no-store' });
        if (sr.ok) {
          const { disabled } = await sr.json();
          (disabled || []).forEach((code) => {
            document.querySelectorAll('[data-service="' + code + '"]').forEach((el) => el.remove());
          });
        }
      }
    } catch (_) { /* best-effort */ }

    if (s.primary_color) document.documentElement.style.setProperty('--brand', s.primary_color);
    const brand = s.brand_name || 'TutiPays';

    // Logo blocks: only rewrite when the admin has actually customised the
    // logo or brand name. Otherwise leave the page's built-in markup untouched
    // so the default logo doesn't visibly repaint on every load (no flicker).
    const customLogo = !!s.logo_url || (!!s.logo_emoji && s.logo_emoji !== '₹');
    const customName = !!s.brand_name && s.brand_name !== 'TutiPays';
    if (customLogo || customName) {
      document.querySelectorAll('.logo').forEach((el) => {
        const dot = s.logo_url
          ? `<img src="${s.logo_url}" alt="${brand}" style="width:30px;height:30px;border-radius:9px;object-fit:cover">`
          : `<span class="dot">${s.logo_emoji || '₹'}</span>`;
        const white = /color:\s*#fff|color:\s*white/i.test(el.getAttribute('style') || '');
        el.innerHTML = `${dot} <span${white ? ' style="color:#fff"' : ''}>${brand}</span>`;
      });
    }

    // Title + brand-name text nodes.
    if (/TutiPays/.test(document.title)) document.title = document.title.replace(/TutiPays/g, brand);
    document.querySelectorAll('[data-brand]').forEach((el) => { el.textContent = brand; });

    // Contact emails.
    if (s.support_email) document.querySelectorAll('a[href^="mailto:support@"]').forEach((a) => { a.href = 'mailto:' + s.support_email; a.textContent = s.support_email; });
    if (s.admin_email) document.querySelectorAll('a[href^="mailto:admin@"]').forEach((a) => { a.href = 'mailto:' + s.admin_email; a.textContent = s.admin_email; });

    // Company detail slots (opt-in via data attributes).
    const map = { 'company-name': s.company_name, 'company-address': s.company_address, tagline: s.tagline };
    for (const [k, v] of Object.entries(map)) {
      if (v) document.querySelectorAll(`[data-${k}]`).forEach((el) => { el.textContent = v; });
    }

    // ---- SEO / analytics / social (admin-configurable) ----
    const setMeta = (attr, name, content) => {
      let el = document.head.querySelector(`meta[${attr}="${name}"]`);
      if (!el) { el = document.createElement('meta'); el.setAttribute(attr, name); document.head.appendChild(el); }
      el.setAttribute('content', content);
    };
    if (s.meta_description) setMeta('name', 'description', s.meta_description);
    if (s.meta_keywords) setMeta('name', 'keywords', s.meta_keywords);
    if (s.og_image_url) { setMeta('property', 'og:image', s.og_image_url); setMeta('name', 'twitter:image', s.og_image_url); }
    // Favicon: use the admin logo if set, else ensure the default ₹ mark exists
    // (inner pages don't ship one inline).
    if (s.logo_url || !document.head.querySelector('link[rel="icon"]')) {
      const l = document.head.querySelector('link[rel="icon"]') || document.createElement('link');
      l.rel = 'icon';
      l.href = s.logo_url || "/logo-icon.svg";
      document.head.appendChild(l);
    }
    // Google Analytics (GA4).
    if (s.google_analytics_id) {
      const g = document.createElement('script');
      g.async = true; g.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(s.google_analytics_id);
      document.head.appendChild(g);
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
      window.gtag('config', s.google_analytics_id);
    }
    // Footer social links.
    const socials = [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['twitter', 'X'], ['youtube', 'YouTube']]
      .filter(([k]) => s['social_' + k])
      .map(([k, label]) => `<a href="${s['social_' + k]}" target="_blank" rel="noopener" style="color:inherit;margin-right:16px">${label}</a>`);
    if (s.social_whatsapp) socials.push(`<a href="https://wa.me/${s.social_whatsapp}" target="_blank" rel="noopener" style="color:inherit">WhatsApp</a>`);
    if (socials.length) {
      const fb = document.querySelector('.fbottom');
      if (fb) { const d = document.createElement('div'); d.style.cssText = 'margin-top:8px;font-size:13px'; d.innerHTML = socials.join(''); fb.appendChild(d); }
    }
  } catch (_) { /* branding is best-effort */ }
})();

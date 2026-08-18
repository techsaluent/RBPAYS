/* Applies admin-configured branding (name, logo, colour, contact emails,
   company details) from /api/v1/site/settings to any page that includes it.
   Progressive: the page's built-in defaults show first, then get overridden. */
(async () => {
  try {
    const res = await fetch('/api/v1/site/settings', { cache: 'no-store' });
    if (!res.ok) return;
    const { settings: s } = await res.json();
    if (!s) return;

    if (s.primary_color) document.documentElement.style.setProperty('--brand', s.primary_color);
    const brand = s.brand_name || 'TutiPays';

    // Logo blocks: replace with configured emoji/image + brand name.
    document.querySelectorAll('.logo').forEach((el) => {
      const dot = s.logo_url
        ? `<img src="${s.logo_url}" alt="${brand}" style="width:30px;height:30px;border-radius:9px;object-fit:cover">`
        : `<span class="dot">${s.logo_emoji || '₹'}</span>`;
      const white = /color:\s*#fff|color:\s*white/i.test(el.getAttribute('style') || '');
      el.innerHTML = `${dot} <span${white ? ' style="color:#fff"' : ''}>${brand}</span>`;
    });

    // Title + brand-name text nodes.
    if (/TutiPays/.test(document.title)) document.title = document.title.replace(/TutiPays/g, brand);
    document.querySelectorAll('[data-brand]').forEach((el) => { el.textContent = brand; });

    // Contact emails.
    if (s.support_email) document.querySelectorAll('a[href^="mailto:support@"]').forEach((a) => { a.href = 'mailto:' + s.support_email; a.textContent = s.support_email; });
    if (s.admin_email) document.querySelectorAll('a[href^="mailto:admin@"]').forEach((a) => { a.href = 'mailto:' + s.admin_email; a.textContent = s.admin_email; });

    // Company detail slots (opt-in via data attributes).
    const map = { 'company-name': s.company_name, 'company-address': s.company_address, 'company-pan': s.company_pan, 'company-gst': s.company_gst, tagline: s.tagline };
    for (const [k, v] of Object.entries(map)) {
      if (v) document.querySelectorAll(`[data-${k}]`).forEach((el) => { el.textContent = v; });
    }
  } catch (_) { /* branding is best-effort */ }
})();

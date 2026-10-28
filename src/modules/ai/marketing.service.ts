import { aiChat } from './ai.service';

/**
 * AI marketing studio — generate ready-to-share, on-brand promotional posts
 * for a member's services so they can market without a marketing team. Uses
 * the admin-configured AI endpoint (ai.service) when available; when AI is
 * off it degrades to a branded template library, so the feature always works
 * for free.
 */

export interface MarketingBrand {
  brand_name: string;
  tagline?: string | null;
  support_phone?: string | null;
  support_email?: string | null;
  primary_color?: string | null;
}

export interface MarketingPost {
  channel: 'whatsapp' | 'instagram' | 'facebook' | 'sms';
  headline: string;
  body: string;
  hashtags: string[];
  cta: string;
}

export interface MarketingResult {
  source: 'ai' | 'template';
  image_prompt: string; // a prompt the member can paste into any image generator
  posts: MarketingPost[];
}

// Human labels for the service codes a member can promote.
const SERVICE_LABEL: Record<string, string> = {
  recharge: 'mobile & DTH recharge',
  bbps: 'electricity, gas & utility bill payments',
  dmt: 'instant money transfer (DMT)',
  payout: 'instant bank payouts',
  aeps: 'Aadhaar cash withdrawal (AePS)',
  cms: 'cash collection (CMS)',
  upi: 'UPI collections',
  matm: 'micro-ATM cash withdrawal',
  pan_card: 'PAN card services',
  travel: 'flight, train & bus booking',
  insurance: 'insurance',
  credit_card: 'credit card bill payment',
  loan: 'loan repayment',
};

function label(service: string): string {
  return SERVICE_LABEL[service] || service.replace(/_/g, ' ');
}

/** Branded, free template posts when the AI endpoint is not configured. */
function templatePosts(brand: MarketingBrand, service: string, offer?: string): MarketingResult {
  const svc = label(service);
  const name = brand.brand_name;
  const contact = brand.support_phone ? `📞 ${brand.support_phone}` : (brand.support_email ? `✉️ ${brand.support_email}` : `Visit ${name} today`);
  const offerLine = offer ? ` ${offer}.` : '';
  const tags = ['#' + name.replace(/[^a-zA-Z0-9]/g, ''), '#' + service, '#digitalindia', '#fintech', '#paymentservices'];
  return {
    source: 'template',
    image_prompt: `A clean, modern promotional banner for "${name}" advertising ${svc} in India. Bright ${brand.primary_color || 'blue'} accents, a smiling customer with a smartphone, rupee and payment icons, bold readable headline space at top. Professional, trustworthy fintech look.`,
    posts: [
      {
        channel: 'whatsapp',
        headline: `${svc.charAt(0).toUpperCase() + svc.slice(1)} at ${name}! ⚡`,
        body: `Now get fast, secure ${svc} right here.${offerLine} No queues, no hassle — done in seconds. ${contact}`,
        hashtags: tags,
        cta: 'Message us to get started 👇',
      },
      {
        channel: 'instagram',
        headline: `${name} — your one-stop digital shop`,
        body: `Need ${svc}?${offerLine} We’ve got you covered. Trusted by your neighbourhood. Tap, pay, done. ${brand.tagline || ''}`.trim(),
        hashtags: tags,
        cta: `DM us or call ${brand.support_phone || 'now'}`,
      },
      {
        channel: 'sms',
        headline: `${name}`,
        body: `${name}: Fast ${svc} available now.${offerLine} ${contact}. Reply STOP to opt out.`,
        hashtags: [],
        cta: contact,
      },
    ],
  };
}

/**
 * Generate on-brand marketing posts. Tries the AI endpoint for fresh copy;
 * falls back to the branded templates (and always returns usable posts).
 */
export async function generateMarketingPosts(
  brand: MarketingBrand,
  service: string,
  opts: { offer?: string; tone?: string } = {},
): Promise<MarketingResult> {
  const svc = label(service);
  const system =
    'You are a performance marketing copywriter for an Indian neighbourhood digital-services shop. ' +
    'Write short, punchy, culturally-relevant promotional posts that drive walk-ins and messages. ' +
    'Return STRICT JSON only: {"posts":[{"channel":"whatsapp|instagram|facebook|sms","headline":"","body":"","hashtags":["",""],"cta":""}],"image_prompt":""}. ' +
    'Keep SMS under 160 chars with an opt-out. Use at most 1-2 emojis per post. No markdown.';
  const user =
    `Brand: ${brand.brand_name}\n` +
    (brand.tagline ? `Tagline: ${brand.tagline}\n` : '') +
    (brand.support_phone ? `Phone: ${brand.support_phone}\n` : '') +
    `Service to promote: ${svc}\n` +
    (opts.offer ? `Offer/angle: ${opts.offer}\n` : '') +
    (opts.tone ? `Tone: ${opts.tone}\n` : 'Tone: friendly and trustworthy\n') +
    'Write 3 posts: one WhatsApp, one Instagram, one SMS. Include an image_prompt for a banner.';

  const raw = await aiChat(system, user);
  if (raw) {
    const parsed = safeJson(raw);
    if (parsed && Array.isArray(parsed.posts) && parsed.posts.length) {
      const posts: MarketingPost[] = parsed.posts
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .map((p) => ({
          channel: (['whatsapp', 'instagram', 'facebook', 'sms'].includes(String(p.channel)) ? p.channel : 'whatsapp') as MarketingPost['channel'],
          headline: String(p.headline ?? '').slice(0, 140),
          body: String(p.body ?? '').slice(0, 600),
          hashtags: Array.isArray(p.hashtags) ? p.hashtags.map((h) => String(h)).slice(0, 8) : [],
          cta: String(p.cta ?? '').slice(0, 120),
        }))
        .slice(0, 4);
      if (posts.length) {
        return {
          source: 'ai',
          image_prompt: String(parsed.image_prompt ?? templatePosts(brand, service, opts.offer).image_prompt).slice(0, 600),
          posts,
        };
      }
    }
  }
  return templatePosts(brand, service, opts.offer);
}

function safeJson(text: string): { posts?: unknown[]; image_prompt?: unknown } | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

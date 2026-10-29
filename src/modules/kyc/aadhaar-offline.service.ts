import crypto from 'crypto';
import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';
import { query } from '../../../db';
import { logger } from '../../config/logger';

/**
 * Aadhaar Paperless Offline e-KYC — free, no UIDAI licence required.
 *
 * The member downloads their digitally-signed Offline e-KYC XML from the UIDAI
 * portal (protected by a 4-digit share phrase they choose), then uploads that
 * XML here with the share phrase. We:
 *   1. parse the plaintext demographics (name, DOB, gender, address) + photo,
 *   2. verify UIDAI's XML digital signature against UIDAI's public certificate
 *      (pinned — we never trust the certificate embedded in the file), which
 *      proves the file is genuine and unaltered,
 *   3. optionally confirm the member's own mobile against the hash in the file
 *      using the share phrase (best-effort, never blocks).
 *
 * The signing certificate is configured once by the admin (site setting
 * `uidai_offline_cert`, a PEM). Until it is set we still extract and present
 * the data for a human reviewer, but never auto-verify — so a missing or wrong
 * certificate fails safe to manual review and can never falsely approve.
 */
const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';

export interface OfflineKycData {
  reference_id: string;
  aadhaar_last4: string;
  name?: string;
  dob?: string;
  gender?: string;
  care_of?: string;
  mobile_hash?: string;
  email_hash?: string;
  address: Record<string, string>;
  address_text: string;
  photo_base64?: string;
}

export interface OfflineKycResult {
  ok: boolean;                 // XML parsed as a UIDAI offline e-KYC file
  signature_checked: boolean;  // a certificate was available to verify against
  signature_verified: boolean; // UIDAI signature is valid (genuine + unaltered)
  mobile_confirmed?: boolean;  // provided mobile matched the file's hash
  data?: OfflineKycData;
  message: string;
}

// @xmldom/xmldom elements expose getAttribute/textContent; the DOM lib isn't in
// this project's tsconfig, so use a minimal structural type.
type XmlEl = { getAttribute(name: string): string | null; textContent: string | null } | undefined;
function attr(el: XmlEl, name: string): string | undefined {
  const v = el?.getAttribute(name);
  return v == null || v === '' ? undefined : v;
}

/** Parse the plaintext demographics + photo from an offline e-KYC XML. */
export function parseOfflineKyc(xml: string): OfflineKycData {
  const doc = new DOMParser({
    onError: () => { /* tolerate minor issues; structure is validated below */ },
  }).parseFromString(xml, 'text/xml');
  const root = doc.documentElement;
  if (!root || !/OfflinePaperlessKyc/i.test(root.nodeName)) {
    throw new Error('Not a UIDAI Offline e-KYC XML file');
  }
  const refId = root.getAttribute('referenceId') || '';
  const poi = doc.getElementsByTagName('Poi')[0] as unknown as XmlEl;
  const poa = doc.getElementsByTagName('Poa')[0] as unknown as XmlEl;
  const pht = doc.getElementsByTagName('Pht')[0] as unknown as XmlEl;

  const addrKeys = ['careof', 'house', 'street', 'landmark', 'loc', 'vtc', 'po', 'subdist', 'dist', 'state', 'pc', 'country'];
  const address: Record<string, string> = {};
  for (const k of addrKeys) { const v = attr(poa, k); if (v) address[k] = v; }
  const addressText = ['house', 'street', 'landmark', 'loc', 'vtc', 'po', 'subdist', 'dist', 'state', 'pc']
    .map((k) => address[k]).filter(Boolean).join(', ');

  return {
    reference_id: refId,
    aadhaar_last4: refId.slice(0, 4),
    name: attr(poi, 'name'),
    dob: attr(poi, 'dob'),
    gender: attr(poi, 'gender'),
    care_of: address.careof,
    mobile_hash: attr(poi, 'm'),
    email_hash: attr(poi, 'e'),
    address,
    address_text: addressText,
    photo_base64: (pht?.textContent || '').replace(/\s+/g, '') || undefined,
  };
}

/**
 * Verify the UIDAI XML digital signature against a PINNED certificate. The
 * certificate in the file's KeyInfo is deliberately ignored — only the admin's
 * configured UIDAI certificate is trusted, so a forged file with its own key
 * cannot pass.
 */
export function verifyOfflineSignature(xml: string, certPem: string): boolean {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const sigEl = (doc.getElementsByTagNameNS(DSIG_NS, 'Signature')[0]
      || doc.getElementsByTagName('Signature')[0]) as unknown;
    if (!sigEl) return false;
    const sig = new SignedXml();
    sig.publicCert = certPem;
    // Pin to the configured UIDAI cert; never trust a cert embedded in the file.
    sig.getCertFromKeyInfo = () => null;
    sig.loadSignature(sigEl as never);
    return sig.checkSignature(xml) === true;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'offline e-KYC signature verification failed');
    return false;
  }
}

function sha256hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
/**
 * UIDAI contact-hash: SHA-256 of (value + shareCode), iterated as many times as
 * the last digit of the Aadhaar number (once when that digit is 0). Best-effort
 * — a mismatch never blocks, since the member's identity is already proven by
 * the signed demographics.
 */
export function confirmMobile(mobile: string, shareCode: string, data: OfflineKycData): boolean {
  if (!data.mobile_hash || !mobile || !shareCode) return false;
  const lastDigit = Number(data.aadhaar_last4.slice(-1)) || 0;
  const iters = lastDigit === 0 ? 1 : lastDigit;
  let h = sha256hex(mobile.trim() + shareCode.trim());
  for (let i = 1; i < iters; i++) h = sha256hex(h);
  return h.toLowerCase() === data.mobile_hash.toLowerCase();
}

/** The admin-configured UIDAI signing certificate (PEM), or null. */
export async function uidaiCert(): Promise<string | null> {
  const { rows } = await query<{ value: string | null }>(
    "SELECT value FROM site_settings WHERE key = 'uidai_offline_cert'",
  );
  const pem = (rows[0]?.value || '').trim();
  return pem.includes('BEGIN CERTIFICATE') ? pem : null;
}

/** Full offline e-KYC check: parse, verify signature, optionally confirm mobile. */
export async function processOfflineKyc(
  xml: string,
  opts: { share_code?: string; mobile?: string } = {},
): Promise<OfflineKycResult> {
  let data: OfflineKycData;
  try {
    data = parseOfflineKyc(xml);
  } catch (err) {
    return { ok: false, signature_checked: false, signature_verified: false, message: (err as Error).message };
  }
  if (!data.reference_id || !data.name) {
    return { ok: false, signature_checked: false, signature_verified: false, data, message: 'File is missing required e-KYC fields' };
  }

  const cert = await uidaiCert();
  const signatureChecked = !!cert;
  const signatureVerified = cert ? verifyOfflineSignature(xml, cert) : false;

  let mobileConfirmed: boolean | undefined;
  if (opts.share_code && opts.mobile) {
    mobileConfirmed = confirmMobile(opts.mobile, opts.share_code, data);
  }

  const message = !signatureChecked
    ? 'Details extracted. Signature not verified — a UIDAI certificate is not configured, so an admin will confirm this document.'
    : signatureVerified
      ? 'Aadhaar verified — UIDAI signature is valid.'
      : 'UIDAI signature did NOT verify. This file may be altered or the configured certificate is outdated.';

  return {
    ok: true,
    signature_checked: signatureChecked,
    signature_verified: signatureVerified,
    mobile_confirmed: mobileConfirmed,
    data,
    message,
  };
}

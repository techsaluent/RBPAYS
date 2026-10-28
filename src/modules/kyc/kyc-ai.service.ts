import { query } from '../../../db';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { aiVisionChat, extractJsonPublic } from '../ai/ai.service';

/**
 * AI-ASSISTED KYC review (human stays in the loop).
 *
 * An AI vision model OCRs an uploaded document and returns a NON-BINDING
 * recommendation — verdict (approve / reject / uncertain), a confidence
 * score, the extracted fields, and a reason — which we store on the
 * kyc_documents row for the admin reviewer to confirm with one click. The AI
 * never changes the document's status; a human always approves or rejects.
 *
 * Degrades safely: when no AI endpoint is configured, the model has no vision
 * support, or the document has no image, this returns null and the manual
 * review flow is unchanged.
 */

export interface KycAiRecommendation {
  verdict: 'approve' | 'reject' | 'uncertain';
  confidence: number; // 0-100
  extracted: Record<string, unknown>;
  reason: string;
  name_match: boolean | null;
}

/** Resolve a stored file_url to something the model can fetch. */
function resolveImageUrl(fileUrl: string): string {
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl;
  const base = (env.API_BASE_URL || '').replace(/\/+$/, '');
  return base ? `${base}${fileUrl.startsWith('/') ? '' : '/'}${fileUrl}` : fileUrl;
}

const SYSTEM =
  'You are a meticulous KYC verification officer for an Indian fintech. You are shown a photo of an ' +
  'identity document. OCR it and assess it. Return STRICT JSON only, no prose:\n' +
  '{"verdict":"approve|reject|uncertain","confidence":0-100,"name_match":true|false|null,' +
  '"extracted":{"doc_type":"aadhaar|pan|gst|other","name":"","id_number":"","dob":""},' +
  '"reason":"one short sentence"}.\n' +
  'Reject if the image is unreadable, cropped, clearly edited/tampered, or the document type is wrong. ' +
  'Set name_match by comparing the name on the document to the expected holder name (ignore case, initials, ' +
  'minor spelling). Never invent fields you cannot read — leave them empty. Be conservative: if unsure, use "uncertain".';

/**
 * Run the AI review for one KYC document and persist the recommendation.
 * Returns the recommendation, or null when AI/vision is unavailable.
 */
export async function reviewKycDocument(docId: string): Promise<KycAiRecommendation | null> {
  const { rows } = await query<{ doc_type: string; file_url: string | null; doc_number: string | null; full_name: string }>(
    `SELECT k.doc_type, k.file_url, k.doc_number, u.full_name
       FROM kyc_documents k JOIN users u ON u.id = k.user_id
      WHERE k.id = $1`,
    [docId],
  );
  const doc = rows[0];
  if (!doc) return null;
  if (!doc.file_url) {
    logger.info({ docId }, 'kyc ai review skipped: no document image');
    return null;
  }

  const prompt =
    `Expected document type: ${doc.doc_type}. ` +
    `Expected holder name: "${doc.full_name}". ` +
    (doc.doc_number ? `Claimed document number: "${doc.doc_number}". ` : '') +
    'Review the attached image and return the JSON verdict.';

  const raw = await aiVisionChat(SYSTEM, prompt, resolveImageUrl(doc.file_url));
  if (!raw) return null; // AI off / no vision / endpoint error -> manual

  const parsed = extractJsonPublic(raw);
  if (!parsed) {
    logger.warn({ docId }, 'kyc ai review: unparseable model response');
    return null;
  }

  const verdict = (['approve', 'reject', 'uncertain'].includes(String(parsed.verdict)) ? parsed.verdict : 'uncertain') as KycAiRecommendation['verdict'];
  const confidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0)));
  const extracted = (parsed.extracted && typeof parsed.extracted === 'object' ? parsed.extracted : {}) as Record<string, unknown>;
  const nameMatch = typeof parsed.name_match === 'boolean' ? parsed.name_match : null;
  const reason = String(parsed.reason ?? '').slice(0, 300);

  await query(
    `UPDATE kyc_documents
        SET ai_verdict = $2, ai_confidence = $3, ai_extracted = $4, ai_reason = $5, ai_reviewed_at = now()
      WHERE id = $1`,
    [docId, verdict, confidence, JSON.stringify({ ...extracted, name_match: nameMatch }), reason],
  );

  return { verdict, confidence, extracted, reason, name_match: nameMatch };
}

/** Is AI auto-review enabled (so uploads get a recommendation computed)? Off by default. */
export async function kycAiReviewEnabled(): Promise<boolean> {
  const { rows } = await query<{ value: string }>("SELECT value FROM site_settings WHERE key = 'kyc_ai_review'");
  return (rows[0]?.value ?? 'false').trim() === 'true';
}

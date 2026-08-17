import { query } from '../../../db';

/**
 * Role-specific KYC requirements + onboarding risk scoring.
 *
 * The composite score is 0..100 where LOWER is safer (fewer missing/failed
 * signals). Decision: <25 auto-approve, 25..59 video-KYC / manual, >=60 reject.
 */
export interface KycRequirement {
  doc_type: string;
  label: string;
  mandatory: boolean;
  submitted: boolean;
  verified: boolean;
}

/** Required documents for a role, annotated with what the member has submitted. */
export async function kycRequirementsFor(userId: string, role: string): Promise<KycRequirement[]> {
  const reqs = await query<{ doc_type: string; label: string; mandatory: boolean }>(
    'SELECT doc_type, label, mandatory FROM role_kyc_requirements WHERE role = $1 ORDER BY sort_order',
    [role],
  );
  const docs = await query<{ doc_type: string; status: string }>(
    'SELECT doc_type, status FROM kyc_documents WHERE user_id = $1',
    [userId],
  );
  const byType = new Map<string, string[]>();
  for (const d of docs.rows) {
    (byType.get(d.doc_type) ?? byType.set(d.doc_type, []).get(d.doc_type)!).push(d.status);
  }
  return reqs.rows.map((r) => {
    const statuses = byType.get(r.doc_type) ?? [];
    return {
      doc_type: r.doc_type,
      label: r.label,
      mandatory: r.mandatory,
      submitted: statuses.length > 0,
      verified: statuses.includes('verified'),
    };
  });
}

export interface OnboardingScore {
  identity_score: number;
  geo_score: number;
  bank_score: number;
  device_score: number;
  distributor_score: number;
  total_score: number;
  decision: 'auto_approve' | 'video_kyc' | 'reject';
  detail: Record<string, unknown>;
}

function decisionFor(total: number): OnboardingScore['decision'] {
  if (total >= 60) return 'reject';
  if (total >= 25) return 'video_kyc';
  return 'auto_approve';
}

/** Compute and persist an onboarding risk assessment for a member. */
export async function assessOnboarding(userId: string): Promise<OnboardingScore> {
  const u = (await query<{
    role: string; parent_id: string | null; shop_lat: string | null;
  }>('SELECT role, parent_id, shop_lat FROM users WHERE id = $1', [userId])).rows[0];

  const tax = (await query<{ pan_valid: boolean }>(
    'SELECT pan_valid FROM tax_profiles WHERE user_id = $1',
    [userId],
  )).rows[0];

  const bankVerified = (await query<{ n: string }>(
    "SELECT COUNT(*)::text n FROM kyc_documents WHERE user_id = $1 AND doc_type = 'bank_proof' AND status = 'verified'",
    [userId],
  )).rows[0];

  const device = (await query<{ n: string }>(
    'SELECT COUNT(*)::text n FROM member_devices WHERE user_id = $1 AND is_active = true',
    [userId],
  )).rows[0];

  const parentOld = u?.parent_id
    ? (await query<{ ok: boolean }>(
        "SELECT (created_at < now() - interval '30 days') AS ok FROM users WHERE id = $1",
        [u.parent_id],
      )).rows[0]?.ok
    : false;

  // Lower = safer; add risk points for each missing/failed signal.
  const identity_score = tax?.pan_valid ? 0 : 30;
  const bank_score = Number(bankVerified?.n ?? '0') > 0 ? 0 : 20;
  const geo_score = u?.shop_lat != null ? 0 : 25;
  const device_score = Number(device?.n ?? '0') > 0 ? 0 : 15;
  const distributor_score = parentOld ? 0 : 10;
  const total_score = identity_score + bank_score + geo_score + device_score + distributor_score;
  const decision = decisionFor(total_score);

  const detail = { pan_valid: !!tax?.pan_valid, bank_verified: Number(bankVerified?.n ?? '0') > 0, has_device: Number(device?.n ?? '0') > 0, geo: u?.shop_lat != null, parent_established: !!parentOld };

  await query(
    `INSERT INTO onboarding_assessments
       (user_id, identity_score, geo_score, bank_score, device_score, distributor_score, total_score, decision, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [userId, identity_score, geo_score, bank_score, device_score, distributor_score, total_score, decision, JSON.stringify(detail)],
  );

  return { identity_score, geo_score, bank_score, device_score, distributor_score, total_score, decision, detail };
}

import { env } from '../../config/env';
import { query } from '../../../db';
import { ApiError } from '../../utils/ApiError';
import { getError } from './error.service';

/**
 * Escalate a production error to a GitHub issue that a Claude Code workflow
 * turns into a fix PR for review.
 *
 * SAFETY: this opens an *issue* (and the workflow opens a *draft PR*). It never
 * merges or deploys — a human reviews and merges. The GitHub token is read from
 * the environment only (GITHUB_AUTOFIX_TOKEN); it is never stored in or read
 * from the database. The repo can come from GITHUB_AUTOFIX_REPO or the
 * site_settings key 'github_autofix_repo' (non-secret).
 */

async function escalateRepo(): Promise<string> {
  if (env.GITHUB_AUTOFIX_REPO) return env.GITHUB_AUTOFIX_REPO;
  const { rows } = await query<{ value: string | null }>(
    "SELECT value FROM site_settings WHERE key = 'github_autofix_repo'",
  );
  return (rows[0]?.value || '').trim();
}

function issueBody(e: Record<string, unknown>): string {
  const lines = [
    '> Auto-filed from the Error Monitor. A Claude Code workflow should open a **draft** fix PR for review.',
    '',
    `**Source:** ${e.source}`,
    `**Route:** ${e.route || '(unknown)'}`,
    `**Seen:** ${e.count} time(s) · first ${e.first_seen}`,
    '',
    '### Message',
    '```',
    String(e.message || '').slice(0, 1500),
    '```',
  ];
  if (e.stack) lines.push('### Stack', '```', String(e.stack).slice(0, 4000), '```');
  if (e.ai_diagnosis) lines.push('### AI diagnosis', String(e.ai_diagnosis));
  if (e.ai_suggested_fix) lines.push('### AI suggested fix', '```', String(e.ai_suggested_fix).slice(0, 3000), '```');
  lines.push('', '---', `error_report id: \`${e.id}\``);
  return lines.join('\n');
}

export async function escalateError(id: string) {
  const token = env.GITHUB_AUTOFIX_TOKEN;
  const repo = await escalateRepo();
  if (!token || !repo) {
    throw ApiError.badRequest(
      'Auto-fix escalation is not configured. Set GITHUB_AUTOFIX_TOKEN (environment secret) and GITHUB_AUTOFIX_REPO (owner/name), then retry.',
    );
  }
  const e = await getError(id);
  if (e.escalated_ref) return { escalated_ref: e.escalated_ref, already: true };

  const title = `[autofix] ${String(e.source).toUpperCase()}: ${String(e.message || 'error').slice(0, 110)}`;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'tutipays-error-monitor',
      },
      body: JSON.stringify({ title, body: issueBody(e), labels: [env.GITHUB_AUTOFIX_LABEL] }),
    });
  } catch (err) {
    throw ApiError.badRequest(`Could not reach GitHub: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw ApiError.badRequest(`GitHub rejected the issue (${res.status}): ${text.slice(0, 200)}`);
  }
  const issue = (await res.json()) as { number?: number; html_url?: string };
  const ref = issue.html_url || (issue.number ? `${repo}#${issue.number}` : 'issue created');

  const { rows } = await query(
    "UPDATE error_reports SET escalated_ref = $2, status = 'triaged' WHERE id = $1 RETURNING *",
    [id, ref],
  );
  return { escalated_ref: ref, error_report: rows[0], already: false };
}

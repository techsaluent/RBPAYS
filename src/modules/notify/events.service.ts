import { query } from '../../../db';
import { httpJson } from '../../providers/http';
import { logger } from '../../config/logger';

/**
 * Outbound automation hook. When the super admin sets an `automation_webhook_url`
 * (e.g. an n8n webhook), platform events are POSTed there so external workflows
 * — n8n automations, an AI-agent "staff" that triages disputes, Slack, etc. —
 * can react. Best-effort and fire-and-forget: it never blocks or breaks the
 * action that produced the event.
 */
export function emitEvent(event: string, payload: Record<string, unknown>): void {
  void (async () => {
    try {
      const { rows } = await query<{ value: string | null }>(
        "SELECT value FROM site_settings WHERE key = 'automation_webhook_url'",
      );
      const url = (rows[0]?.value ?? '').trim();
      if (!url) return;
      await httpJson(url, {
        method: 'POST',
        body: { event, at: new Date().toISOString(), data: payload },
        timeoutMs: 5000,
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, event }, 'automation webhook failed');
    }
  })();
}

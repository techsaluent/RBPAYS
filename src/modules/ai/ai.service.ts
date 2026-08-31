import { query } from '../../../db';
import { httpJson } from '../../providers/http';
import { logger } from '../../config/logger';

/**
 * AI integration assistant.
 *
 * Turns a provider's pasted API docs into a `dynamic` provider config (pure
 * data — endpoints + field maps + status rules) so a new aggregator can be
 * wired without a developer. The model is an OpenAI-compatible chat endpoint
 * configured by the admin (platform_integrations key 'ai_coder': base_url,
 * api_key, extra.model). When none is configured it degrades to a fillable
 * scaffold template, so the feature still works for free.
 */
interface AiConfig {
  mode: 'openai' | 'n8n';
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * AI is configured in platform_integrations key 'ai_coder':
 *   base_url  — an OpenAI-compatible endpoint, OR an n8n webhook URL
 *   api_key   — bearer/api key (optional for an open n8n webhook)
 *   extra.mode  — "openai" (default) or "n8n"
 *   extra.model — model name; a free model that keeps changing is just a string
 *                 the admin updates (in n8n mode the model lives in the workflow)
 */
async function aiConfig(): Promise<AiConfig | null> {
  const { rows } = await query<{ base_url: string | null; api_key: string | null; extra: Record<string, unknown> | null }>(
    "SELECT base_url, api_key, extra FROM platform_integrations WHERE key = 'ai_coder' AND is_active = true",
  );
  const r = rows[0];
  if (!r?.base_url) return null;
  const mode = (r.extra && r.extra.mode === 'n8n' ? 'n8n' : 'openai') as AiConfig['mode'];
  if (mode === 'openai' && !r.api_key) return null; // a direct model needs a key
  const model = (r.extra && typeof r.extra.model === 'string' && r.extra.model) || 'gpt-4o-mini';
  return { mode, baseUrl: r.base_url.replace(/\/+$/, ''), apiKey: r.api_key ?? '', model };
}

/** Low-level chat call to an OpenAI-compatible /chat/completions endpoint. */
export async function aiChat(system: string, user: string): Promise<string | null> {
  const cfg = await aiConfig();
  if (!cfg) return null;
  try {
    const res = await httpJson<{ choices?: Array<{ message?: { content?: string } }> }>(
      `${cfg.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: {
          model: cfg.model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        timeoutMs: 45000,
      },
    );
    return res.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'ai chat failed');
    return null;
  }
}

/** Pull the first JSON object out of a model response (handles code fences). */
function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** A ready-to-edit scaffold for the dynamic config (used when AI is off). */
export function scaffoldConfig(services: string[]): Record<string, unknown> {
  const svc: Record<string, unknown> = {};
  for (const s of services) {
    svc[s] = {
      path: `/CHANGE_ME/${s}`,
      method: 'POST',
      request: {
        client_referenceId: '{reference}',
        amount: '{amount}',
        ...(s === 'payout' || s === 'dmt'
          ? { account_number: '{account_number}', ifsc: '{ifsc}', beneficiary_name: '{beneficiary_name}', mode: '{mode}' }
          : {}),
        ...(s === 'recharge' ? { operator: '{operator}', number: '{number}' } : {}),
        ...(s === 'bbps' ? { biller_id: '{biller_id}', consumer_number: '{consumer_number}' } : {}),
      },
      status_field: 'status',
      success: ['SUCCESS', 'success'],
      failed: ['FAILED', 'FAILURE', 'REJECTED'],
      ref_field: 'data.transactionId',
      utr_field: 'data.utr',
      message_field: 'message',
    };
  }
  return {
    base_url: 'https://api.CHANGE_ME.com',
    amount: 'rupees',
    auth: { type: 'headers', headers: { 'client-id': '{api_key}', 'client-secret': '{api_secret}' } },
    services: svc,
  };
}

const SYSTEM_PROMPT = `You are an integrations engineer for an Indian fintech aggregator called TutiPays.
Convert a payment/utility provider's API documentation into a single JSON "dynamic driver" config that TutiPays interprets at runtime. Output ONLY the JSON object, no prose.

Schema:
{
  "base_url": string,                     // provider API base
  "amount": "rupees" | "paise",           // how the provider wants the amount
  "auth": { "type": "headers"|"bearer", "headers": { "<Header-Name>": "<template>" } },
  "services": {
    "<service>": {
      "path": "/endpoint", "method": "POST",
      "request": { ...provider field names mapped to {placeholders}... },
      "status_field": "dot.path.to.status",
      "success": [ ...status values meaning success... ],
      "failed":  [ ...status values meaning failure... ],
      "ref_field": "dot.path", "utr_field": "dot.path", "message_field": "dot.path"
    }
  }
}
Placeholders you may use in templates: {reference} {amount} {amount_paise} {account_number} {ifsc} {beneficiary_name} {mode} {operator} {number} {recharge_type} {circle} {biller_id} {consumer_number} {category} {vpa} and credentials {api_key} {api_secret} {auth_token} {partner_id}. Anything not in success[] or failed[] is treated as pending. Use exact field names and paths from the docs.`;

export interface DraftResult {
  source: 'ai' | 'template';
  model?: string;
  config: Record<string, unknown>;
}

/** Ask an n8n workflow (which runs the free AI) to return a dynamic config. */
async function draftViaN8n(cfg: AiConfig, docs: string, services: string[]): Promise<Record<string, unknown> | null> {
  try {
    const res = await httpJson<Record<string, unknown>>(cfg.baseUrl, {
      method: 'POST',
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      body: { task: 'draft_provider_config', services, schema_prompt: SYSTEM_PROMPT, docs: docs.slice(0, 24000) },
      timeoutMs: 60000,
    });
    // Accept either the config directly, or wrapped as { config } / { output } / choices.
    const raw = res.config ?? res.output ?? res;
    if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).services) return raw as Record<string, unknown>;
    if (typeof raw === 'string') return extractJson(raw);
    return null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'ai n8n draft failed');
    return null;
  }
}

/** Draft a dynamic-driver config for the given services from pasted docs. */
export async function draftProviderConfig(docs: string, services: string[]): Promise<DraftResult> {
  const svc = services.length ? services : ['payout'];
  const cfg = await aiConfig();
  if (cfg && docs.trim()) {
    const parsed =
      cfg.mode === 'n8n'
        ? await draftViaN8n(cfg, docs, svc)
        : extractJson(
            (await aiChat(SYSTEM_PROMPT, `Services to map: ${svc.join(', ')}.\n\nProvider API documentation:\n${docs.slice(0, 24000)}`)) ?? '',
          );
    if (parsed && parsed.services) return { source: 'ai', model: cfg.mode === 'n8n' ? 'n8n' : cfg.model, config: parsed };
  }
  return { source: 'template', config: scaffoldConfig(svc) };
}

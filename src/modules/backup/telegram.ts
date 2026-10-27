import { readFile } from 'fs/promises';
import { basename } from 'path';
import { query } from '../../../db';
import { logger } from '../../config/logger';

/**
 * Minimal Telegram Bot API client for disaster-recovery backups + alerts.
 *
 * Credentials live in platform_integrations key 'telegram':
 *   api_key        — the bot token from @BotFather
 *   extra.chat_id  — the destination chat / group / channel id
 * Everything is best-effort and never throws into the caller unless asked to.
 */
export interface TelegramConfig { token: string; chatId: string }

export async function telegramConfig(): Promise<TelegramConfig | null> {
  const { rows } = await query<{ api_key: string | null; extra: Record<string, unknown> | null }>(
    "SELECT api_key, extra FROM platform_integrations WHERE key = 'telegram' AND is_active = true",
  );
  const r = rows[0];
  const token = (r?.api_key || '').trim();
  const chatId = String((r?.extra?.chat_id as string) || (r?.extra?.chatId as string) || '').trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

/** Verify a bot token (getMe) — used by Validate. Returns the bot username or an error. */
export async function telegramGetMe(token: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const res = await fetch(API(token, 'getMe'));
    const data = (await res.json()) as { ok: boolean; result?: { username?: string }; description?: string };
    if (!data.ok) return { ok: false, error: data.description || `HTTP ${res.status}` };
    return { ok: true, username: data.result?.username };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function sendTelegramMessage(cfg: TelegramConfig, text: string): Promise<boolean> {
  try {
    const res = await fetch(API(cfg.token, 'sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) logger.warn({ err: data.description }, 'telegram sendMessage failed');
    return data.ok;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'telegram sendMessage error');
    return false;
  }
}

/** Send a file (≤ ~50MB per Telegram bot limit). Returns ok + any error text. */
export async function sendTelegramDocument(
  cfg: TelegramConfig,
  filePath: string,
  caption?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const buf = await readFile(filePath);
    const form = new FormData();
    form.append('chat_id', cfg.chatId);
    if (caption) form.append('caption', caption);
    form.append('document', new Blob([new Uint8Array(buf)]), basename(filePath));
    const res = await fetch(API(cfg.token, 'sendDocument'), { method: 'POST', body: form });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) return { ok: false, error: data.description || `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

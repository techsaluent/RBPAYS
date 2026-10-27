import { spawn } from 'child_process';
import { stat, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { query } from '../../../db';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { telegramConfig, sendTelegramDocument, sendTelegramMessage } from './telegram';

/**
 * Disaster-recovery backup: dump the Postgres database (and optionally the
 * .env) and push it to Telegram, so the platform can be rebuilt after a VPS
 * loss (code lives on GitHub; this is the data + config). Admin-controlled,
 * off until a Telegram bot is configured and a daily hour is set.
 */
const TELEGRAM_MAX = 49 * 1024 * 1024; // Telegram bot sendDocument limit ~50MB

function stamp(): string {
  const d = new Date(Date.now() + (5 * 60 + 30) * 60 * 1000); // IST
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/** Run pg_dump | gzip to a temp file. Returns the path. Throws on failure. */
function dumpDatabase(outPath: string): Promise<void> {
  // Prefer DATABASE_URL; otherwise discrete PG* values with PGPASSWORD in env.
  const useUrl = !!env.DATABASE_URL;
  const dumpCmd = useUrl
    ? `pg_dump --no-owner --no-privileges ${JSON.stringify(env.DATABASE_URL)}`
    : `pg_dump --no-owner --no-privileges -h ${JSON.stringify(env.PGHOST)} -p ${env.PGPORT} -U ${JSON.stringify(env.PGUSER)} ${JSON.stringify(env.PGDATABASE)}`;
  const cmd = `set -o pipefail; ${dumpCmd} | gzip -9 > ${JSON.stringify(outPath)}`;
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-c', cmd], {
      env: { ...process.env, ...(useUrl ? {} : { PGPASSWORD: env.PGPASSWORD }) },
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => reject(new Error(`pg_dump could not start: ${e.message} (is pg_dump installed?)`)));
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`pg_dump failed (exit ${code}): ${err.slice(-400)}`)));
  });
}

async function saveStatus(status: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO site_settings (key, value) VALUES ('backup_last_status', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ ...status, at: new Date().toISOString() })],
  );
}

export interface BackupResult { ok: boolean; message: string; sizeBytes?: number }

/** Run a full backup now and push it to Telegram. */
export async function runBackup(opts: { includeEnv?: boolean } = {}): Promise<BackupResult> {
  const cfg = await telegramConfig();
  if (!cfg) {
    const message = 'Telegram is not configured (add the bot token + chat id in the API Hub and mark it Active).';
    await saveStatus({ ok: false, message });
    return { ok: false, message };
  }
  const dumpPath = join(tmpdir(), `rbpays-db-${stamp()}.sql.gz`);
  try {
    await dumpDatabase(dumpPath);
    const { size } = await stat(dumpPath);
    if (size > TELEGRAM_MAX) {
      const message = `DB dump is ${(size / 1048576).toFixed(1)} MB — over Telegram's ~50 MB limit. Use an off-server store for large DBs.`;
      await sendTelegramMessage(cfg, `⚠️ TutiPays backup skipped: ${message}`);
      await saveStatus({ ok: false, message, sizeBytes: size });
      return { ok: false, message, sizeBytes: size };
    }
    const caption = `🗄️ TutiPays DB backup — ${stamp()} IST (${(size / 1048576).toFixed(2)} MB). Restore: gunzip + psql into a fresh DB.`;
    const sent = await sendTelegramDocument(cfg, dumpPath, caption);
    if (!sent.ok) {
      await saveStatus({ ok: false, message: `Telegram upload failed: ${sent.error}`, sizeBytes: size });
      return { ok: false, message: `Telegram upload failed: ${sent.error}`, sizeBytes: size };
    }
    // Optionally also push the .env (secrets!) for a complete rebuild.
    if (opts.includeEnv) {
      const envPath = join(process.cwd(), '.env');
      const envSent = await sendTelegramDocument(cfg, envPath, '🔐 .env (SECRETS — keep this chat private)').catch((e) => ({ ok: false, error: (e as Error).message }));
      if (!envSent.ok) await sendTelegramMessage(cfg, `Note: .env was not attached (${'error' in envSent ? envSent.error : 'unknown'}).`);
    }
    await saveStatus({ ok: true, message: 'Backup sent to Telegram', sizeBytes: size, includeEnv: !!opts.includeEnv });
    return { ok: true, message: `Backup sent to Telegram (${(size / 1048576).toFixed(2)} MB).`, sizeBytes: size };
  } catch (err) {
    const message = (err as Error).message;
    await sendTelegramMessage(cfg, `❌ TutiPays backup failed: ${message}`).catch(() => undefined);
    await saveStatus({ ok: false, message });
    return { ok: false, message };
  } finally {
    await unlink(dumpPath).catch(() => undefined);
  }
}

/**
 * Daily backup scheduler. Reads site settings `backup_daily_hour` (0-23 IST;
 * unset/empty = disabled) and runs once per day at that hour. `backup_include_env`
 * controls whether the .env is attached. Gated on Telegram being configured.
 */
export function startBackupLoop(intervalMin = 10): () => void {
  const tick = async () => {
    try {
      const { rows } = await query<{ key: string; value: string | null }>(
        "SELECT key, value FROM site_settings WHERE key IN ('backup_daily_hour','backup_include_env','backup_last_date')",
      );
      const s: Record<string, string> = {};
      rows.forEach((r) => { s[r.key] = r.value ?? ''; });
      const hour = s.backup_daily_hour === '' ? -1 : Number(s.backup_daily_hour);
      if (!(hour >= 0 && hour <= 23)) return; // disabled
      const ist = new Date(Date.now() + (5 * 60 + 30) * 60 * 1000);
      const today = ist.toISOString().slice(0, 10);
      if (ist.getUTCHours() !== hour) return;
      if (s.backup_last_date === today) return; // already ran today
      // Mark first to avoid a double run if a tick overlaps.
      await query(
        `INSERT INTO site_settings (key, value) VALUES ('backup_last_date', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [today],
      );
      logger.info({ hour }, 'daily backup starting');
      await runBackup({ includeEnv: s.backup_include_env === 'true' });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'backup loop tick failed');
    }
  };
  const handle = setInterval(() => void tick(), intervalMin * 60_000);
  handle.unref?.();
  logger.info({ intervalMin }, 'backup loop started (gated by backup_daily_hour setting)');
  return () => clearInterval(handle);
}

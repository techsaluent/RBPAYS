-- Telegram bot slot for disaster-recovery backups & alerts.
-- Credentials live in platform_integrations: api_key = bot token (@BotFather),
-- extra.chat_id = destination chat/group id. Daily backup settings live in
-- site_settings (backup_daily_hour, backup_include_env), managed from the panel.

INSERT INTO platform_integrations (key, label, category, base_url)
VALUES ('telegram', 'Telegram Bot (backup & alerts)', 'other', 'https://api.telegram.org')
ON CONFLICT (key) DO NOTHING;

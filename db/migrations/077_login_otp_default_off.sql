-- Login email-OTP (2FA) is now OPT-IN, not mandatory by default.
-- It must not lock anyone out before the Email (SMTP) provider is configured
-- and tested, so default it OFF; the super-admin enables it in
-- Website → Security once email delivery works.

INSERT INTO site_settings (key, value)
VALUES ('security_require_login_otp', 'false')
ON CONFLICT (key) DO UPDATE SET value = 'false';

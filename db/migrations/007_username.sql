-- =====================================================================
-- Optional unique username for members. Usable for login and as a
-- wallet-to-wallet transfer target (alongside phone / email).
-- =====================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;

-- Case-insensitive uniqueness, but allow many NULLs (username is optional).
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uniq
    ON users (lower(username))
    WHERE username IS NOT NULL;

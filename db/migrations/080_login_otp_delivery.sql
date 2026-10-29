-- Track whether a login OTP was actually delivered on at least one channel.
--
-- Previously issueLoginOtp() de-duplicated resends inside a 90s window by
-- treating any recent unused code as "already sent". If the first send had
-- failed (e.g. no working email provider), the resend short-circuited and
-- reported success too — so the member waited for a code that never came.
--
-- With this flag the resend window only short-circuits when the outstanding
-- code was genuinely delivered; a failed send is retried on the next attempt,
-- and the login flow can tell the member delivery failed instead of hanging.
ALTER TABLE login_otps
  ADD COLUMN IF NOT EXISTS delivered BOOLEAN NOT NULL DEFAULT false;

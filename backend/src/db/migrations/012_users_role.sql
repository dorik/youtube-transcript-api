-- Per-user role. Drives access to the operator-only `/admin/*` endpoints
-- (cache invalidation today; reserved for future destructive or diagnostic
-- surfaces). Using a string column with a CHECK rather than a boolean so
-- we can add roles (e.g. `support_admin`, `read_only`) without further
-- schema churn — every check site is already a string compare.
--
-- Default `user` so existing accounts and new signups carry no elevated
-- privilege. Promote by hand: `UPDATE users SET role = 'sys_admin' WHERE
-- email = '<operator>';`. No self-service path — admin is granted out-
-- of-band, by the operator with DB access, not by the application.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user';

-- Validate the allowed values. `IF NOT EXISTS` isn't supported for
-- constraints in Postgres < 16 — wrap in a DO block so reruns are safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_role_check
        CHECK (role IN ('user', 'sys_admin'));
  END IF;
END $$;

-- Partial index: privileged roles are rare; the adminAuth middleware only
-- ever looks up `role = 'sys_admin'`, so indexing only those rows keeps
-- the index tiny and writes cheap for ordinary user updates.
CREATE INDEX IF NOT EXISTS idx_users_role_admin
  ON users(role)
  WHERE role = 'sys_admin';

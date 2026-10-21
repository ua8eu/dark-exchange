import { randomUUID } from "node:crypto";
import { AppError, amountToCents, hashPassword, normalizeEmail } from "./primitives";
import type { SqlDatabase } from "./postgres-store";

export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','admin')), verified SMALLINT NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
  balance_cents BIGINT NOT NULL DEFAULT 0 CHECK(balance_cents >= 0 AND balance_cents <= 10000000000), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_tokens (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK(type IN ('credit','withdrawal')), amount_cents BIGINT NOT NULL CHECK(amount_cents > 0 AND amount_cents <= 10000000000),
  status TEXT NOT NULL CHECK(status IN ('completed','pending')), reference TEXT NOT NULL UNIQUE,
  note TEXT, address TEXT, network TEXT, created_at TEXT NOT NULL, created_by TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS transactions_user ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS verification_expiry ON verification_tokens(expires_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, attempts BIGINT NOT NULL CHECK(attempts > 0), expires_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at);
`;

export async function migratePostgres(db: SqlDatabase, options: { adminEmail: string; adminPassword: string; minimumWithdrawal?: number }): Promise<void> {
  const email = normalizeEmail(options.adminEmail);
  const passwordHash = hashPassword(options.adminPassword);
  const minimum = amountToCents(options.minimumWithdrawal ?? 1000, true);
  await db.transaction(async (tx) => {
    // Serialize explicit migrations across deploy/CLI instances before any DDL or seed.
    await tx.query("SELECT pg_advisory_xact_lock(782395127)");
    for (const statement of POSTGRES_SCHEMA.split(";").map((part) => part.trim()).filter(Boolean)) await tx.query(statement);
    await tx.query("INSERT INTO settings (key,value) VALUES ('minimum_withdrawal_cents',$1) ON CONFLICT (key) DO NOTHING", [String(minimum)]);
    await tx.query("INSERT INTO users (id,email,password_hash,role,verified,created_at) VALUES ($1,$2,$3,'admin',1,$4) ON CONFLICT (email) DO NOTHING", [randomUUID(), email, passwordHash, new Date().toISOString()]);
    const { rows } = await tx.query("SELECT role,verified FROM users WHERE email = $1", [email]);
    if (rows[0]?.role !== "admin" || Number(rows[0]?.verified) !== 1) throw new AppError("ADMIN_EMAIL already belongs to a non-admin account. Choose a separate administrator email; existing accounts are never elevated by migration.", 409);
  });
}

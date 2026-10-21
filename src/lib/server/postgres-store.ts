import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { AppError, amountToCents, checkPassword, hashPassword, hashToken, normalizeEmail, publicUser, MAX_CENTS, SESSION_LIFETIME, VERIFICATION_LIFETIME, type LedgerTransaction, type Row, type User } from "./primitives";

export interface SqlExecutor { query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }> }
export interface SqlDatabase extends SqlExecutor { transaction<T>(operation: (tx: SqlExecutor) => Promise<T>): Promise<T> }

export class PostgresExchangeStore {
  constructor(private db: SqlDatabase) {}

  private async findUser(id: string, tx: SqlExecutor = this.db, lock = false): Promise<Row> {
    const { rows } = await tx.query(`SELECT * FROM users WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
    if (!rows[0]) throw new AppError("Account not found.", 404);
    return rows[0];
  }

  private async requireAdmin(id: string, tx: SqlExecutor = this.db): Promise<void> {
    const row = await this.findUser(id, tx);
    if (row.role !== "admin" || Number(row.verified) !== 1) throw new AppError("Administrator access required.", 403);
  }

  private async issueVerification(userId: string, tx: SqlExecutor): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await tx.query("DELETE FROM verification_tokens WHERE user_id = $1 OR expires_at < $2", [userId, Date.now()]);
    await tx.query("INSERT INTO verification_tokens (token_hash,user_id,expires_at) VALUES ($1,$2,$3)", [hashToken(token), userId, Date.now() + VERIFICATION_LIFETIME]);
    return token;
  }

  async register(emailInput: unknown, password: string): Promise<{ user: User; token: string }> {
    const email = normalizeEmail(emailInput);
    const encoded = hashPassword(password);
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query("INSERT INTO users (id,email,password_hash,role,verified,created_at) VALUES ($1,$2,$3,'user',0,$4) ON CONFLICT (email) DO NOTHING RETURNING *", [randomUUID(), email, encoded, new Date().toISOString()]);
      if (!rows[0]) throw new AppError("An account already exists for this email. Sign in or resend verification.", 409);
      return { user: publicUser(rows[0]), token: await this.issueVerification(String(rows[0].id), tx) };
    });
  }

  async resendVerification(emailInput: unknown): Promise<{ email: string; token: string } | null> {
    const email = normalizeEmail(emailInput);
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query("SELECT * FROM users WHERE email = $1 FOR UPDATE", [email]);
      if (!rows[0] || Number(rows[0].verified) === 1) return null;
      return { email, token: await this.issueVerification(String(rows[0].id), tx) };
    });
  }

  async verifyEmail(token: string, now = Date.now()): Promise<void> {
    if (typeof token !== "string" || token.length < 32 || token.length > 128) throw new AppError("This verification link is invalid or expired.");
    await this.db.transaction(async (tx) => {
      // Lock the account before its tokens, matching resend's lock order.
      const { rows: candidates } = await tx.query("SELECT user_id FROM verification_tokens WHERE token_hash = $1 AND expires_at > $2", [hashToken(token), now]);
      if (!candidates[0]) throw new AppError("This verification link is invalid or expired.");
      const id = String(candidates[0].user_id);
      await this.findUser(id, tx, true);
      const { rows } = await tx.query("DELETE FROM verification_tokens WHERE token_hash = $1 AND expires_at > $2 RETURNING user_id", [hashToken(token), now]);
      if (!rows[0]) throw new AppError("This verification link is invalid or expired.");
      await tx.query("UPDATE users SET verified = 1 WHERE id = $1", [id]);
      await tx.query("DELETE FROM verification_tokens WHERE user_id = $1", [id]);
    });
  }

  private async newSession(user: User): Promise<{ user: User; token: string }> {
    const token = randomBytes(32).toString("base64url");
    await this.db.query("DELETE FROM sessions WHERE expires_at < $1", [Date.now()]);
    await this.db.query("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)", [hashToken(token), user.id, Date.now() + SESSION_LIFETIME]);
    return { user, token };
  }

  async login(emailInput: unknown, password: string): Promise<{ user: User; token: string }> {
    const email = normalizeEmail(emailInput);
    const { rows } = await this.db.query("SELECT * FROM users WHERE email = $1", [email]);
    const row = rows[0];
    if (!row) {
      scryptSync(typeof password === "string" ? password.slice(0, 128) : "", "unregistered-account", 64);
      throw new AppError("Email or password is incorrect.", 401);
    }
    if (!checkPassword(password, String(row.password_hash))) throw new AppError("Email or password is incorrect.", 401);
    if (Number(row.verified) !== 1) throw new AppError("Verify your email address before signing in.", 403);
    return this.newSession(publicUser(row));
  }

  async session(token: string | undefined, now = Date.now()): Promise<User | null> {
    if (!token || token.length > 128) return null;
    const { rows } = await this.db.query("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.verified = 1", [hashToken(token), now]);
    return rows[0] ? publicUser(rows[0]) : null;
  }

  async logout(token: string | undefined): Promise<void> { if (token) await this.db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]); }

  async createDemoSession(): Promise<{ user: User; token: string }> {
    const id = randomUUID();
    const user = await this.db.transaction(async (tx) => {
      const { rows } = await tx.query("INSERT INTO users (id,email,password_hash,role,verified,created_at) VALUES ($1,$2,$3,'user',1,$4) RETURNING *", [id, `preview-${randomBytes(6).toString("hex")}@demo.invalid`, hashPassword(randomBytes(32).toString("hex")), new Date().toISOString()]);
      await this.addCredit(tx, id, 1_245_075, "Initial demonstration balance. No monetary value.", id);
      return publicUser(rows[0]);
    });
    return this.newSession(user);
  }

  async minimumWithdrawal(tx: SqlExecutor = this.db): Promise<number> {
    const { rows } = await tx.query("SELECT value FROM settings WHERE key = 'minimum_withdrawal_cents'");
    if (!rows[0]) throw new AppError("Database is not initialized. Run the database migration.", 503);
    return Number(rows[0].value) / 100;
  }

  async wallet(userId: string) {
    // One PostgreSQL statement gives the balance and ledger a consistent snapshot.
    const { rows } = await this.db.query(`SELECT u.balance_cents,
      (SELECT value FROM settings WHERE key = 'minimum_withdrawal_cents') AS minimum_cents,
      EXISTS(SELECT 1 FROM transactions WHERE user_id = u.id AND type = 'withdrawal') AS has_withdrawal,
      COALESCE((SELECT json_agg(t ORDER BY t.created_at DESC, t.id DESC) FROM
        (SELECT * FROM transactions WHERE user_id = u.id ORDER BY created_at DESC, id DESC LIMIT 100) t), '[]'::json) AS ledger
      FROM users u WHERE u.id = $1`, [userId]);
    const row = rows[0];
    if (!row) throw new AppError("Account not found.", 404);
    const ledger = row.ledger as Row[];
    const transactions: LedgerTransaction[] = ledger.map((entry) => ({
      id: String(entry.id), type: entry.type as LedgerTransaction["type"], amount: Number(entry.amount_cents) / 100,
      createdAt: String(entry.created_at), status: entry.status as LedgerTransaction["status"], reference: String(entry.reference),
      ...(entry.note ? { note: String(entry.note) } : {}), ...(entry.address ? { address: String(entry.address) } : {}), ...(entry.network ? { network: String(entry.network) } : {}),
    }));
    if (row.minimum_cents === null) throw new AppError("Database is not initialized. Run the database migration.", 503);
    return { balance: Number(row.balance_cents) / 100, transactions, minimumWithdrawal: Number(row.minimum_cents) / 100, firstWithdrawal: !row.has_withdrawal };
  }

  async withdraw(userId: string, amount: unknown, addressInput: unknown, networkInput: unknown) {
    const cents = amountToCents(amount);
    if (typeof addressInput !== "string" || addressInput.trim().length < 20 || addressInput.trim().length > 160 || /\s/.test(addressInput.trim())) throw new AppError("Enter a valid wallet address (20–160 characters).");
    if (typeof networkInput !== "string" || !["TRC20", "ERC20", "BEP20", "SOL"].includes(networkInput)) throw new AppError("Select a supported network.");
    await this.db.transaction(async (tx) => {
      const user = await this.findUser(userId, tx, true);
      if (Number(user.verified) !== 1) throw new AppError("Verify your email before requesting a demo withdrawal.", 403);
      const { rows } = await tx.query("SELECT 1 FROM transactions WHERE user_id = $1 AND type = 'withdrawal' LIMIT 1", [userId]);
      const minimum = await this.minimumWithdrawal(tx);
      if (!rows[0] && cents < Math.round(minimum * 100)) throw new AppError(`Your first demo withdrawal must be at least ${minimum.toLocaleString("en-US")} TEST USDT.`);
      const result = await tx.query("UPDATE users SET balance_cents = balance_cents - $1 WHERE id = $2 AND balance_cents >= $1 RETURNING id", [cents, userId]);
      if (!result.rows[0]) throw new AppError("Insufficient TEST USDT balance.");
      await tx.query("INSERT INTO transactions (id,user_id,type,amount_cents,status,reference,note,address,network,created_at,created_by) VALUES ($1,$2,'withdrawal',$3,'pending',$4,$5,$6,$7,$8,$9)", [randomUUID(), userId, cents, `SIM-WD-${randomBytes(8).toString("hex").toUpperCase()}`, "Demo withdrawal request; no blockchain transfer occurs.", addressInput.trim(), networkInput, new Date().toISOString(), userId]);
    });
    return this.wallet(userId);
  }

  private async addCredit(tx: SqlExecutor, userId: string, cents: number, note: string, actorId: string): Promise<void> {
    const user = await this.findUser(userId, tx, true);
    if (Number(user.balance_cents) + cents > MAX_CENTS) throw new AppError("This credit would exceed the demo account balance limit.");
    await tx.query("UPDATE users SET balance_cents = balance_cents + $1 WHERE id = $2", [cents, userId]);
    await tx.query("INSERT INTO transactions (id,user_id,type,amount_cents,status,reference,note,created_at,created_by) VALUES ($1,$2,'credit',$3,'completed',$4,$5,$6,$7)", [randomUUID(), userId, cents, `SIM-CR-${randomBytes(8).toString("hex").toUpperCase()}`, note, new Date().toISOString(), actorId]);
  }

  async credit(actorId: string, userId: unknown, amount: unknown, noteInput: unknown) {
    const cents = amountToCents(amount);
    if (typeof userId !== "string" || userId.length > 100) throw new AppError("Choose an account.");
    if (noteInput !== undefined && (typeof noteInput !== "string" || noteInput.length > 240)) throw new AppError("Use a note of up to 240 characters.");
    const note = typeof noteInput === "string" && noteInput.trim() ? `Admin demo credit: ${noteInput.trim()}` : "Admin-issued TEST USDT. No monetary value.";
    await this.db.transaction(async (tx) => { await this.requireAdmin(actorId, tx); await this.addCredit(tx, userId, cents, note, actorId); });
    return this.wallet(userId);
  }

  async admin(actorId: string) {
    await this.requireAdmin(actorId);
    const { rows } = await this.db.query("SELECT id,email,verified,balance_cents,created_at FROM users ORDER BY created_at DESC LIMIT 500");
    return { users: rows.map((row) => ({ id: String(row.id), email: String(row.email), verified: Number(row.verified) === 1, balance: Number(row.balance_cents) / 100, createdAt: String(row.created_at) })), minimumWithdrawal: await this.minimumWithdrawal() };
  }

  async setMinimumWithdrawal(actorId: string, amount: unknown) {
    await this.requireAdmin(actorId);
    const cents = amountToCents(amount, true);
    await this.db.query("UPDATE settings SET value = $1 WHERE key = 'minimum_withdrawal_cents'", [String(cents)]);
    return { minimumWithdrawal: cents / 100 };
  }

  async consumeRateLimit(key: string, maximum: number, windowMs: number): Promise<void> {
    const now = Date.now();
    await this.db.query("DELETE FROM rate_limits WHERE expires_at <= $1", [now]);
    const { rows } = await this.db.query(`INSERT INTO rate_limits (key,attempts,expires_at) VALUES ($1,1,$2)
      ON CONFLICT (key) DO UPDATE SET attempts = CASE WHEN rate_limits.expires_at <= $3 THEN 1 ELSE rate_limits.attempts + 1 END,
      expires_at = CASE WHEN rate_limits.expires_at <= $3 THEN $2 ELSE rate_limits.expires_at END RETURNING attempts`, [key, now + windowMs, now]);
    if (Number(rows[0].attempts) > maximum) throw new AppError("Too many attempts. Please try again later.", 429);
  }

  async resetRateLimit(key: string): Promise<void> { await this.db.query("DELETE FROM rate_limits WHERE key = $1", [key]); }
}

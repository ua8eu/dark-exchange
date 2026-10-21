import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError, amountToCents, checkPassword, hashPassword, hashToken, normalizeEmail, publicUser, MAX_CENTS, SESSION_LIFETIME, VERIFICATION_LIFETIME, type LedgerTransaction, type Row, type User } from "./primitives";
export { AppError, amountToCents, checkPassword, hashPassword, hashToken, normalizeEmail, type LedgerTransaction, type User } from "./primitives";
type StoreOptions = { databasePath: string; adminEmail?: string; adminPassword?: string; minimumWithdrawal?: number };
export class ExchangeStore {
  private db: DatabaseSync;

  constructor(options: StoreOptions) {
    if (options.databasePath !== ":memory:") mkdirSync(dirname(options.databasePath), { recursive: true });
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','admin')), verified INTEGER NOT NULL DEFAULT 0,
        balance_cents INTEGER NOT NULL DEFAULT 0 CHECK(balance_cents >= 0), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verification_tokens (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        type TEXT NOT NULL CHECK(type IN ('credit','withdrawal')), amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
        status TEXT NOT NULL CHECK(status IN ('completed','pending')), reference TEXT NOT NULL UNIQUE,
        note TEXT, address TEXT, network TEXT, created_at TEXT NOT NULL, created_by TEXT REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS transactions_user ON transactions(user_id, created_at);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const minimum = amountToCents(options.minimumWithdrawal ?? 1000, true);
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('minimum_withdrawal_cents', ?)").run(String(minimum));
    if (options.adminEmail && options.adminPassword) {
      const email = normalizeEmail(options.adminEmail);
      if (!this.db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
        this.db.prepare("INSERT INTO users (id,email,password_hash,role,verified,created_at) VALUES (?,?,?,'admin',1,?)")
          .run(randomUUID(), email, hashPassword(options.adminPassword), new Date().toISOString());
      }
    }
  }

  close(): void { this.db.close(); }

  private atomic<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private findUser(id: string): Row {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new AppError("Account not found.", 404);
    return row;
  }

  private requireAdmin(id: string): void {
    const row = this.findUser(id);
    if (row.role !== "admin" || Number(row.verified) !== 1) throw new AppError("Administrator access required.", 403);
  }

  register(emailInput: unknown, password: string): { user: User; token: string } {
    const email = normalizeEmail(emailInput);
    const passwordHash = hashPassword(password);
    return this.atomic(() => {
      if (this.db.prepare("SELECT id FROM users WHERE email = ?").get(email)) throw new AppError("An account already exists for this email. Sign in or resend verification.", 409);
      const id = randomUUID();
      this.db.prepare("INSERT INTO users (id,email,password_hash,role,verified,created_at) VALUES (?,?,?,'user',0,?)").run(id, email, passwordHash, new Date().toISOString());
      return { user: publicUser(this.findUser(id)), token: this.issueVerification(id) };
    });
  }

  private issueVerification(userId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM verification_tokens WHERE user_id = ? OR expires_at < ?").run(userId, Date.now());
    this.db.prepare("INSERT INTO verification_tokens (token_hash,user_id,expires_at) VALUES (?,?,?)").run(hashToken(token), userId, Date.now() + VERIFICATION_LIFETIME);
    return token;
  }

  resendVerification(emailInput: unknown): { email: string; token: string } | null {
    const email = normalizeEmail(emailInput);
    return this.atomic(() => {
      const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as Row | undefined;
      if (!row || Number(row.verified) === 1) return null;
      return { email, token: this.issueVerification(String(row.id)) };
    });
  }

  verifyEmail(token: string, now = Date.now()): void {
    if (typeof token !== "string" || token.length < 32 || token.length > 128) throw new AppError("This verification link is invalid or expired.");
    this.atomic(() => {
      const row = this.db.prepare("SELECT * FROM verification_tokens WHERE token_hash = ? AND expires_at > ?").get(hashToken(token), now) as Row | undefined;
      if (!row) throw new AppError("This verification link is invalid or expired.");
      this.db.prepare("UPDATE users SET verified = 1 WHERE id = ?").run(String(row.user_id));
      this.db.prepare("DELETE FROM verification_tokens WHERE user_id = ?").run(String(row.user_id));
    });
  }

  login(emailInput: unknown, password: string): { user: User; token: string } {
    const email = normalizeEmail(emailInput);
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as Row | undefined;
    if (!row) {
      // Keep the expensive password derivation on unknown-account attempts, too.
      scryptSync(typeof password === "string" ? password.slice(0, 128) : "", "unregistered-account", 64);
      throw new AppError("Email or password is incorrect.", 401);
    }
    if (!checkPassword(password, String(row.password_hash))) throw new AppError("Email or password is incorrect.", 401);
    if (Number(row.verified) !== 1) throw new AppError("Verify your email address before signing in.", 403);
    return this.newSession(publicUser(row));
  }

  private newSession(user: User): { user: User; token: string } {
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    this.db.prepare("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)").run(hashToken(token), user.id, Date.now() + SESSION_LIFETIME);
    return { user, token };
  }

  session(token: string | undefined, now = Date.now()): User | null {
    if (!token || token.length > 128) return null;
    const row = this.db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.verified = 1").get(hashToken(token), now) as Row | undefined;
    return row ? publicUser(row) : null;
  }

  logout(token: string | undefined): void { if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token)); }

  createDemoSession(): { user: User; token: string } {
    const id = randomUUID();
    this.atomic(() => {
      this.db.prepare("INSERT INTO users (id,email,password_hash,role,verified,created_at) VALUES (?,?,?,'user',1,?)")
        .run(id, `preview-${randomBytes(6).toString("hex")}@demo.invalid`, hashPassword(randomBytes(32).toString("hex")), new Date().toISOString());
      this.addCredit(id, 1_245_075, "Initial demonstration balance. No monetary value.", id);
    });
    return this.newSession(publicUser(this.findUser(id)));
  }

  wallet(userId: string) {
    const user = this.findUser(userId);
    const rows = this.db.prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100").all(userId) as Row[];
    const hasWithdrawal = this.db.prepare("SELECT 1 FROM transactions WHERE user_id = ? AND type = 'withdrawal' LIMIT 1").get(userId);
    const transactions: LedgerTransaction[] = rows.map((row) => ({
      id: String(row.id), type: row.type as LedgerTransaction["type"], amount: Number(row.amount_cents) / 100,
      createdAt: String(row.created_at), status: row.status as LedgerTransaction["status"], reference: String(row.reference),
      ...(row.note ? { note: String(row.note) } : {}), ...(row.address ? { address: String(row.address) } : {}), ...(row.network ? { network: String(row.network) } : {}),
    }));
    return { balance: Number(user.balance_cents) / 100, transactions, minimumWithdrawal: this.minimumWithdrawal(), firstWithdrawal: !hasWithdrawal };
  }

  minimumWithdrawal(): number {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'minimum_withdrawal_cents'").get() as Row;
    return Number(row.value) / 100;
  }

  withdraw(userId: string, amount: unknown, addressInput: unknown, networkInput: unknown) {
    const cents = amountToCents(amount);
    if (typeof addressInput !== "string" || addressInput.trim().length < 20 || addressInput.trim().length > 160 || /\s/.test(addressInput.trim())) throw new AppError("Enter a valid wallet address (20–160 characters).");
    if (typeof networkInput !== "string" || !["TRC20", "ERC20", "BEP20", "SOL"].includes(networkInput)) throw new AppError("Select a supported network.");
    const address = addressInput.trim();
    this.atomic(() => {
      const user = this.findUser(userId);
      if (Number(user.verified) !== 1) throw new AppError("Verify your email before requesting a demo withdrawal.", 403);
      const previous = this.db.prepare("SELECT 1 FROM transactions WHERE user_id = ? AND type = 'withdrawal' LIMIT 1").get(userId);
      if (!previous && cents < Math.round(this.minimumWithdrawal() * 100)) throw new AppError(`Your first demo withdrawal must be at least ${this.minimumWithdrawal().toLocaleString("en-US")} TEST USDT.`);
      const result = this.db.prepare("UPDATE users SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?").run(cents, userId, cents);
      if (Number(result.changes) !== 1) throw new AppError("Insufficient TEST USDT balance.");
      this.db.prepare("INSERT INTO transactions (id,user_id,type,amount_cents,status,reference,note,address,network,created_at,created_by) VALUES (?,?,'withdrawal',?,'pending',?,?,?,?,?,?)")
        .run(randomUUID(), userId, cents, `SIM-WD-${randomBytes(8).toString("hex").toUpperCase()}`, "Demo withdrawal request; no blockchain transfer occurs.", address, networkInput, new Date().toISOString(), userId);
    });
    return this.wallet(userId);
  }

  private addCredit(userId: string, cents: number, note: string, actorId: string): void {
    const user = this.findUser(userId);
    if (Number(user.balance_cents) + cents > MAX_CENTS) throw new AppError("This credit would exceed the demo account balance limit.");
    this.db.prepare("UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?").run(cents, userId);
    this.db.prepare("INSERT INTO transactions (id,user_id,type,amount_cents,status,reference,note,created_at,created_by) VALUES (?,?,'credit',?,'completed',?,?,?,?)")
      .run(randomUUID(), userId, cents, `SIM-CR-${randomBytes(8).toString("hex").toUpperCase()}`, note, new Date().toISOString(), actorId);
  }

  credit(actorId: string, userId: unknown, amount: unknown, noteInput: unknown) {
    this.requireAdmin(actorId);
    const cents = amountToCents(amount);
    if (typeof userId !== "string" || userId.length > 100) throw new AppError("Choose an account.");
    if (noteInput !== undefined && (typeof noteInput !== "string" || noteInput.length > 240)) throw new AppError("Use a note of up to 240 characters.");
    const note = typeof noteInput === "string" && noteInput.trim() ? `Admin demo credit: ${noteInput.trim()}` : "Admin-issued TEST USDT. No monetary value.";
    this.atomic(() => this.addCredit(userId, cents, note, actorId));
    return this.wallet(userId);
  }

  admin(actorId: string) {
    this.requireAdmin(actorId);
    const rows = this.db.prepare("SELECT id,email,verified,balance_cents,created_at FROM users ORDER BY created_at DESC LIMIT 500").all() as Row[];
    return { users: rows.map((row) => ({ id: String(row.id), email: String(row.email), verified: Number(row.verified) === 1, balance: Number(row.balance_cents) / 100, createdAt: String(row.created_at) })), minimumWithdrawal: this.minimumWithdrawal() };
  }

  setMinimumWithdrawal(actorId: string, amount: unknown) {
    this.requireAdmin(actorId);
    const cents = amountToCents(amount, true);
    this.db.prepare("UPDATE settings SET value = ? WHERE key = 'minimum_withdrawal_cents'").run(String(cents));
    return { minimumWithdrawal: cents / 100 };
  }
}

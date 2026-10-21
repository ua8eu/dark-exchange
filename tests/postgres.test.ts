import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { PostgresExchangeStore, type SqlDatabase, type SqlExecutor } from '../src/lib/server/postgres-store';
import { migratePostgres } from '../src/lib/server/postgres-schema';
import { AppError, amountToCents, hashToken } from '../src/lib/server/primitives';

const ADMIN_EMAIL = 'postgres-operator@example.test';
const ADMIN_PASSWORD = 'postgres-admin-unique-password';
const USER_PASSWORD = 'postgres-member-unique-password';
const ADDRESS = '0x1111111111111111111111111111111111111111';

// Exercise the production SQL against a real PostgreSQL engine without credentials,
// an external service, or a mock SQL parser.
function executor(connection: Pick<PGlite | Transaction, 'query' | 'exec'>): SqlExecutor {
  return {
    async query(text: string, values?: unknown[]) {
      // node-postgres uses the simple-query protocol for parameterless SQL,
      // including a migration containing multiple statements. PGlite exposes
      // that protocol as exec; query always uses a prepared statement.
      if (values === undefined) {
        const results = await connection.exec(text);
        const result = results[results.length - 1];
        return { rows: result?.rows ?? [], rowCount: result?.affectedRows ?? result?.rowCount ?? result?.rows.length ?? 0 };
      }
      const result = await connection.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rowCount ?? result.rows.length };
    },
  };
}

async function fixture() {
  const engine = await PGlite.create();
  const db: SqlDatabase = {
    ...executor(engine),
    transaction: operation => engine.transaction(tx => operation(executor(tx))),
  };
  await migratePostgres(db, { adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD, minimumWithdrawal: 100 });
  const store = new PostgresExchangeStore(db);
  const admin = (await store.login(ADMIN_EMAIL, ADMIN_PASSWORD)).user;
  const registration = await store.register('postgres-member@example.test', USER_PASSWORD);
  await store.verifyEmail(registration.token);
  const user = (await store.login(registration.user.email, USER_PASSWORD)).user;
  return { engine, db, store, admin, user, dispose: () => engine.close() };
}

function status(expected: number) {
  return (error: unknown) => error instanceof AppError && error.status === expected;
}

test('Postgres: verification, hashed secrets, session expiry, and ordinary-user role boundaries', async () => {
  const f = await fixture();
  try {
    const registration = await f.store.register('  New.Member@Example.Test  ', USER_PASSWORD);
    assert.equal(registration.user.email, 'new.member@example.test');
    assert.equal(registration.user.role, 'user');
    assert.equal(registration.user.verified, false);
    await assert.rejects(() => f.store.login(registration.user.email, USER_PASSWORD), status(403));
    await assert.rejects(() => f.store.register(registration.user.email, USER_PASSWORD), status(409));
    await assert.rejects(() => f.store.register('short-password@example.test', 'short'), status(400));

    const verification = await f.db.query('SELECT token_hash FROM verification_tokens WHERE user_id = $1', [registration.user.id]);
    assert.equal(verification.rows[0].token_hash, hashToken(registration.token));
    assert.notEqual(verification.rows[0].token_hash, registration.token);
    await assert.rejects(() => f.store.verifyEmail(registration.token, Date.now() + 25 * 60 * 60_000), /invalid or expired/);
    const replacement = (await f.store.resendVerification(registration.user.email))!;
    assert.notEqual(replacement.token, registration.token);
    await assert.rejects(() => f.store.verifyEmail(registration.token), /invalid or expired/);
    await f.store.verifyEmail(replacement.token);
    await assert.rejects(() => f.store.verifyEmail(replacement.token), /invalid or expired/);
    await assert.rejects(() => f.store.login(registration.user.email, 'incorrect-long-password'), status(401));

    const login = await f.store.login(registration.user.email, USER_PASSWORD);
    assert.equal(login.user.verified, true);
    assert.equal((await f.store.session(login.token))?.id, registration.user.id);
    const sessions = await f.db.query('SELECT token_hash FROM sessions WHERE user_id = $1', [registration.user.id]);
    assert.ok(sessions.rows.some(row => row.token_hash === hashToken(login.token)));
    assert.ok(sessions.rows.every(row => row.token_hash !== login.token));
    const secret = await f.db.query('SELECT password_hash FROM users WHERE id = $1', [registration.user.id]);
    assert.notEqual(secret.rows[0].password_hash, USER_PASSWORD);
    assert.equal(String(secret.rows[0].password_hash).includes(USER_PASSWORD), false);
    assert.equal(await f.store.session(login.token, Date.now() + 8 * 24 * 60 * 60_000), null);
    await f.store.logout(login.token);
    assert.equal(await f.store.session(login.token), null);

    await assert.rejects(() => f.store.admin(f.user.id), status(403));
    await assert.rejects(() => f.store.credit(f.user.id, f.user.id, 100, 'unauthorized'), status(403));
    await assert.rejects(() => f.store.setMinimumWithdrawal(f.user.id, 0), status(403));
    assert.equal((await f.store.wallet(f.user.id)).balance, 0);
  } finally { await f.dispose(); }
});

test('Postgres: credits preserve integer cents and reject invalid amounts without changing the ledger', async () => {
  const f = await fixture();
  try {
    await f.store.credit(f.admin.id, f.user.id, 0.1, 'First allocation');
    await f.store.credit(f.admin.id, f.user.id, 0.2, 'Second allocation');
    const wallet = await f.store.wallet(f.user.id);
    assert.equal(wallet.balance, 0.3);
    assert.equal(wallet.transactions.length, 2);
    assert.equal(wallet.transactions.reduce((total, entry) => total + amountToCents(entry.amount), 0), 30);
    assert.ok(wallet.transactions.every(entry => entry.status === 'completed' && entry.reference.startsWith('SIM-CR-')));
    for (const amount of [0.001, -1, 0, Number.NaN, Number.POSITIVE_INFINITY, 100_000_000.01]) {
      await assert.rejects(() => f.store.credit(f.admin.id, f.user.id, amount, 'Invalid allocation'), status(400));
    }
    assert.equal((await f.store.wallet(f.user.id)).balance, 0.3);
    assert.equal((await f.store.wallet(f.user.id)).transactions.length, 2);
  } finally { await f.dispose(); }
});

test('Postgres: first withdrawal minimum, pending balance reservation, and overspend rejection', async () => {
  const f = await fixture();
  try {
    await f.store.credit(f.admin.id, f.user.id, 150.75, 'Sandbox allocation');
    await assert.rejects(() => f.store.withdraw(f.user.id, 99.99, ADDRESS, 'ERC20'), /at least 100/);
    assert.equal((await f.store.wallet(f.user.id)).balance, 150.75);
    assert.equal((await f.store.wallet(f.user.id)).transactions.length, 1);
    const first = await f.store.withdraw(f.user.id, 100, ADDRESS, 'ERC20');
    assert.equal(first.balance, 50.75);
    assert.equal(first.firstWithdrawal, false);
    assert.equal(first.transactions[0].status, 'pending');
    assert.equal(first.transactions[0].address, ADDRESS);
    assert.equal(first.transactions[0].network, 'ERC20');
    assert.match(first.transactions[0].reference, /^SIM-WD-/);
    const second = await f.store.withdraw(f.user.id, 0.75, ADDRESS, 'ERC20');
    assert.equal(second.balance, 50);
    await assert.rejects(() => f.store.withdraw(f.user.id, 50.01, ADDRESS, 'ERC20'), /Insufficient/);
    await assert.rejects(() => f.store.withdraw(f.user.id, 1, 'invalid-address', 'ERC20'), /wallet address/);
    await assert.rejects(() => f.store.withdraw(f.user.id, 1, ADDRESS, 'invalid-network'), /supported network/);
    const unchanged = await f.store.wallet(f.user.id);
    assert.equal(unchanged.balance, 50);
    assert.equal(unchanged.transactions.length, 3);
  } finally { await f.dispose(); }
});

test('Postgres: a failed ledger insert rolls back both credits and withdrawals', async () => {
  const f = await fixture();
  async function blockLedger() {
    await f.db.query("CREATE FUNCTION test_fail_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced ledger failure'; END; $$");
    await f.db.query('CREATE TRIGGER test_block_ledger BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION test_fail_ledger()');
  }
  async function unblockLedger() {
    await f.db.query('DROP TRIGGER test_block_ledger ON transactions');
    await f.db.query('DROP FUNCTION test_fail_ledger()');
  }
  try {
    await blockLedger();
    await assert.rejects(() => f.store.credit(f.admin.id, f.user.id, 500, 'Must roll back'), /forced ledger failure/);
    assert.equal((await f.store.wallet(f.user.id)).balance, 0);
    assert.equal((await f.store.wallet(f.user.id)).transactions.length, 0);
    await unblockLedger();
    await f.store.credit(f.admin.id, f.user.id, 500, 'Valid allocation');
    await blockLedger();
    await assert.rejects(() => f.store.withdraw(f.user.id, 100, ADDRESS, 'ERC20'), /forced ledger failure/);
    const wallet = await f.store.wallet(f.user.id);
    assert.equal(wallet.balance, 500);
    assert.equal(wallet.transactions.length, 1);
    assert.equal(wallet.firstWithdrawal, true);
  } finally { await f.dispose(); }
});

test('Postgres: settings and admin seed survive new store instances and repeat migrations', async () => {
  const f = await fixture();
  try {
    await f.store.setMinimumWithdrawal(f.admin.id, 225.25);
    await migratePostgres(f.db, { adminEmail: ADMIN_EMAIL, adminPassword: 'a-different-seed-password', minimumWithdrawal: 0 });
    const another = new PostgresExchangeStore(f.db);
    assert.equal(await another.minimumWithdrawal(), 225.25);
    assert.equal((await another.login(ADMIN_EMAIL, ADMIN_PASSWORD)).user.id, f.admin.id);
    await assert.rejects(() => another.login(ADMIN_EMAIL, 'a-different-seed-password'), status(401));
    const admins = await f.db.query("SELECT id FROM users WHERE role = 'admin'");
    assert.equal(admins.rows.length, 1);
    await f.store.credit(f.admin.id, f.user.id, 250, 'Sandbox allocation');
    await assert.rejects(() => another.withdraw(f.user.id, 225.24, ADDRESS, 'ERC20'), /at least 225.25/);
    assert.equal((await another.wallet(f.user.id)).balance, 250);

    await assert.rejects(() => migratePostgres(f.db, { adminEmail: f.user.email, adminPassword: ADMIN_PASSWORD, minimumWithdrawal: 1 }), status(409));
    assert.equal((await another.login(f.user.email, USER_PASSWORD)).user.role, 'user');
    await f.db.query('UPDATE users SET verified = 0 WHERE id = $1', [f.admin.id]);
    await assert.rejects(() => another.admin(f.admin.id), status(403));
    await assert.rejects(() => another.credit(f.admin.id, f.user.id, 1, 'Blocked'), status(403));
    await assert.rejects(() => another.setMinimumWithdrawal(f.admin.id, 0), status(403));
  } finally { await f.dispose(); }
});

test('Postgres: durable rate limits are shared across instances, expire, and reset', async () => {
  const f = await fixture();
  try {
    const another = new PostgresExchangeStore(f.db);
    const key = 'test-login-rate-limit';
    await f.store.consumeRateLimit(key, 2, 60_000);
    await another.consumeRateLimit(key, 2, 60_000);
    await assert.rejects(() => f.store.consumeRateLimit(key, 2, 60_000), status(429));
    await assert.rejects(() => another.consumeRateLimit(key, 2, 60_000), status(429));
    await f.db.query('UPDATE rate_limits SET expires_at = 0 WHERE key = $1', [key]);
    await another.consumeRateLimit(key, 2, 60_000);
    await f.store.consumeRateLimit(key, 2, 60_000);
    await assert.rejects(() => another.consumeRateLimit(key, 2, 60_000), status(429));
    await f.store.resetRateLimit(key);
    const rows = await f.db.query('SELECT key FROM rate_limits WHERE key = $1', [key]);
    assert.equal(rows.rows.length, 0);
    await another.consumeRateLimit(key, 2, 60_000);
  } finally { await f.dispose(); }
});

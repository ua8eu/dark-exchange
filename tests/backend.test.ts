import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { AppError, ExchangeStore, amountToCents, checkPassword, hashPassword, hashToken, normalizeEmail } from "../src/lib/server/store";
import { GET, POST, PATCH } from "../src/app/api/[...path]/route";
import { sendVerification } from "../src/lib/server/mail";
import { appUrl } from "../src/lib/server/runtime";

const ADMIN_EMAIL = "operator@example.test";
const ADMIN_PASSWORD = "a-long-unique-test-password";
const USER_PASSWORD = "another-long-test-password";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "aster-ledger-"));
  const databasePath = join(directory, "test.sqlite");
  const store = new ExchangeStore({ databasePath, adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD, minimumWithdrawal: 100 });
  const admin = store.login(ADMIN_EMAIL, ADMIN_PASSWORD).user;
  const registration = store.register("member@example.test", USER_PASSWORD);
  store.verifyEmail(registration.token);
  const user = store.login("member@example.test", USER_PASSWORD).user;
  return { store, admin, user, databasePath, dispose() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function errorWithStatus(status: number) {
  return (error: unknown) => error instanceof AppError && error.status === status;
}

test("email validation accepts a single mailbox and rejects recipient lists and header syntax", () => {
  assert.equal(normalizeEmail(" Member+test@Example.Test "), "member+test@example.test");
  for (const email of ["victim@example.test,attacker", "victim@example.test;attacker", "Name<victim@example.test>", "victim@example.test\r\nBcc:attacker@example.test", ".member@example.test", "member..test@example.test", "member@-example.test", "member@example..test"]) {
    assert.throws(() => normalizeEmail(email), errorWithStatus(400), email);
  }
});

test("passwords are salted; verification and session tokens expire and cannot be reused", () => {
  const store = new ExchangeStore({ databasePath: ":memory:" });
  try {
    const first = hashPassword(USER_PASSWORD);
    const second = hashPassword(USER_PASSWORD);
    assert.notEqual(first, second);
    assert.equal(checkPassword(USER_PASSWORD, first), true);
    assert.equal(checkPassword("incorrect-password", first), false);
    assert.equal(first.includes(USER_PASSWORD), false);
    assert.throws(() => hashPassword("short"), errorWithStatus(400));

    const registration = store.register("  Member@Example.Test  ", USER_PASSWORD);
    assert.equal(registration.user.email, "member@example.test");
    assert.equal(registration.user.role, "user");
    assert.equal(registration.user.verified, false);
    assert.throws(() => store.login(registration.user.email, USER_PASSWORD), errorWithStatus(403));
    assert.throws(() => store.verifyEmail(registration.token, Date.now() + 25 * 60 * 60_000), /invalid or expired/);
    const replacement = store.resendVerification(registration.user.email)!;
    assert.notEqual(replacement.token, registration.token);
    assert.throws(() => store.verifyEmail(registration.token), /invalid or expired/);
    store.verifyEmail(replacement.token);
    assert.throws(() => store.verifyEmail(replacement.token), /invalid or expired/);
    assert.throws(() => store.login(registration.user.email, "incorrect-password"), errorWithStatus(401));
    const session = store.login(registration.user.email, USER_PASSWORD);
    assert.equal(store.session(session.token)?.id, registration.user.id);
    assert.equal(store.session(session.token, Date.now() + 8 * 24 * 60 * 60_000), null);
    store.logout(session.token);
    assert.equal(store.session(session.token), null);
  } finally { store.close(); }
});

test("admin credits add exact integer cents and unprivileged accounts cannot mutate other users or settings", () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.credit(f.user.id, f.user.id, 100, "unauthorized"), errorWithStatus(403));
    assert.throws(() => f.store.admin(f.user.id), errorWithStatus(403));
    assert.throws(() => f.store.setMinimumWithdrawal(f.user.id, 0), errorWithStatus(403));
    f.store.credit(f.admin.id, f.user.id, 0.1, "First demo credit");
    f.store.credit(f.admin.id, f.user.id, 0.2, "Second demo credit");
    const wallet = f.store.wallet(f.user.id);
    assert.equal(wallet.balance, 0.3);
    assert.equal(wallet.transactions.length, 2);
    assert.equal(wallet.transactions.reduce((sum, entry) => sum + amountToCents(entry.amount), 0), 30);
    assert.match(wallet.transactions[0].reference, /^SIM-CR-/);
    assert.equal(wallet.transactions[0].status, "completed");
    assert.throws(() => f.store.credit(f.admin.id, f.user.id, 0.001, "fraction"), errorWithStatus(400));
    assert.throws(() => f.store.credit(f.admin.id, f.user.id, -1, "negative"), errorWithStatus(400));
    assert.equal(f.store.wallet(f.user.id).balance, 0.3);
    assert.deepEqual(f.store.setMinimumWithdrawal(f.admin.id, 250), { minimumWithdrawal: 250 });
  } finally { f.dispose(); }
});

test("first demo withdrawal enforces the configured minimum, reserves its balance, and rejects overspending", () => {
  const f = fixture();
  const address = "0x1111111111111111111111111111111111111111";
  try {
    f.store.credit(f.admin.id, f.user.id, 150.75, "Demo funding");
    assert.equal(f.store.wallet(f.user.id).firstWithdrawal, true);
    assert.throws(() => f.store.withdraw(f.user.id, 99.99, address, "ERC20"), /at least 100/);
    assert.equal(f.store.wallet(f.user.id).balance, 150.75);
    assert.equal(f.store.wallet(f.user.id).transactions.length, 1);
    let wallet = f.store.withdraw(f.user.id, 100, address, "ERC20");
    assert.equal(wallet.balance, 50.75);
    assert.equal(wallet.firstWithdrawal, false);
    assert.equal(wallet.transactions[0].status, "pending");
    assert.equal(wallet.transactions[0].address, address);
    assert.match(wallet.transactions[0].reference, /^SIM-WD-/);
    wallet = f.store.withdraw(f.user.id, 0.75, address, "ERC20");
    assert.equal(wallet.balance, 50);
    assert.throws(() => f.store.withdraw(f.user.id, 50.01, address, "ERC20"), /Insufficient/);
    assert.equal(f.store.wallet(f.user.id).balance, 50);
    assert.equal(f.store.wallet(f.user.id).transactions.length, 3);
    assert.throws(() => f.store.withdraw(f.user.id, 1, address, "unsupported"), /supported network/);
  } finally { f.dispose(); }
});

test("ledger insert failure rolls back balances, and secrets are stored only as hashes", () => {
  const f = fixture();
  const inspection = new DatabaseSync(f.databasePath);
  try {
    const session = f.store.login(f.user.email, USER_PASSWORD);
    const sessionRows = inspection.prepare("SELECT token_hash FROM sessions WHERE user_id = ?").all(f.user.id);
    assert.ok(sessionRows.some((row) => row.token_hash === hashToken(session.token)));
    assert.ok(sessionRows.every((row) => row.token_hash !== session.token));
    const storedUser = inspection.prepare("SELECT password_hash FROM users WHERE id = ?").get(f.user.id)!;
    assert.notEqual(storedUser.password_hash, USER_PASSWORD);
    const fresh = f.store.register("fresh@example.test", USER_PASSWORD);
    const storedVerification = inspection.prepare("SELECT token_hash FROM verification_tokens WHERE user_id = ?").get(fresh.user.id)!;
    assert.equal(storedVerification.token_hash, hashToken(fresh.token));

    inspection.exec("CREATE TRIGGER fail_ledger BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'test ledger failure'); END;");
    assert.throws(() => f.store.credit(f.admin.id, f.user.id, 500, "Must roll back"), /test ledger failure/);
    assert.equal(f.store.wallet(f.user.id).balance, 0);
    assert.equal(f.store.wallet(f.user.id).transactions.length, 0);
    inspection.exec("DROP TRIGGER fail_ledger;");
    f.store.credit(f.admin.id, f.user.id, 500, "Valid demo credit");
    inspection.exec("CREATE TRIGGER fail_ledger BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'test ledger failure'); END;");
    assert.throws(() => f.store.withdraw(f.user.id, 100, "0x1111111111111111111111111111111111111111", "ERC20"), /test ledger failure/);
    assert.equal(f.store.wallet(f.user.id).balance, 500);
    assert.equal(f.store.wallet(f.user.id).transactions.length, 1);
    assert.equal(f.store.wallet(f.user.id).firstWithdrawal, true);
  } finally { inspection.close(); f.dispose(); }
});

test("demo account funds always have a matching explicit simulation credit", () => {
  const store = new ExchangeStore({ databasePath: ":memory:" });
  try {
    const demo = store.createDemoSession();
    assert.equal(demo.user.role, "user");
    assert.equal(demo.user.verified, true);
    const wallet = store.wallet(demo.user.id);
    assert.equal(wallet.balance, 12450.75);
    assert.equal(wallet.transactions.length, 1);
    assert.equal(wallet.transactions[0].amount, wallet.balance);
    assert.match(wallet.transactions[0].note!, /demonstration/);
  } finally { store.close(); }
});

test("withdrawal settings persist, apply to each new account, and are checked before any balance change", () => {
  const f = fixture();
  let secondStore: ExchangeStore | undefined;
  const address = "0x1111111111111111111111111111111111111111";
  try {
    f.store.setMinimumWithdrawal(f.admin.id, 225.25);
    f.store.credit(f.admin.id, f.user.id, 250, "Demo funding");
    assert.throws(() => f.store.withdraw(f.user.id, 225.24, address, "ERC20"), /at least 225.25/);
    assert.equal(f.store.wallet(f.user.id).balance, 250);
    f.store.withdraw(f.user.id, 225.25, address, "ERC20");
    const next = f.store.register("second@example.test", USER_PASSWORD);
    f.store.verifyEmail(next.token);
    f.store.credit(f.admin.id, next.user.id, 250, "Demo funding");
    assert.throws(() => f.store.withdraw(next.user.id, 1, address, "ERC20"), /at least 225.25/);
    secondStore = new ExchangeStore({ databasePath: f.databasePath, minimumWithdrawal: 0 });
    assert.equal(secondStore.minimumWithdrawal(), 225.25);
    assert.equal(secondStore.wallet(next.user.id).firstWithdrawal, true);
    assert.equal(secondStore.wallet(next.user.id).balance, 250);
  } finally { secondStore?.close(); f.dispose(); }
});

test("even a stored admin role cannot access admin data until its email is verified", () => {
  const f = fixture();
  const inspection = new DatabaseSync(f.databasePath);
  try {
    inspection.prepare("UPDATE users SET verified = 0 WHERE id = ?").run(f.admin.id);
    assert.throws(() => f.store.admin(f.admin.id), errorWithStatus(403));
    assert.throws(() => f.store.credit(f.admin.id, f.user.id, 1, "Blocked"), errorWithStatus(403));
    assert.throws(() => f.store.setMinimumWithdrawal(f.admin.id, 0), errorWithStatus(403));
    assert.equal(f.store.wallet(f.user.id).balance, 0);
  } finally { inspection.close(); f.dispose(); }
});

test("API sends verification through SMTP, gates sessions and admin routes, and reserves demo withdrawals", { timeout: 20_000 }, async () => {
  const messages: string[] = [];
  const recipients: string[] = [];
  const connections = new Set<Socket>();
  const smtp = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    socket.write("220 localhost ESMTP test capture\r\n");
    let buffer = "";
    let collecting = false;
    let message = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (collecting) {
          if (line === ".") { collecting = false; messages.push(message); message = ""; socket.write("250 2.0.0 Accepted\r\n"); }
          else message += `${line}\r\n`;
        } else if (/^EHLO /i.test(line)) socket.write("250-localhost\r\n250 PIPELINING\r\n");
        else if (/^HELO /i.test(line) || /^MAIL FROM:/i.test(line)) socket.write("250 OK\r\n");
        else if (/^RCPT TO:/i.test(line)) { recipients.push(line); socket.write("250 OK\r\n"); }
        else if (line === "DATA") { collecting = true; socket.write("354 End with dot\r\n"); }
        else if (line === "QUIT") socket.end("221 Bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => { smtp.once("error", reject); smtp.listen(0, "127.0.0.1", resolve); });
  const port = (smtp.address() as AddressInfo).port;
  const envChanges = {
    NODE_ENV: "development", APP_URL: "http://localhost:3000", DATABASE_PATH: ":memory:", DATABASE_URL: "",
    ADMIN_EMAIL, ADMIN_PASSWORD, FIRST_WITHDRAWAL_MINIMUM: "1000", ALLOW_DEMO_ACCESS: "false",
    SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_SECURE: "false", SMTP_USER: "", SMTP_PASSWORD: "", SMTP_FROM: "Test Exchange <no-reply@example.test>",
  };
  const previousEnv = Object.fromEntries(Object.keys(envChanges).map((key) => [key, process.env[key]]));
  const globalStore = globalThis as unknown as { exchangeStore?: ExchangeStore; exchangeStorePromise?: Promise<unknown> };
  const previousStore = globalStore.exchangeStore;
  const previousStorePromise = globalStore.exchangeStorePromise;
  globalStore.exchangeStore = undefined;
  globalStore.exchangeStorePromise = undefined;
  Object.assign(process.env, envChanges);
  async function request(method: "GET" | "POST" | "PATCH", path: string, data?: unknown, cookie?: string, origin = "http://localhost:3000") {
    const req = new Request(`http://localhost:3000${path}`, {
      method,
      headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return ({ GET, POST, PATCH })[method](req);
  }
  try {
    const email = "api-member@example.test";
    assert.equal((await request("POST", "/api/auth/register", { email, password: USER_PASSWORD }, undefined, "https://cross-site.test")).status, 403);
    const registration = await request("POST", "/api/auth/register", { email, password: USER_PASSWORD, role: "admin" });
    assert.equal(registration.status, 201);
    assert.deepEqual(await registration.json(), { ok: true, emailDelivery: "smtp" });
    assert.equal(messages.length, 1);
    assert.deepEqual(recipients, [`RCPT TO:<${email}>`]);
    const decodedMessage = messages[0].replace(/=\r\n/g, "").replace(/=3D/g, "=");
    const verificationToken = decodedMessage.match(/\/api\/auth\/verify\?token=([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(verificationToken, "SMTP message contains the one-use verification link");
    assert.equal((await request("POST", "/api/auth/login", { email, password: USER_PASSWORD })).status, 403);
    const verify = await request("GET", `/api/auth/verify?token=${verificationToken}`);
    assert.equal(verify.status, 303);
    assert.equal(verify.headers.get("location"), "http://localhost:3000/?verified=1");
    const repeated = await request("GET", `/api/auth/verify?token=${verificationToken}`);
    assert.equal(repeated.headers.get("location"), "http://localhost:3000/?verification=invalid");
    const login = await request("POST", "/api/auth/login", { email, password: USER_PASSWORD });
    assert.equal(login.status, 200);
    const member = (await login.json()).user;
    assert.equal(member.role, "user", "registration cannot set an administrator role");
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly; SameSite=Lax/);
    assert.equal((await request("GET", "/api/admin", undefined, cookie)).status, 403);
    assert.equal((await request("POST", "/api/admin/credit", { userId: member.id, amount: 999 }, cookie)).status, 403);
    assert.equal((await request("PATCH", "/api/admin/settings", { minimumWithdrawal: 0 }, cookie)).status, 403);
    const adminLogin = await request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const adminCookie = adminLogin.headers.get("set-cookie")!;
    assert.equal((await request("POST", "/api/admin/credit", { userId: member.id, amount: 1000 }, adminCookie)).status, 200);
    assert.equal((await request("PATCH", "/api/admin/settings", { minimumWithdrawal: 500 }, adminCookie)).status, 200);
    const address = "0x1111111111111111111111111111111111111111";
    assert.equal((await request("POST", "/api/wallet/withdraw", { amount: 499, address, network: "ERC20" }, cookie)).status, 400);
    assert.equal((await (await request("GET", "/api/wallet", undefined, cookie)).json()).balance, 1000);
    const withdrawn = await request("POST", "/api/wallet/withdraw", { amount: 500, address, network: "ERC20" }, cookie);
    assert.equal(withdrawn.status, 200);
    const wallet = await withdrawn.json();
    assert.equal(wallet.balance, 500);
    assert.equal(wallet.transactions[0].status, "pending");
    assert.equal(wallet.firstWithdrawal, false);
    assert.equal((await request("POST", "/api/auth/demo", {})).status, 404);
    assert.equal((await request("POST", "/api/auth/logout", {}, cookie)).status, 200);
    assert.deepEqual((await (await request("GET", "/api/session", undefined, cookie)).json()).user, null);

    delete process.env.SMTP_HOST;
    const preview = await sendVerification("preview@example.test", "a".repeat(43));
    assert.equal(preview.emailDelivery, "local-preview");
    assert.ok(preview.verificationUrl);
    Object.assign(process.env, { NODE_ENV: "production", APP_URL: "https://exchange.example.test" });
    await assert.rejects(() => sendVerification("preview@example.test", "a".repeat(43)), errorWithStatus(503));
    const unconfiguredProduction = await request("GET", "/api/session");
    assert.equal(unconfiguredProduction.status, 503, "production never falls back to a filesystem database");
    assert.match((await unconfiguredProduction.json()).error, /DATABASE_URL/);
  } finally {
    const activeStore = globalStore.exchangeStore as ExchangeStore | undefined;
    activeStore?.close();
    globalStore.exchangeStore = previousStore;
    globalStore.exchangeStorePromise = previousStorePromise;
    for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
  }
});

test("Vercel preview derives only platform-provided vercel.app origins; production needs explicit APP_URL", () => {
  const changes = { NODE_ENV: "production", APP_URL: "", VERCEL: "1", VERCEL_ENV: "preview", VERCEL_URL: "dark-exchange-abc123-team.vercel.app" };
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, changes);
    assert.equal(appUrl().origin, "https://dark-exchange-abc123-team.vercel.app");
    process.env.VERCEL_URL = "dark-exchange.vercel.app.attacker.test";
    assert.throws(() => appUrl(), errorWithStatus(503));
    process.env.VERCEL_URL = "user@dark-exchange.vercel.app";
    assert.throws(() => appUrl(), errorWithStatus(503));
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_URL = "dark-exchange.vercel.app";
    assert.throws(() => appUrl(), errorWithStatus(503));
    process.env.APP_URL = "https://dark-exchange.com";
    assert.equal(appUrl().origin, "https://dark-exchange.com");
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

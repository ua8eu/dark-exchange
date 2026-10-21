import { AppError, hashToken, normalizeEmail, type User } from "../../../lib/server/primitives";
import { appUrl, demoEnabled, getStore, consumeRateLimit, clearRateLimit } from "../../../lib/server/runtime";
import { sendVerification } from "../../../lib/server/mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const COOKIE = "exchange_demo_session";
const MAX_BODY_BYTES = 8192;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...headers } });
}

function sessionToken(request: Request): string | undefined {
  const value = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!value || !/^[a-zA-Z0-9_-]{43}$/.test(value)) return undefined;
  return value;
}

function sessionCookie(token: string, expire = false): string {
  return `${COOKIE}=${expire ? "" : token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${expire ? 0 : 604800}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

async function authenticated(request: Request): Promise<User> {
  const user = await (await getStore()).session(sessionToken(request));
  if (!user) throw new AppError("Sign in to continue.", 401);
  return user;
}

function ensureOrigin(request: Request): void {
  if (request.headers.get("origin") !== appUrl().origin) throw new AppError("Invalid request origin.", 403);
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") throw new AppError("Invalid request origin.", 403);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new AppError("Send a JSON request.", 415);
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) throw new AppError("Request is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new AppError("Request is too large.", 413); }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new AppError("Send a valid JSON object."); }
}

function requestKey(request: Request): string {
  // Deployments should overwrite this header at the trusted reverse proxy.
  return hashToken(request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local");
}

async function handler(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");
    const method = request.method;
    if (!["GET", "HEAD"].includes(method)) ensureOrigin(request);
    const store = await getStore();

    if (method === "GET" && path === "/api/session") return json({ user: await store.session(sessionToken(request)), demoEnabled: demoEnabled() });
    if (method === "GET" && path === "/api/wallet") return json(await store.wallet((await authenticated(request)).id));
    if (method === "GET" && path === "/api/admin") return json(await store.admin((await authenticated(request)).id));
    if (method === "GET" && path === "/api/auth/verify") {
      await consumeRateLimit(store, `verify:${requestKey(request)}`, 60, 60_000);
      const destination = new URL("/", appUrl());
      try {
        await store.verifyEmail(url.searchParams.get("token") || "");
        destination.searchParams.set("verified", "1");
      } catch (error) {
        if (!(error instanceof AppError) || error.status !== 400) throw error;
        destination.searchParams.set("verification", "invalid");
      }
      return new Response(null, { status: 303, headers: { Location: destination.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    }
    if (method === "POST" && path === "/api/auth/register") {
      const data = await body(request);
      const email = normalizeEmail(data.email);
      await consumeRateLimit(store, `register-ip:${requestKey(request)}`, 20, 60 * 60_000);
      await consumeRateLimit(store, `register:${hashToken(email)}`, 5, 60 * 60_000);
      if (typeof data.password !== "string") throw new AppError("Enter a password.");
      const result = await store.register(email, data.password);
      return json({ ok: true, ...(await sendVerification(result.user.email, result.token)) }, 201);
    }
    if (method === "POST" && path === "/api/auth/login") {
      const data = await body(request);
      const email = normalizeEmail(data.email);
      const emailKey = `login:${hashToken(email)}`;
      await consumeRateLimit(store, emailKey, 8, 15 * 60_000);
      await consumeRateLimit(store, `login-ip:${requestKey(request)}`, 80, 15 * 60_000);
      if (typeof data.password !== "string") throw new AppError("Email or password is incorrect.", 401);
      const result = await store.login(email, data.password);
      await clearRateLimit(store, emailKey);
      return json({ user: result.user }, 200, { "Set-Cookie": sessionCookie(result.token) });
    }
    if (method === "POST" && path === "/api/auth/logout") {
      await store.logout(sessionToken(request));
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", true) });
    }
    if (method === "POST" && path === "/api/auth/resend") {
      const data = await body(request);
      const email = normalizeEmail(data.email);
      await consumeRateLimit(store, `resend:${hashToken(email)}`, 3, 15 * 60_000);
      await consumeRateLimit(store, `resend-ip:${requestKey(request)}`, 20, 15 * 60_000);
      const result = await store.resendVerification(email);
      return json({ ok: true, ...(result ? await sendVerification(result.email, result.token) : {}) });
    }
    if (method === "POST" && path === "/api/auth/demo") {
      if (!demoEnabled()) throw new AppError("Demo access is unavailable.", 404);
      await consumeRateLimit(store, `demo:${requestKey(request)}`, 20, 60 * 60_000);
      const result = await store.createDemoSession();
      return json({ user: result.user }, 200, { "Set-Cookie": sessionCookie(result.token) });
    }
    if (method === "POST" && path === "/api/wallet/withdraw") {
      const user = await authenticated(request);
      await consumeRateLimit(store, `withdraw:${user.id}`, 10, 60_000);
      const data = await body(request);
      return json(await store.withdraw(user.id, data.amount, data.address, data.network));
    }
    if (method === "POST" && path === "/api/admin/credit") {
      const user = await authenticated(request);
      const data = await body(request);
      return json(await store.credit(user.id, data.userId, data.amount, data.note));
    }
    if (method === "PATCH" && path === "/api/admin/settings") {
      const user = await authenticated(request);
      const data = await body(request);
      return json(await store.setMinimumWithdrawal(user.id, data.minimumWithdrawal));
    }
    return json({ error: "Endpoint not found." }, 404);
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    const databaseCode = (error as { code?: string })?.code;
    if (databaseCode === "42P01" || databaseCode === "42703") return json({ error: "Database schema is not initialized. Run npm run db:migrate before deployment." }, 503);
    if (databaseCode?.startsWith("08") || ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ENETUNREACH", "ETIMEDOUT", "57P01", "53300", "28P01", "3D000"].includes(databaseCode || "")) return json({ error: "Database is temporarily unavailable. Please try again." }, 503);
    console.error("Exchange API error:", error instanceof Error ? error.message : "Unknown error");
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;

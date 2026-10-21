import { resolve } from "node:path";
import { AppError } from "./primitives";
import type { ExchangeStore } from "./store";
import type { PostgresExchangeStore } from "./postgres-store";

export type RuntimeStore = ExchangeStore | PostgresExchangeStore;
const processGlobal = globalThis as unknown as { exchangeStore?: RuntimeStore; exchangeStorePromise?: Promise<RuntimeStore> };

export async function getStore(): Promise<RuntimeStore> {
  if (!process.env.DATABASE_URL && !["development", "test"].includes(process.env.NODE_ENV || "")) {
    throw new AppError("Persistent database is not configured. Set DATABASE_URL and run npm run db:migrate before deployment.", 503);
  }
  if (processGlobal.exchangeStore) return processGlobal.exchangeStore;
  if (!processGlobal.exchangeStorePromise) {
    processGlobal.exchangeStorePromise = (async () => {
      if (process.env.DATABASE_URL) {
        const [{ createPostgresDatabase }, { PostgresExchangeStore }] = await Promise.all([import("./postgres-connection"), import("./postgres-store")]);
        const connection = createPostgresDatabase(process.env.DATABASE_URL);
        return new PostgresExchangeStore(connection.db);
      }
      const { ExchangeStore } = await import("./store");
      return new ExchangeStore({
      databasePath: process.env.DATABASE_PATH || resolve(process.cwd(), ".data", "exchange.sqlite"),
      adminEmail: process.env.ADMIN_EMAIL,
      adminPassword: process.env.ADMIN_PASSWORD,
      minimumWithdrawal: process.env.FIRST_WITHDRAWAL_MINIMUM ? Number(process.env.FIRST_WITHDRAWAL_MINIMUM) : 1000,
      });
    })();
  }
  try { processGlobal.exchangeStore = await processGlobal.exchangeStorePromise; return processGlobal.exchangeStore; }
  catch (error) { processGlobal.exchangeStorePromise = undefined; throw error; }
}

export function appUrl(): URL {
  let value = process.env.APP_URL || "";
  if (!value && process.env.VERCEL === "1" && process.env.VERCEL_ENV === "preview") {
    const host = process.env.VERCEL_URL || "";
    const validHost = host.toLowerCase().endsWith(".vercel.app") && host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
    if (validHost) value = `https://${host}`;
  }
  if (!value && process.env.NODE_ENV === "development") value = "http://localhost:3000";
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError("APP_URL is not configured correctly.", 503); }
  if (!["http:", "https:"].includes(url.protocol) || (process.env.NODE_ENV === "production" && url.protocol !== "https:")) throw new AppError("Production APP_URL must use HTTPS.", 503);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new AppError("APP_URL must be an origin without credentials, query, or path.", 503);
  return url;
}

export function demoEnabled(): boolean { return process.env.NODE_ENV === "development" && process.env.ALLOW_DEMO_ACCESS === "true"; }

const rateLimits = new Map<string, { count: number; expires: number }>();
export function limit(key: string, maximum: number, windowMs: number): void {
  const now = Date.now();
  const previous = rateLimits.get(key);
  if (previous && previous.expires > now) {
    if (previous.count >= maximum) throw new AppError("Too many attempts. Please try again later.", 429);
    previous.count += 1;
    return;
  }
  if (rateLimits.size > 5000) {
    for (const [entry, value] of rateLimits) if (value.expires <= now) rateLimits.delete(entry);
    if (rateLimits.size > 5000) rateLimits.delete(rateLimits.keys().next().value!);
  }
  rateLimits.set(key, { count: 1, expires: now + windowMs });
}

export function resetLimit(key: string): void { rateLimits.delete(key); }

export async function consumeRateLimit(store: RuntimeStore, key: string, maximum: number, windowMs: number): Promise<void> {
  if ("consumeRateLimit" in store) await store.consumeRateLimit(key, maximum, windowMs);
  else limit(key, maximum, windowMs);
}

export async function clearRateLimit(store: RuntimeStore, key: string): Promise<void> {
  if ("resetRateLimit" in store) await store.resetRateLimit(key);
  else resetLimit(key);
}

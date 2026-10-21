import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export type User = { id: string; email: string; role: "user" | "admin"; verified: boolean };
export type LedgerTransaction = { id: string; type: "credit" | "withdrawal"; amount: number; createdAt: string; status: "completed" | "pending"; reference: string; note?: string; address?: string; network?: string };
export type Row = Record<string, unknown>;
export const SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000;
export const VERIFICATION_LIFETIME = 24 * 60 * 60 * 1000;
export const MAX_CENTS = 10_000_000_000;

export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = "AppError"; }
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new AppError("Enter a valid email address.");
  const email = value.trim().toLowerCase();
  const parts = email.split("@");
  const [local = "", domain = ""] = parts;
  const labels = domain.split(".");
  const localValid = local.length > 0 && local.length <= 64 && /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..");
  const domainValid = labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  if (email.length > 254 || parts.length !== 2 || !localValid || !domainValid) throw new AppError("Enter a valid email address.");
  return email;
}

export function amountToCents(value: unknown, allowZero = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new AppError("Enter a valid amount.");
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 0.00001 || cents < (allowZero ? 0 : 1) || cents > MAX_CENTS) {
    throw new AppError("Use an amount with up to two decimal places, between 0.01 and 100,000,000 TEST USDT.");
  }
  return cents;
}

export function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }

export function hashPassword(password: string): string {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) throw new AppError("Use a password between 12 and 128 characters.");
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function checkPassword(password: string, encoded: string): boolean {
  if (typeof password !== "string" || password.length > 128) return false;
  const [salt, expected] = encoded.split(":");
  if (!salt || !expected || !/^[a-f0-9]{128}$/.test(expected)) return false;
  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

export function publicUser(row: Row): User {
  return { id: String(row.id), email: String(row.email), role: row.role as User["role"], verified: Number(row.verified) === 1 };
}

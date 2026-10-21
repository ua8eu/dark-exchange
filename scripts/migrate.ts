import { existsSync } from "node:fs";
import { createPostgresDatabase } from "../src/lib/server/postgres-connection";
import { migratePostgres } from "../src/lib/server/postgres-schema";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to your Neon/PostgreSQL URL before running migration.");
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD (12–128 characters) before migration.");
  const connection = createPostgresDatabase(process.env.DATABASE_URL);
  try {
    await migratePostgres(connection.db, { adminEmail: process.env.ADMIN_EMAIL, adminPassword: process.env.ADMIN_PASSWORD, minimumWithdrawal: process.env.FIRST_WITHDRAWAL_MINIMUM ? Number(process.env.FIRST_WITHDRAWAL_MINIMUM) : 1000 });
    console.log("dark-exchange.com PostgreSQL schema and administrator are ready. All balances remain TEST USDT.");
  } finally { await connection.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Database migration failed.");
  process.exitCode = 1;
});

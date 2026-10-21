import { Pool } from "pg";
import { AppError } from "./primitives";
import type { SqlDatabase, SqlExecutor } from "./postgres-store";

export function createPostgresDatabase(connectionString: string): { db: SqlDatabase; close: () => Promise<void> } {
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new AppError("DATABASE_URL is not configured correctly.", 503); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new AppError("DATABASE_URL must be a PostgreSQL connection URL.", 503);
  // Neon supports verified TLS. Never let URL sslmode=require weaken certificate verification.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!local || process.env.NODE_ENV === "production") url.searchParams.set("sslmode", "verify-full");
  const pool = new Pool({ connectionString: url.toString(), max: 2, idleTimeoutMillis: 20_000, connectionTimeoutMillis: 10_000 });
  pool.on("error", () => { console.error("PostgreSQL idle connection error."); });
  const db: SqlDatabase = {
    async query(text, values) { const result = await pool.query(text, values); return { rows: result.rows, rowCount: result.rowCount }; },
    async transaction<T>(operation: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await operation({ async query(text, values) { const response = await client.query(text, values); return { rows: response.rows, rowCount: response.rowCount }; } });
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
  };
  return { db, close: () => pool.end() };
}

import pg from "pg";
import { DATABASE_URL } from "./config.js";

// Return DATE columns as plain 'YYYY-MM-DD' text. The default parser builds a JavaScript Date at local
// midnight, which shows the previous day once it is printed in UTC from a machine east of Greenwich.
pg.types.setTypeParser(pg.types.builtins.DATE, value => value);

/** One shared pool per process. Scripts call closePool() before exiting. */
export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 4,
  statement_timeout: 10_000,
  connectionTimeoutMillis: 5_000,
  // Lets the stdio server exit as soon as its client hangs up, instead of waiting for idle connections to expire.
  allowExitOnIdle: true
});

// An idle client can error when the database restarts; log it instead of crashing the process.
pool.on("error", error => console.error(`database pool error: ${error.message}`));

export async function closePool(): Promise<void> {
  await pool.end();
}

/** Turns low-level connection failures into a message that says what to do. */
export function describeDbError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  if (code === "ECONNREFUSED" || /ECONNREFUSED|connect/i.test(message)) {
    return "The database is not reachable. Start it with `npm run db:start`, then try again.";
  }
  if (code === "57014") return "The query took longer than 10 seconds and was cancelled. Narrow the request.";
  return `Database error: ${message}`;
}

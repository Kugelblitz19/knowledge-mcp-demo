#!/usr/bin/env node
/**
 * Prints the most recent sync runs, newest first. Read-only.
 *
 *   npm run runs          the last 10 runs
 *   npm run runs -- 30    the last 30 runs
 */
import { closePool, describeDbError, pool } from "./db.js";
import { formatUtc } from "./status.js";

interface Row {
  id: number;
  status: string;
  started_at: Date;
  rows_read: number;
  rows_upserted: number;
  skipped_ids: string[];
  error: string | null;
}

const limit = Math.min(Math.max(Number(process.argv[2] ?? 10) || 10, 1), 200);
let exitCode = 0;
try {
  const { rows } = await pool.query<Row>(
    "SELECT id, status, started_at, rows_read, rows_upserted, skipped_ids, error FROM sync_runs ORDER BY id DESC LIMIT $1",
    [limit]
  );
  if (rows.length === 0) {
    console.log("No sync has run yet.");
  } else {
    console.log("  id  status  started               read  written  left out / error");
    for (const row of rows) {
      const note = row.status === "failed" ? (row.error ?? "no error text") : row.skipped_ids.length > 0 ? `left out: ${row.skipped_ids.join(", ")}` : "";
      console.log(
        [
          String(row.id).padStart(4),
          row.status.padEnd(6),
          formatUtc(row.started_at.toISOString()).padEnd(20),
          String(row.rows_read).padStart(4),
          String(row.rows_upserted).padStart(7),
          note
        ].join("  ")
      );
    }
  }
} catch (error) {
  console.error(describeDbError(error));
  exitCode = 1;
} finally {
  await closePool().catch(() => undefined);
}
process.exit(exitCode);

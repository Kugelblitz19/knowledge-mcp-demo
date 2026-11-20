/**
 * How fresh is the knowledge base? Read from the sync_runs table.
 * Used by the kb_sync_status tool, by the freshness line under search results, and by the monitoring checks.
 */
import * as z from "zod/v4";
import { MAX_SYNC_AGE_HOURS } from "./config.js";
import { pool } from "./db.js";

export const SyncRunSchema = z.object({
  id: z.number(),
  status: z.enum(["ok", "failed"]),
  started_at: z.string(),
  finished_at: z.string(),
  source_exported_at: z.string().nullable(),
  rows_read: z.number(),
  rows_upserted: z.number(),
  skipped_ids: z.array(z.string()),
  error: z.string().nullable()
});

export const SyncStatusSchema = z.object({
  last_run: SyncRunSchema.nullable(),
  last_ok_run: SyncRunSchema.nullable(),
  hours_since_last_ok: z.number().nullable(),
  max_age_hours: z.number(),
  fresh: z.boolean(),
  row_counts: z.object({ staff: z.number(), publications: z.number(), events: z.number() })
});

export type SyncRun = z.infer<typeof SyncRunSchema>;
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

interface SyncRunRow {
  id: number;
  status: "ok" | "failed";
  started_at: Date;
  finished_at: Date;
  source_exported_at: Date | null;
  rows_read: number;
  rows_upserted: number;
  skipped_ids: string[];
  error: string | null;
}

function toRun(row: SyncRunRow | undefined): SyncRun | null {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    started_at: row.started_at.toISOString(),
    finished_at: row.finished_at.toISOString(),
    source_exported_at: row.source_exported_at ? row.source_exported_at.toISOString() : null,
    rows_read: row.rows_read,
    rows_upserted: row.rows_upserted,
    skipped_ids: row.skipped_ids,
    error: row.error
  };
}

const RUN_COLUMNS = "id, status, started_at, finished_at, source_exported_at, rows_read, rows_upserted, skipped_ids, error";

export async function getSyncStatus(): Promise<SyncStatus> {
  const [last, lastOk, counts] = await Promise.all([
    pool.query<SyncRunRow>(`SELECT ${RUN_COLUMNS} FROM sync_runs ORDER BY finished_at DESC, id DESC LIMIT 1`),
    pool.query<SyncRunRow>(`SELECT ${RUN_COLUMNS} FROM sync_runs WHERE status = 'ok' ORDER BY finished_at DESC, id DESC LIMIT 1`),
    pool.query<{ staff: number; publications: number; events: number }>(
      `SELECT (SELECT count(*)::int FROM staff) AS staff,
              (SELECT count(*)::int FROM publications) AS publications,
              (SELECT count(*)::int FROM events) AS events`
    )
  ]);

  const lastOkRun = toRun(lastOk.rows[0]);
  const hours = lastOkRun ? (Date.now() - new Date(lastOkRun.finished_at).getTime()) / 3_600_000 : null;
  return {
    last_run: toRun(last.rows[0]),
    last_ok_run: lastOkRun,
    hours_since_last_ok: hours === null ? null : Math.round(hours * 10) / 10,
    max_age_hours: MAX_SYNC_AGE_HOURS,
    fresh: hours !== null && hours <= MAX_SYNC_AGE_HOURS,
    row_counts: counts.rows[0]
  };
}

/** 'less than an hour ago', '1 hour ago', '30 hours ago' */
export function ago(hours: number | null): string {
  if (hours === null) return "never";
  if (hours < 1) return "less than an hour ago";
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

/** '2026-11-19 01:00 UTC' */
export function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** One line that tells the reader how old the data is, with a warning when it is too old to trust. */
export function freshnessLine(status: SyncStatus): string {
  if (!status.last_ok_run) return "Warning: the knowledge base has never been synced, so results may be empty.";
  const when = formatUtc(status.last_ok_run.finished_at);
  if (!status.fresh) {
    return `Warning: the last good sync was ${ago(status.hours_since_last_ok)} (${when}). Newer items may be missing. Call kb_sync_status for details.`;
  }
  return `Data as of the last good sync: ${when}.`;
}

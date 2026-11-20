#!/usr/bin/env node
/**
 * Nightly sync: reads the upstream export (source/export.json) and upserts it into PostgreSQL.
 *
 *   npm run sync                      normal run
 *   npm run sync -- --dry-run         validate the export and preview the changes; write nothing
 *   npm run sync -- --skip pub-0026   leave the named records out of this run (comma-separated ids)
 *
 * Rules this job keeps:
 *  - All or nothing. If any record is invalid, nothing is written, so the database is never half-updated.
 *  - It never deletes rows and never edits the export file.
 *  - --skip is narrow on purpose: every id must exist in the export, and one run takes at most
 *    MAX_SKIPPED_RECORDS of them. Skipped ids are stored on the run, and the checks keep warning about them.
 *  - Every real run leaves one row in sync_runs and one logs/sync-<start time>.log.
 *    A dry run leaves neither: only its own logs/dryrun-<start time>.log.
 *
 * Exit codes: 0 done (or dry run clean), 1 failed (bad record, unreadable export, database error), 2 refused (bad arguments).
 */
import fs from "node:fs";
import path from "node:path";
import type * as z from "zod/v4";
import { LOG_DIR, MAX_SKIPPED_RECORDS, SOURCE_FILE } from "./config.js";
import { closePool, describeDbError, pool } from "./db.js";
import { EventRecord, PublicationRecord, StaffRecord, readExport } from "./records.js";
import type { Event, Export, Publication, Staff } from "./records.js";

interface Problem {
  table: string;
  id: string;
  message: string;
}

interface Comparison {
  added: number;
  changed: number;
  unchanged: number;
}

// ---- arguments ----

const USAGE = "Usage: npm run sync -- [--dry-run] [--skip <id>[,<id>...]]";
let dryRun = false;
const skipIds = new Set<string>();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--dry-run") {
    dryRun = true;
  } else if (args[i] === "--skip" && args[i + 1] && !args[i + 1].startsWith("--")) {
    for (const id of args[i + 1].split(",")) if (id.trim()) skipIds.add(id.trim());
    i += 1;
  } else {
    console.error(args[i] === "--skip" ? `--skip needs a record id. ${USAGE}` : `Unknown argument '${args[i]}'. ${USAGE}`);
    process.exit(2);
  }
}

// ---- logging: console and a file per run ----

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
const logFile = path.join(LOG_DIR, `${dryRun ? "dryrun" : "sync"}-${stamp}.log`);
fs.mkdirSync(LOG_DIR, { recursive: true });

function log(line: string): void {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  fs.appendFileSync(logFile, `${text}\n`);
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

function recordId(raw: unknown): string {
  const id = (raw as { id?: unknown } | null)?.id;
  return typeof id === "string" && id ? id : "(no id)";
}

/** Validates one table's records. Good ones are returned; each failure becomes a Problem that names the record. */
function validate<T>(table: string, rows: unknown[], schema: z.ZodType<T>, problems: Problem[], skipped: string[]): T[] {
  const good: T[] = [];
  for (const raw of rows) {
    const id = recordId(raw);
    if (skipIds.has(id)) {
      skipped.push(id);
      continue;
    }
    const parsed = schema.safeParse(raw);
    if (parsed.success) {
      good.push(parsed.data);
      continue;
    }
    for (const issue of parsed.error.issues) {
      const field = issue.path.join(".") || "(record)";
      const value = (raw as Record<string, unknown> | null)?.[field];
      const shown = value === undefined ? "" : ` '${String(value)}'`;
      problems.push({ table, id, message: `${field}${shown} ${issue.message}` });
    }
  }
  return good;
}

/** Counts what a run would add, change or leave alone, by reading the database. Writes nothing. */
async function compareWithDatabase(staff: Staff[], publications: Publication[], events: Event[]): Promise<Comparison> {
  const result: Comparison = { added: 0, changed: 0, unchanged: 0 };
  const tally = async (table: string, columns: string[], records: Record<string, string>[]): Promise<void> => {
    const { rows } = await pool.query<Record<string, string>>(`SELECT id, ${columns.join(", ")} FROM ${table}`);
    const current = new Map(rows.map(row => [row.id, row]));
    for (const record of records) {
      const existing = current.get(record.id);
      if (!existing) result.added += 1;
      else if (columns.some(column => existing[column] !== record[column])) result.changed += 1;
      else result.unchanged += 1;
    }
  };
  await tally("staff", ["name", "role", "team", "email"], staff);
  await tally("publications", ["title", "summary", "topic", "published_on", "author_id", "url"], publications);
  await tally("events", ["title", "starts_on", "location", "owner_id"], events);
  return result;
}

/** Stores the outcome of a real run and returns its run number. */
async function recordRun(status: "ok" | "failed", fields: {
  exportedAt: string | null;
  rowsRead: number;
  rowsUpserted: number;
  skipped: string[];
  error: string | null;
}): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO sync_runs (started_at, finished_at, status, source_exported_at, rows_read, rows_upserted, skipped_ids, error)
     VALUES ($1, now(), $2, $3, $4, $5, $6, $7) RETURNING id`,
    [startedAt, status, fields.exportedAt, fields.rowsRead, fields.rowsUpserted, fields.skipped, fields.error]
  );
  return result.rows[0].id;
}

async function main(): Promise<number> {
  log(`${dryRun ? "dry run started (nothing will be written)" : "sync started"}; source ${path.relative(process.cwd(), SOURCE_FILE)}`);
  if (skipIds.size > 0) log(`leaving out on request: ${[...skipIds].join(", ")}`);

  let file: Export;
  try {
    file = readExport(SOURCE_FILE);
  } catch (error) {
    const message = `could not read the export file: ${error instanceof Error ? error.message : String(error)}`;
    if (dryRun) {
      log(`dry run stopped: ${message}`);
    } else {
      const run = await recordRun("failed", { exportedAt: null, rowsRead: 0, rowsUpserted: 0, skipped: [], error: message });
      log(`FAILED ${message}. Run #${run}.`);
    }
    return 1;
  }

  const problems: Problem[] = [];
  const skipped: string[] = [];
  const staff = validate<Staff>("staff", file.staff, StaffRecord, problems, skipped);
  const publications = validate<Publication>("publications", file.publications, PublicationRecord, problems, skipped);
  const events = validate<Event>("events", file.events, EventRecord, problems, skipped);

  // Cross-checks: every author and event owner must be a staff member in the same export.
  const staffIds = new Set(staff.map(person => person.id));
  for (const publication of publications) {
    if (!staffIds.has(publication.author_id)) {
      problems.push({ table: "publications", id: publication.id, message: `author_id '${publication.author_id}' is not in the staff list` });
    }
  }
  for (const event of events) {
    if (!staffIds.has(event.owner_id)) {
      problems.push({ table: "events", id: event.id, message: `owner_id '${event.owner_id}' is not in the staff list` });
    }
  }

  const rowsRead = file.staff.length + file.publications.length + file.events.length;
  log(`read ${rowsRead} records (staff ${file.staff.length}, publications ${file.publications.length}, events ${file.events.length})`);

  // Guard rails on --skip. A skip is a decision to publish without a record, so it must be small and exact.
  const unknownSkips = [...skipIds].filter(id => !skipped.includes(id));
  if (unknownSkips.length > 0 || skipIds.size > MAX_SKIPPED_RECORDS) {
    const reason =
      unknownSkips.length > 0
        ? `--skip named record(s) that are not in the export: ${unknownSkips.join(", ")}. Check the id.`
        : `--skip named ${skipIds.size} records; the limit is ${MAX_SKIPPED_RECORDS}. That many bad records means something is wrong at the source: ask the system owner.`;
    log(`REFUSED ${reason} Nothing was written.`);
    return 2;
  }

  // Every bad record is listed, not only the first one.
  if (problems.length > 0) {
    for (const problem of problems) log(`INVALID ${problem.table} ${problem.id}: ${problem.message}`);
    const badRecords = new Set(problems.map(problem => `${problem.table} ${problem.id}`)).size;
    if (dryRun) {
      log(`dry run found ${plural(badRecords, "invalid record")}. A real run would stop here and load nothing. Nothing was written.`);
    } else {
      const summary = problems.map(problem => `${problem.table} ${problem.id}: ${problem.message}`).join("; ");
      const run = await recordRun("failed", { exportedAt: file.exported_at, rowsRead, rowsUpserted: 0, skipped, error: summary });
      log(`FAILED ${plural(badRecords, "invalid record")}. Nothing was written. Run #${run}.`);
    }
    return 1;
  }

  const valid = staff.length + publications.length + events.length;
  const leftOut = skipped.length > 0 ? `, ${skipped.length} left out (${skipped.join(", ")})` : "";

  if (dryRun) {
    // The preview needs the database. Without it the validation result still stands.
    let preview: string;
    try {
      const would = await compareWithDatabase(staff, publications, events);
      preview = `A real run would add ${would.added}, change ${would.changed} and leave ${would.unchanged} as they are.`;
    } catch (error) {
      preview = `Could not preview the changes: ${describeDbError(error)}`;
    }
    log(`dry run OK: ${plural(valid, "record")} valid${leftOut}. ${preview} Nothing was written.`);
    return 0;
  }

  const change = await compareWithDatabase(staff, publications, events);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const person of staff) {
      await client.query(
        `INSERT INTO staff (id, name, role, team, email) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, team = EXCLUDED.team, email = EXCLUDED.email`,
        [person.id, person.name, person.role, person.team, person.email]
      );
    }
    for (const item of publications) {
      await client.query(
        `INSERT INTO publications (id, title, summary, topic, published_on, author_id, url) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, topic = EXCLUDED.topic,
           published_on = EXCLUDED.published_on, author_id = EXCLUDED.author_id, url = EXCLUDED.url`,
        [item.id, item.title, item.summary, item.topic, item.published_on, item.author_id, item.url]
      );
    }
    for (const item of events) {
      await client.query(
        `INSERT INTO events (id, title, starts_on, location, owner_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, starts_on = EXCLUDED.starts_on, location = EXCLUDED.location, owner_id = EXCLUDED.owner_id`,
        [item.id, item.title, item.starts_on, item.location, item.owner_id]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const run = await recordRun("ok", { exportedAt: file.exported_at, rowsRead, rowsUpserted: valid, skipped, error: null });
  log(`OK ${plural(valid, "record")} written (${change.added} new, ${change.changed} changed, ${change.unchanged} unchanged)${leftOut}. Run #${run}.`);
  return 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  log(`FAILED ${describeDbError(error)}`);
} finally {
  await closePool().catch(() => undefined);
}
process.exit(exitCode);

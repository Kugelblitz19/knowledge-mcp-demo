/**
 * Stages the demo. This is NOT part of the system: a real deployment has no script like this.
 *
 *   npm run demo:reset   a healthy system: the demo database is emptied and re-filled from the healthy export,
 *                        with one good sync dated "last night" (6 hours ago).
 *   npm run demo:break   last night's failure: the upstream export gains one good publication and one with an
 *                        impossible date. The sync refuses the whole batch, so the knowledge base goes stale.
 *
 * The sync itself is the real one (src/sync.ts). This script only moves the clock: after a run it shifts that
 * run's row in sync_runs and its log file into the past, so the timeline reads the way a real night would.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { ALERT_FILE, DATABASE_URL, LOG_DIR, ROOT, SOURCE_FILE } from "../src/config.js";

const HEALTHY_FILE = path.join(ROOT, "source", "export.healthy.json");
const INCIDENT_DIR = path.join(ROOT, "incidents");
const HOUR = 3_600_000;

/** Hours between "now" and the nightly run this script pretends happened last night. */
const LAST_NIGHT_HOURS = 6;

const GOOD_NEW_ID = "pub-0025";
const BAD_NEW_ID = "pub-0026";

interface ExportData {
  exported_at: string;
  publications: Record<string, unknown>[];
  [key: string]: unknown;
}

const isoSeconds = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;
const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * HOUR);

function writeExport(data: ExportData): void {
  fs.writeFileSync(SOURCE_FILE, `${JSON.stringify(data, null, 2)}\n`);
}

/** Runs the real sync or the real checks as a child process and returns the exit code. */
function runScript(name: "sync" | "checks"): number {
  const result = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "src", `${name}.ts`)], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"]
  });
  return result.status ?? 1;
}

const runSync = (): number => runScript("sync");

function syncLogs(): string[] {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs
    .readdirSync(LOG_DIR)
    .filter(name => /^sync-\d{8}T\d{6}\.log$/.test(name))
    .sort()
    .map(name => path.join(LOG_DIR, name));
}

/** Moves one sync log into the past: the time in its name and the time at the start of every line. */
function shiftLog(file: string, hours: number): void {
  const shifted = (iso: string): Date => new Date(new Date(iso).getTime() - hours * HOUR);
  const text = fs.readFileSync(file, "utf8").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z/gm, stamp => shifted(stamp).toISOString());
  const m = path.basename(file).match(/^sync-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.log$/);
  if (!m) return;
  const started = shifted(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  const stamp = started.toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  fs.rmSync(file);
  fs.writeFileSync(path.join(LOG_DIR, `sync-${stamp}.log`), text);
}

/**
 * Moves sync_runs rows into the past. With no ids it moves every row, and the export time with it
 * (those runs read an earlier export). With ids it moves only the run times, because the export
 * file already carries the right time for the run that just happened.
 */
async function shiftRuns(db: pg.Client, hours: number, ids?: number[]): Promise<void> {
  const shift = `- ($1 * interval '1 hour')`;
  if (ids) {
    await db.query(
      `UPDATE sync_runs SET started_at = started_at ${shift}, finished_at = finished_at ${shift} WHERE id = ANY($2)`,
      [hours, ids]
    );
    return;
  }
  await db.query(
    `UPDATE sync_runs
     SET started_at = started_at ${shift}, finished_at = finished_at ${shift}, source_exported_at = source_exported_at ${shift}`,
    [hours]
  );
}

async function latestRunId(db: pg.Client): Promise<number> {
  const result = await db.query<{ id: number }>("SELECT id FROM sync_runs ORDER BY id DESC LIMIT 1");
  return result.rows[0].id;
}

async function reset(db: pg.Client): Promise<void> {
  // 1. The export as the workspace produced it last night.
  const healthy = JSON.parse(fs.readFileSync(HEALTHY_FILE, "utf8")) as ExportData;
  writeExport({ ...healthy, exported_at: isoSeconds(hoursAgo(LAST_NIGHT_HOURS + 0.2)) });

  // 2. An empty demo database. (Demo only: nothing in the real system ever empties a table.)
  await db.query("TRUNCATE sync_runs, events, publications, staff RESTART IDENTITY CASCADE");

  // 3. Old logs and alerts go. Incident notes from earlier practice runs move out of incidents/ into
  //    .practice/, so that the next session starts from an empty folder and cannot copy an old note.
  for (const file of syncLogs()) fs.rmSync(file);
  if (fs.existsSync(LOG_DIR)) {
    for (const name of fs.readdirSync(LOG_DIR)) if (/^dryrun-\d{8}T\d{6}\.log$/.test(name)) fs.rmSync(path.join(LOG_DIR, name));
  }
  fs.rmSync(path.join(LOG_DIR, "checks.log"), { force: true });
  fs.rmSync(ALERT_FILE, { force: true });
  fs.mkdirSync(INCIDENT_DIR, { recursive: true });
  const notes = fs.readdirSync(INCIDENT_DIR).filter(name => name.endsWith(".md") && name !== "TEMPLATE.md");
  if (notes.length > 0) {
    const archive = path.join(ROOT, ".practice", "incident-notes", isoSeconds(new Date()).replace(/[-:]/g, ""));
    fs.mkdirSync(archive, { recursive: true });
    for (const name of notes) fs.renameSync(path.join(INCIDENT_DIR, name), path.join(archive, name));
    console.log(`Moved ${notes.length} earlier incident note(s) to ${path.relative(ROOT, archive)}.`);
  }

  // 4. Last night's sync, which went well.
  if (runSync() !== 0) throw new Error("The healthy sync failed. See the newest file in logs/.");
  await shiftRuns(db, LAST_NIGHT_HOURS, [await latestRunId(db)]);
  for (const file of syncLogs()) shiftLog(file, LAST_NIGHT_HOURS);

  console.log("Healthy: 24 publications, 6 events, 8 staff. Last night's sync succeeded.");
  console.log("Run `npm run checks` to see every check pass.");
}

async function breakIt(db: pg.Client): Promise<void> {
  const data = JSON.parse(fs.readFileSync(SOURCE_FILE, "utf8")) as ExportData;
  if (data.publications.some(item => item.id === GOOD_NEW_ID || item.id === BAD_NEW_ID)) {
    throw new Error("The failure is already staged. Run `npm run demo:reset` first to start again.");
  }
  const runs = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM sync_runs WHERE status = 'ok'");
  if (runs.rows[0].count === 0) throw new Error("There is no healthy system to break. Run `npm run demo:reset` first.");

  // 1. Everything so far happened a day earlier: the last good sync is now the night before last.
  await shiftRuns(db, 24);
  for (const file of syncLogs()) shiftLog(file, 24);

  // 2. Yesterday someone added two publications in the workspace. One has a date that does not exist.
  const yesterday = hoursAgo(LAST_NIGHT_HOURS + 20).toISOString().slice(0, 10);
  data.publications.push(
    {
      id: GOOD_NEW_ID,
      title: "Incident reporting for AI systems: a starter template",
      summary: "A two-page template for reporting AI incidents, with guidance on what to record in the first 24 hours.",
      topic: "AI governance",
      published_on: yesterday,
      author_id: "s-03",
      url: "https://meridianpolicylab.example/publications/incident-reporting-for-ai-systems-a-starter-template"
    },
    {
      id: BAD_NEW_ID,
      title: "Notes from the November evaluation roundtable",
      summary: "What twelve regulators and developers agreed, and did not agree, about pre-deployment evaluations.",
      topic: "AI governance",
      published_on: "2026-11-31",
      author_id: "s-02",
      url: "https://meridianpolicylab.example/publications/notes-from-the-november-evaluation-roundtable"
    }
  );
  writeExport({ ...data, exported_at: isoSeconds(hoursAgo(LAST_NIGHT_HOURS + 0.2)) });

  // 3. Last night's sync, which the bad record stops.
  const before = await latestRunId(db);
  const exitCode = runSync();
  const failedId = await latestRunId(db);
  if (exitCode === 0 || failedId === before) throw new Error("The staged sync was expected to fail but did not.");
  await shiftRuns(db, LAST_NIGHT_HOURS, [failedId]);
  const newestLog = syncLogs().at(-1);
  if (newestLog) shiftLog(newestLog, LAST_NIGHT_HOURS);

  // 4. This morning's checks, which raise the alert the person on call wakes up to.
  if (runScript("checks") === 0) throw new Error("The staged checks were expected to fail but passed.");

  console.log("Staged: last night's sync failed, and the last good sync is now 30 hours old.");
  console.log("The alert is in alerts/latest.md. Run `npm run checks` to see it again.");
}

const command = process.argv[2];
if (command !== "reset" && command !== "break") {
  console.error("Usage: tsx scripts/demo.ts reset | break");
  process.exit(2);
}

const db = new pg.Client({ connectionString: DATABASE_URL });
let exitCode = 0;
try {
  await db.connect();
  if (command === "reset") await reset(db);
  else await breakIt(db);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(/ECONNREFUSED/.test(message) ? "The database is not running. Start it with `npm run db:start`." : message);
  exitCode = 1;
} finally {
  await db.end().catch(() => undefined);
}
process.exit(exitCode);

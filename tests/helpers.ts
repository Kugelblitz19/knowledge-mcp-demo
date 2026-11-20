/**
 * Test helpers. Every test file gets its own database and its own temporary folder for the export,
 * the logs and the alert, so tests never touch the demo's data and can run side by side.
 *
 * Needs the local PostgreSQL running: `npm run db:start`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { ROOT } from "../src/config.js";

const SERVER = "postgres://demo@127.0.0.1:54329";

export interface ExportData {
  exported_at: string;
  staff: Record<string, unknown>[];
  publications: Record<string, unknown>[];
  events: Record<string, unknown>[];
}

export interface Workspace {
  db: pg.Client;
  dir: string;
  exportFile: string;
  alertFile: string;
  logDir: string;
  /** Empties the four tables. */
  wipe(): Promise<void>;
  /** A fresh copy of the healthy export (8 staff, 24 publications, 6 events). */
  healthy(): ExportData;
  /** Writes the export the sync will read. */
  writeExport(data: ExportData): void;
  /** Runs src/sync.ts or src/checks.ts against this workspace. */
  run(script: "sync" | "checks", ...args: string[]): { status: number; output: string };
  /** The same, with extra environment variables (for example a database that is not there). */
  runWith(env: Record<string, string>, script: "sync" | "checks", ...args: string[]): { status: number; output: string };
  count(table: "staff" | "publications" | "events" | "sync_runs"): Promise<number>;
  close(): Promise<void>;
}

export async function createWorkspace(name: string): Promise<Workspace> {
  const database = `knowledge_test_${name}`;
  const url = `${SERVER}/${database}`;

  const admin = new pg.Client({ connectionString: `${SERVER}/postgres` });
  try {
    await admin.connect();
  } catch {
    throw new Error("The tests need the local database. Start it with `npm run db:start`.");
  }
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();

  const db = new pg.Client({ connectionString: url });
  await db.connect();
  await db.query(fs.readFileSync(path.join(ROOT, "src", "schema.sql"), "utf8"));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kb-${name}-`));
  const exportFile = path.join(dir, "export.json");
  const alertFile = path.join(dir, "alert.md");
  const logDir = path.join(dir, "logs");
  const healthyText = fs.readFileSync(path.join(ROOT, "source", "export.healthy.json"), "utf8");

  const workspace: Workspace = {
    db,
    dir,
    exportFile,
    alertFile,
    logDir,
    async wipe() {
      await db.query("TRUNCATE sync_runs, events, publications, staff RESTART IDENTITY CASCADE");
    },
    healthy() {
      return JSON.parse(healthyText) as ExportData;
    },
    writeExport(data) {
      fs.writeFileSync(exportFile, JSON.stringify(data, null, 2));
    },
    run(script, ...args) {
      return workspace.runWith({}, script, ...args);
    },
    runWith(env, script, ...args) {
      const result = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "src", `${script}.ts`), ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: url, SOURCE_FILE: exportFile, LOG_DIR: logDir, ALERT_FILE: alertFile, MCP_URL: "", ...env }
      });
      return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
    },
    async count(table) {
      const result = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      return result.rows[0].n;
    },
    async close() {
      await db.end();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  await workspace.wipe();
  return workspace;
}

/** A publication that passes validation. Override fields to make it fail. */
export function publication(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Test publication ${id}`,
    summary: "A record made by the test suite.",
    topic: "AI governance",
    published_on: "2026-11-19",
    author_id: "s-03",
    url: `https://meridianpolicylab.example/publications/${id}`,
    ...overrides
  };
}

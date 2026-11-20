/**
 * Local PostgreSQL for the demo: `tsx scripts/db.ts start | stop | status`.
 * Uses the PostgreSQL 17 binaries that ship inside node_modules, so nothing is installed on the machine.
 * Listens on 127.0.0.1:54329 only, with trust auth. That is fine for a local demo and wrong for anything else.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { ROOT } from "../src/config.js";

const BIN = path.join(ROOT, "node_modules", "@embedded-postgres", `${process.platform}-${process.arch}`, "native", "bin");
const DATA = path.join(ROOT, ".pgdata");
const LOG = path.join(ROOT, "logs", "postgres.log");
const PORT = 54329;

function run(bin: string, args: string[], quiet = false): number {
  const result = spawnSync(path.join(BIN, bin), args, { stdio: quiet ? "ignore" : "inherit" });
  return result.status ?? 1;
}

function isRunning(): boolean {
  return fs.existsSync(DATA) && run("pg_ctl", ["-D", DATA, "status"], true) === 0;
}

async function start(): Promise<void> {
  if (!fs.existsSync(path.join(BIN, "pg_ctl"))) {
    throw new Error(`PostgreSQL binaries not found at ${BIN}. Run \`npm install\` first.`);
  }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  if (!fs.existsSync(path.join(DATA, "PG_VERSION"))) {
    console.log("Creating a new database cluster in .pgdata ...");
    if (run("initdb", ["-D", DATA, "-U", "demo", "--auth=trust", "-E", "UTF8", "--locale=C"], true) !== 0) {
      throw new Error("initdb failed. Delete .pgdata and try again.");
    }
  }
  if (!isRunning()) {
    const options = `-p ${PORT} -c listen_addresses=127.0.0.1 -c timezone=UTC`;
    if (run("pg_ctl", ["-D", DATA, "-l", LOG, "-o", options, "-w", "start"], true) !== 0) {
      throw new Error(`PostgreSQL did not start. See ${LOG}.`);
    }
  }
  // Create the database on first run, then apply the schema (every statement is IF NOT EXISTS).
  const admin = new pg.Client({ connectionString: `postgres://demo@127.0.0.1:${PORT}/postgres` });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'knowledge'");
  if (exists.rowCount === 0) await admin.query("CREATE DATABASE knowledge");
  await admin.end();

  const db = new pg.Client({ connectionString: `postgres://demo@127.0.0.1:${PORT}/knowledge` });
  await db.connect();
  await db.query(fs.readFileSync(path.join(ROOT, "src", "schema.sql"), "utf8"));
  await db.end();
  console.log(`PostgreSQL is running on 127.0.0.1:${PORT} (database: knowledge).`);
}

function stop(): void {
  if (!isRunning()) {
    console.log("PostgreSQL is not running.");
    return;
  }
  run("pg_ctl", ["-D", DATA, "-m", "fast", "-w", "stop"], true);
  console.log("PostgreSQL stopped.");
}

const command = process.argv[2];
try {
  if (command === "start") await start();
  else if (command === "stop") stop();
  else if (command === "status") console.log(isRunning() ? `Running on 127.0.0.1:${PORT}.` : "Not running.");
  else {
    console.error("Usage: tsx scripts/db.ts start | stop | status");
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

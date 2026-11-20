import path from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (one level above src/ or dist/). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Local demo database. In production this would be the Cloud SQL connection string. */
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://demo@127.0.0.1:54329/knowledge";

/** The nightly export from the upstream workspace. The sync reads it and never writes to it. */
export const SOURCE_FILE = process.env.SOURCE_FILE ?? path.join(ROOT, "source", "export.json");

export const LOG_DIR = process.env.LOG_DIR ?? path.join(ROOT, "logs");
export const ALERT_FILE = process.env.ALERT_FILE ?? path.join(ROOT, "alerts", "latest.md");

/** A sync older than this many hours raises an alert. The job runs nightly, so 26 leaves two hours of slack. */
export const MAX_SYNC_AGE_HOURS = 26;

/** The test question: a record that never changes, so a wrong answer always means the server is broken. */
export const CANARY = { id: "pub-0001", title: "Annual Report 2025" } as const;

/** The most records one sync run may be told to leave out with --skip. More than this is a question for the owner. */
export const MAX_SKIPPED_RECORDS = 3;

#!/usr/bin/env node
/**
 * Monitoring checks. Scheduled right after the nightly sync, and run by hand with `npm run checks`.
 *
 * Read-only: it never changes the database, the export or the server.
 * It prints a table, writes the alert to alerts/latest.md, appends one line to logs/checks.log,
 * and exits 1 when any check fails (so a scheduler can page someone).
 *
 * By default it starts the MCP server itself over stdio. Set MCP_URL to test a deployed server over
 * Streamable HTTP instead, for example MCP_URL=https://kb.example.org/mcp.
 */
import fs from "node:fs";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { ALERT_FILE, CANARY, DATABASE_URL, LOG_DIR, ROOT, SOURCE_FILE } from "./config.js";
import { closePool, describeDbError } from "./db.js";
import { PublicationRecord, readExport } from "./records.js";
import type { Publication } from "./records.js";
import { ago, formatUtc, getSyncStatus } from "./status.js";
import type { SyncStatus } from "./status.js";

type Level = "PASS" | "WARN" | "FAIL";

interface Check {
  name: string;
  level: Level;
  detail: string;
}

const EXPECTED_TOOLS = ["kb_find_staff", "kb_get_publication", "kb_list_events", "kb_search_publications", "kb_sync_status"];
const MCP_TIMEOUT_MS = 20_000;

const checks: Check[] = [];
const add = (name: string, level: Level, detail: string): void => void checks.push({ name, level, detail });

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- Database checks ----

function checkSync(status: SyncStatus): void {
  const { staff, publications, events } = status.row_counts;
  const empty = Object.entries(status.row_counts)
    .filter(([, count]) => count === 0)
    .map(([table]) => table);
  if (empty.length > 0) add("tables_have_rows", "FAIL", `Empty table(s): ${empty.join(", ")}. The knowledge base should never be empty.`);
  else add("tables_have_rows", "PASS", `${publications} publications, ${events} events, ${staff} staff`);

  const last = status.last_run;
  if (!last) add("last_sync_ok", "FAIL", "The sync has never run.");
  else if (last.status === "failed") add("last_sync_ok", "FAIL", `Run #${last.id} failed at ${formatUtc(last.finished_at)}: ${last.error ?? "no error text"}`);
  else add("last_sync_ok", "PASS", `Run #${last.id} succeeded at ${formatUtc(last.finished_at)} (${last.rows_upserted} records)`);

  const lastOk = status.last_ok_run;
  if (!lastOk) {
    add("sync_fresh", "FAIL", "There has never been a successful sync.");
  } else if (!status.fresh) {
    add("sync_fresh", "FAIL", `Last good sync finished ${ago(status.hours_since_last_ok)} (${formatUtc(lastOk.finished_at)}). The limit is ${status.max_age_hours} hours.`);
  } else {
    add("sync_fresh", "PASS", `Last good sync finished ${ago(status.hours_since_last_ok)} (limit ${status.max_age_hours} hours)`);
  }

  if (lastOk && lastOk.skipped_ids.length > 0) {
    const n = lastOk.skipped_ids.length;
    add("sync_complete", "WARN", `The last good sync left out ${n} ${n === 1 ? "record" : "records"}: ${lastOk.skipped_ids.join(", ")}. ${n === 1 ? "It stays" : "They stay"} out until fixed at the source.`);
  } else if (lastOk) {
    add("sync_complete", "PASS", "The last good sync left nothing out");
  }
}

// ---- MCP checks: ask the server the way Claude would ----

async function connectMcp(): Promise<Client> {
  const client = new Client({ name: "kb-checks", version: "1.0.0" });
  const url = process.env.MCP_URL;
  if (url) {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
  }
  // Run the TypeScript source when this file is the source, and the built server when this file is built.
  const fromSource = import.meta.url.endsWith(".ts");
  const args = fromSource ? ["--import", "tsx", path.join(ROOT, "src", "index.ts")] : [path.join(ROOT, "dist", "index.js")];
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args,
      cwd: ROOT,
      env: { ...getDefaultEnvironment(), DATABASE_URL },
      stderr: "ignore"
    })
  );
  return client;
}

/** The newest publication in the export that passes validation: what staff should be able to find today. */
function newestValidPublication(): Publication | null {
  const valid: Publication[] = [];
  for (const raw of readExport(SOURCE_FILE).publications) {
    const parsed = PublicationRecord.safeParse(raw);
    if (parsed.success) valid.push(parsed.data);
  }
  valid.sort((a, b) => b.published_on.localeCompare(a.published_on) || b.id.localeCompare(a.id));
  return valid[0] ?? null;
}

async function checkMcp(): Promise<void> {
  let client: Client;
  try {
    client = await withTimeout(connectMcp(), MCP_TIMEOUT_MS, `The MCP server did not answer within ${MCP_TIMEOUT_MS / 1000} seconds.`);
  } catch (error) {
    add("mcp_answers", "FAIL", `Could not connect to the MCP server: ${messageOf(error)}`);
    add("mcp_serves_latest", "FAIL", "Not checked, because the MCP server did not answer.");
    return;
  }

  try {
    // 1. A known question with a known answer.
    try {
      const { tools } = await withTimeout(client.listTools(), MCP_TIMEOUT_MS, "Listing tools timed out.");
      const names = tools.map(tool => tool.name);
      const missing = EXPECTED_TOOLS.filter(name => !names.includes(name));
      const canary = await withTimeout(
        client.callTool({ name: "kb_get_publication", arguments: { publication_id: CANARY.id } }),
        MCP_TIMEOUT_MS,
        "The test question timed out."
      );
      const title = (canary.structuredContent as { title?: string } | undefined)?.title;
      if (missing.length > 0) add("mcp_answers", "FAIL", `The MCP server is missing tool(s): ${missing.join(", ")}`);
      else if (canary.isError || title !== CANARY.title) add("mcp_answers", "FAIL", `Test question ${CANARY.id} should return '${CANARY.title}' but returned ${title ? `'${title}'` : "an error"}.`);
      else add("mcp_answers", "PASS", `Lists ${names.length} tools; test question ${CANARY.id} returns '${CANARY.title}'`);
    } catch (error) {
      add("mcp_answers", "FAIL", messageOf(error));
    }

    // 2. End to end: is the newest thing in the export what the server serves?
    try {
      const newest = newestValidPublication();
      if (!newest) {
        add("mcp_serves_latest", "FAIL", "The export has no valid publications at all.");
        return;
      }
      const served = await withTimeout(
        client.callTool({ name: "kb_get_publication", arguments: { publication_id: newest.id } }),
        MCP_TIMEOUT_MS,
        "Asking for the newest publication timed out."
      );
      const title = (served.structuredContent as { title?: string } | undefined)?.title;
      if (!served.isError && title === newest.title) {
        add("mcp_serves_latest", "PASS", `Newest publication in the export (${newest.id}, ${newest.published_on}) is served`);
      } else {
        add("mcp_serves_latest", "FAIL", `The export has '${newest.title}' (${newest.id}, published ${newest.published_on}) but the MCP server does not serve it. Staff asking Claude will not find it.`);
      }
    } catch (error) {
      add("mcp_serves_latest", "FAIL", `Could not compare the export with the server: ${messageOf(error)}`);
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

// ---- Report ----

function printTable(now: Date): void {
  const tty = process.stdout.isTTY;
  const paint: Record<Level, string> = { PASS: "\u001b[32m", WARN: "\u001b[33m", FAIL: "\u001b[31m" };
  const width = Math.max(...checks.map(check => check.name.length));
  console.log(`Knowledge base checks, ${formatUtc(now.toISOString())}\n`);
  for (const check of checks) {
    const level = tty ? `${paint[check.level]}${check.level}\u001b[0m` : check.level;
    console.log(`  ${level}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  console.log("");
}

function writeAlert(now: Date, failed: Check[], warned: Check[]): void {
  const rows = checks.map(check => `| ${check.name} | ${check.level} | ${check.detail.replace(/\|/g, "\\|")} |`);
  const table = ["| Check | Result | Detail |", "|---|---|---|", ...rows];
  const footer = ["", "This file is rewritten every time the checks run. `logs/checks.log` keeps one line per run.", ""];
  const lines =
    failed.length > 0
      ? [
          `# ALERT: ${failed.length} knowledge base ${failed.length === 1 ? "check" : "checks"} failed`,
          "",
          `- Checked: ${formatUtc(now.toISOString())}`,
          `- Failing: ${failed.map(check => check.name).join(", ")}`,
          ...(warned.length > 0 ? [`- Warnings: ${warned.map(check => check.name).join(", ")}`] : []),
          "",
          ...table,
          "",
          "## First steps",
          "",
          "1. Change nothing yet. Read `docs/RUNBOOK.md`: it has one section per check above.",
          "2. Find the cause with `npm run runs` and the newest `logs/sync-*.log`. A dry run (`npm run sync -- --dry-run`) is always safe: it writes nothing to the database.",
          "3. If the fix is not in the runbook's \"fix it and log it\" column, message the system owner and wait for the reply.",
          ...footer
        ]
      : [
          `# OK: all knowledge base checks passed${warned.length > 0 ? `, with ${warned.length} ${warned.length === 1 ? "warning" : "warnings"}` : ""}`,
          "",
          `- Checked: ${formatUtc(now.toISOString())}`,
          ...(warned.length > 0 ? [`- Warnings: ${warned.map(check => check.name).join(", ")}. See \`docs/RUNBOOK.md\`.`] : []),
          "",
          ...table,
          ...footer
        ];
  fs.mkdirSync(path.dirname(ALERT_FILE), { recursive: true });
  fs.writeFileSync(ALERT_FILE, lines.join("\n"));
}

// ---- Run ----

const now = new Date();
let status: SyncStatus | null = null;
try {
  status = await getSyncStatus();
  add("database_up", "PASS", "PostgreSQL answers");
} catch (error) {
  add("database_up", "FAIL", `${describeDbError(error)} The other checks were not run.`);
}

if (status) {
  checkSync(status);
  await checkMcp();
}
await closePool().catch(() => undefined);

const failed = checks.filter(check => check.level === "FAIL");
const warned = checks.filter(check => check.level === "WARN");
printTable(now);
writeAlert(now, failed, warned);

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.appendFileSync(
  path.join(LOG_DIR, "checks.log"),
  `${now.toISOString()} ${failed.length > 0 ? "FAIL" : "OK"} ${checks.map(check => `${check.name}=${check.level}`).join(" ")}\n`
);

const alertPath = path.relative(process.cwd(), ALERT_FILE);
if (failed.length > 0) {
  console.log(`${failed.length} of ${checks.length} checks FAILED. Alert written to ${alertPath}. Start with docs/RUNBOOK.md.`);
} else if (warned.length > 0) {
  console.log(`All ${checks.length} checks passed, ${warned.length} with a warning. Report written to ${alertPath}.`);
} else {
  console.log(`All ${checks.length} checks passed. Report written to ${alertPath}.`);
}
process.exit(failed.length > 0 ? 1 : 0);

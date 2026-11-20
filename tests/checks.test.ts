import { strict as assert } from "node:assert";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { createWorkspace, publication } from "./helpers.js";
import type { Workspace } from "./helpers.js";

let ws: Workspace;

/** The result of each check, read from the printed table: { last_sync_ok: "FAIL", ... } */
function levels(output: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of output.matchAll(/^\s+(PASS|WARN|FAIL)\s+(\w+)/gm)) found[match[2]] = match[1];
  return found;
}

/** Moves every recorded run into the past, as if that many hours had gone by. */
async function age(hours: number): Promise<void> {
  await ws.db.query(
    "UPDATE sync_runs SET started_at = started_at - ($1 * interval '1 hour'), finished_at = finished_at - ($1 * interval '1 hour')",
    [hours]
  );
}

const ALL_PASS = {
  database_up: "PASS",
  tables_have_rows: "PASS",
  last_sync_ok: "PASS",
  sync_fresh: "PASS",
  sync_complete: "PASS",
  mcp_answers: "PASS",
  mcp_serves_latest: "PASS"
};

before(async () => {
  ws = await createWorkspace("checks");
});

beforeEach(async () => {
  await ws.wipe();
  ws.writeExport(ws.healthy());
  fs.rmSync(ws.alertFile, { force: true });
});

after(async () => {
  await ws.close();
});

test("a healthy system passes every check and exits 0", async () => {
  assert.equal(ws.run("sync").status, 0);
  const result = ws.run("checks");
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(levels(result.output), ALL_PASS);
  assert.match(fs.readFileSync(ws.alertFile, "utf8"), /^# OK: all knowledge base checks passed/);
});

test("a blocked sync raises the alert: failed run, stale data, newest publication not served", async () => {
  assert.equal(ws.run("sync").status, 0);
  await age(30);
  const data = ws.healthy();
  data.publications.push(publication("pub-0025"), publication("pub-0026", { published_on: "2026-11-31" }));
  ws.writeExport(data);
  assert.equal(ws.run("sync").status, 1);

  const result = ws.run("checks");
  assert.equal(result.status, 1);
  assert.deepEqual(levels(result.output), { ...ALL_PASS, last_sync_ok: "FAIL", sync_fresh: "FAIL", mcp_serves_latest: "FAIL" });
  assert.match(result.output, /pub-0026: published_on '2026-11-31' is not a real calendar date/);
  assert.match(result.output, /Last good sync finished 30 hours ago/);

  const alert = fs.readFileSync(ws.alertFile, "utf8");
  assert.match(alert, /^# ALERT: 3 knowledge base checks failed/);
  assert.match(alert, /Failing: last_sync_ok, sync_fresh, mcp_serves_latest/);
  assert.match(alert, /docs\/RUNBOOK\.md/);
});

test("after the runbook fix every check passes, with a warning about the record left out", async () => {
  const data = ws.healthy();
  data.publications.push(publication("pub-0025"), publication("pub-0026", { published_on: "2026-11-31" }));
  ws.writeExport(data);
  assert.equal(ws.run("sync", "--skip", "pub-0026").status, 0);

  const result = ws.run("checks");
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(levels(result.output), { ...ALL_PASS, sync_complete: "WARN" });
  assert.match(result.output, /left out 1 record: pub-0026/);
  assert.match(fs.readFileSync(ws.alertFile, "utf8"), /^# OK: all knowledge base checks passed, with 1 warning\n/);
});

test("the freshness limit is 26 hours: 25 passes, 27 fails", async () => {
  assert.equal(ws.run("sync").status, 0);
  await age(25);
  assert.equal(levels(ws.run("checks").output).sync_fresh, "PASS");
  await age(2);
  const result = ws.run("checks");
  assert.equal(result.status, 1);
  assert.deepEqual(levels(result.output), { ...ALL_PASS, sync_fresh: "FAIL" });
});

test("a failed run alone is an alert even while the data is still fresh", async () => {
  assert.equal(ws.run("sync").status, 0);
  const data = ws.healthy();
  data.publications.push(publication("pub-0026", { published_on: "2026-11-31" }));
  ws.writeExport(data);
  assert.equal(ws.run("sync").status, 1);

  const result = ws.run("checks");
  assert.equal(result.status, 1);
  assert.deepEqual(levels(result.output), { ...ALL_PASS, last_sync_ok: "FAIL" });
});

test("an empty knowledge base is an alert", async () => {
  const result = ws.run("checks");
  assert.equal(result.status, 1);
  const found = levels(result.output);
  assert.equal(found.tables_have_rows, "FAIL");
  assert.equal(found.last_sync_ok, "FAIL");
  assert.equal(found.sync_fresh, "FAIL");
  assert.equal(found.mcp_answers, "FAIL", "the test question has no answer in an empty database");
});

test("an unreachable database stops the checks with one clear failure", () => {
  // Nothing listens on port 9, so the connection is refused at once.
  const result = ws.runWith({ DATABASE_URL: "postgres://demo@127.0.0.1:9/knowledge" }, "checks");
  assert.equal(result.status, 1);
  assert.deepEqual(levels(result.output), { database_up: "FAIL" });
  assert.match(result.output, /The database is not reachable/);
  assert.match(fs.readFileSync(ws.alertFile, "utf8"), /^# ALERT: 1 knowledge base check failed/);
});

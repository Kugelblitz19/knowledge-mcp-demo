import { strict as assert } from "node:assert";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { createWorkspace, publication } from "./helpers.js";
import type { Workspace } from "./helpers.js";

let ws: Workspace;

interface RunRow {
  status: string;
  rows_read: number;
  rows_upserted: number;
  skipped_ids: string[];
  error: string | null;
}

async function runs(): Promise<RunRow[]> {
  const result = await ws.db.query<RunRow>("SELECT status, rows_read, rows_upserted, skipped_ids, error FROM sync_runs ORDER BY id");
  return result.rows;
}

async function titleOf(id: string): Promise<string | undefined> {
  const result = await ws.db.query<{ title: string }>("SELECT title FROM publications WHERE id = $1", [id]);
  return result.rows[0]?.title;
}

before(async () => {
  ws = await createWorkspace("sync");
});

beforeEach(async () => {
  await ws.wipe();
  ws.writeExport(ws.healthy());
});

after(async () => {
  await ws.close();
});

test("a healthy export loads completely and records one good run", async () => {
  const result = ws.run("sync");
  assert.equal(result.status, 0, result.output);
  assert.equal(await ws.count("staff"), 8);
  assert.equal(await ws.count("publications"), 24);
  assert.equal(await ws.count("events"), 6);
  assert.deepEqual(await runs(), [{ status: "ok", rows_read: 38, rows_upserted: 38, skipped_ids: [], error: null }]);
});

test("running twice changes nothing: records are updated in place, not duplicated", async () => {
  assert.equal(ws.run("sync").status, 0);
  assert.equal(ws.run("sync").status, 0);
  assert.equal(await ws.count("publications"), 24);
  assert.equal(await ws.count("sync_runs"), 2);
});

test("a changed record upstream is updated in the database", async () => {
  assert.equal(ws.run("sync").status, 0);
  const data = ws.healthy();
  data.publications[0].title = "Annual Report 2025 (revised)";
  ws.writeExport(data);
  assert.equal(ws.run("sync").status, 0);
  assert.equal(await titleOf("pub-0001"), "Annual Report 2025 (revised)");
});

test("the sync never deletes: a record that vanishes from the export stays in the database", async () => {
  assert.equal(ws.run("sync").status, 0);
  const data = ws.healthy();
  data.publications = data.publications.filter(item => item.id !== "pub-0010");
  ws.writeExport(data);
  assert.equal(ws.run("sync").status, 0);
  assert.equal(await ws.count("publications"), 24);
  assert.ok(await titleOf("pub-0010"));
});

test("all or nothing: one bad record stops the good ones too", async () => {
  assert.equal(ws.run("sync").status, 0);
  const data = ws.healthy();
  data.publications[0].title = "Changed title that must not land";
  data.publications.push(publication("pub-0025"), publication("pub-0026", { published_on: "2026-11-31" }));
  ws.writeExport(data);

  const result = ws.run("sync");
  assert.equal(result.status, 1);
  assert.match(result.output, /INVALID publications pub-0026: published_on '2026-11-31' is not a real calendar date/);
  assert.match(result.output, /FAILED 1 invalid record\. Nothing was written\. Run #2\./);
  assert.equal(await ws.count("publications"), 24, "the valid new record must not be loaded either");
  assert.equal(await titleOf("pub-0001"), "Annual Report 2025", "an update in the same batch must not land");

  const all = await runs();
  assert.equal(all.length, 2);
  assert.equal(all[1].status, "failed");
  assert.equal(all[1].rows_upserted, 0);
  assert.match(all[1].error ?? "", /pub-0026/);
});

test("every bad record is reported, not only the first", async () => {
  const data = ws.healthy();
  data.publications.push(publication("pub-0030", { published_on: "2026-02-30" }), publication("pub-0031", { title: "" }));
  data.events.push({ id: "evt-900", title: "Bad event", starts_on: "soon", location: "Online", owner_id: "s-01" });
  ws.writeExport(data);
  const result = ws.run("sync", "--dry-run");
  assert.equal(result.status, 1);
  assert.match(result.output, /INVALID publications pub-0030/);
  assert.match(result.output, /INVALID publications pub-0031/);
  assert.match(result.output, /INVALID events evt-900/);
  assert.match(result.output, /dry run found 3 invalid records\. A real run would stop here/);
});

test("a publication whose author is not on the staff list is rejected", async () => {
  const data = ws.healthy();
  data.publications.push(publication("pub-0040", { author_id: "s-99" }));
  ws.writeExport(data);
  const result = ws.run("sync");
  assert.equal(result.status, 1);
  assert.match(result.output, /pub-0040: author_id 's-99' is not in the staff list/);
  assert.equal(await ws.count("publications"), 0);
});

test("a dry run never writes: no rows, no run record, whatever it finds", async () => {
  const data = ws.healthy();
  data.publications.push(publication("pub-0026", { published_on: "2026-11-31" }));
  ws.writeExport(data);

  assert.equal(ws.run("sync", "--dry-run").status, 1);
  const clean = ws.run("sync", "--dry-run", "--skip", "pub-0026");
  assert.equal(clean.status, 0, clean.output);
  assert.match(clean.output, /dry run OK: 38 records valid, 1 left out \(pub-0026\)\. A real run would add 38, change 0 and leave 0 as they are\. Nothing was written\./);

  assert.equal(await ws.count("publications"), 0);
  assert.equal(await ws.count("sync_runs"), 0);
});

test("a dry run previews what a real run would add and change", async () => {
  assert.equal(ws.run("sync").status, 0);
  const data = ws.healthy();
  data.publications[0].title = "Annual Report 2025 (revised)";
  data.events[0].location = "Hybrid";
  data.publications.push(publication("pub-0025"));
  ws.writeExport(data);

  const preview = ws.run("sync", "--dry-run");
  assert.equal(preview.status, 0, preview.output);
  assert.match(preview.output, /A real run would add 1, change 2 and leave 36 as they are\./);
  assert.equal(await titleOf("pub-0001"), "Annual Report 2025", "the preview must not write");

  const real = ws.run("sync");
  assert.match(real.output, /OK 39 records written \(1 new, 2 changed, 36 unchanged\)\. Run #2\./);
});

test("--skip loads everything else and stores what was left out", async () => {
  const data = ws.healthy();
  data.publications.push(publication("pub-0025"), publication("pub-0026", { published_on: "2026-11-31" }));
  ws.writeExport(data);

  const result = ws.run("sync", "--skip", "pub-0026");
  assert.equal(result.status, 0, result.output);
  assert.equal(await ws.count("publications"), 25);
  assert.ok(await titleOf("pub-0025"));
  assert.equal(await titleOf("pub-0026"), undefined);
  assert.deepEqual(await runs(), [{ status: "ok", rows_read: 40, rows_upserted: 39, skipped_ids: ["pub-0026"], error: null }]);
});

test("--skip does not excuse a second bad record", async () => {
  const data = ws.healthy();
  data.publications.push(publication("pub-0026", { published_on: "2026-11-31" }), publication("pub-0027", { published_on: "2026-02-30" }));
  ws.writeExport(data);
  const result = ws.run("sync", "--skip", "pub-0026");
  assert.equal(result.status, 1);
  assert.match(result.output, /INVALID publications pub-0027/);
  assert.equal(await ws.count("publications"), 0);
});

test("--skip refuses an id that is not in the export", async () => {
  const result = ws.run("sync", "--skip", "pub-9999");
  assert.equal(result.status, 2);
  assert.match(result.output, /REFUSED --skip named record\(s\) that are not in the export: pub-9999/);
  assert.equal(await ws.count("publications"), 0);
  assert.equal(await ws.count("sync_runs"), 0);
});

test("--skip refuses more than three records", async () => {
  const result = ws.run("sync", "--skip", "pub-0001,pub-0002,pub-0003,pub-0004");
  assert.equal(result.status, 2);
  assert.match(result.output, /the limit is 3/);
  assert.equal(await ws.count("publications"), 0);

  const three = ws.run("sync", "--skip", "pub-0001,pub-0002,pub-0003");
  assert.equal(three.status, 0, three.output);
  assert.equal(await ws.count("publications"), 21);
});

test("unknown arguments are refused before anything runs", async () => {
  for (const args of [["--force"], ["--skip"], ["--skip", "--dry-run"], ["pub-0001"]]) {
    const result = ws.run("sync", ...args);
    assert.equal(result.status, 2, args.join(" "));
  }
  assert.equal(await ws.count("sync_runs"), 0);
});

test("a missing export fails the run and says why", async () => {
  fs.rmSync(ws.exportFile);
  const result = ws.run("sync");
  assert.equal(result.status, 1);
  const all = await runs();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "failed");
  assert.match(all[0].error ?? "", /could not read the export file/);
});

test("every run leaves a log file", async () => {
  fs.rmSync(ws.logDir, { recursive: true, force: true });
  assert.equal(ws.run("sync").status, 0);
  assert.equal(ws.run("sync", "--dry-run").status, 0);
  const names = fs.readdirSync(ws.logDir);
  const real = names.filter(name => /^sync-\d{8}T\d{6}\.log$/.test(name));
  const dry = names.filter(name => /^dryrun-\d{8}T\d{6}\.log$/.test(name));
  assert.equal(real.length, 1, "one log per real run, named sync-");
  assert.equal(dry.length, 1, "a dry run logs under its own name, so the newest sync log is always a real run");
  assert.match(fs.readFileSync(`${ws.logDir}/${real[0]}`, "utf8"), /OK 38 records written \(38 new, 0 changed, 0 unchanged\)\. Run #1\./);
});

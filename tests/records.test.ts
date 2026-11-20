import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ROOT } from "../src/config.js";
import { EventRecord, PublicationRecord, StaffRecord, isRealDate, readExport } from "../src/records.js";

test("isRealDate accepts dates that exist", () => {
  for (const date of ["2026-11-30", "2026-01-01", "2026-12-31", "2028-02-29"]) {
    assert.equal(isRealDate(date), true, date);
  }
});

test("isRealDate rejects dates that do not exist", () => {
  // 31 November and 29 February 2026 are the dangerous ones: JavaScript rolls them into the next month.
  for (const date of ["2026-11-31", "2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-04-00", "not-a-date", ""]) {
    assert.equal(isRealDate(date), false, date);
  }
});

test("a publication needs a correctly shaped, real date", () => {
  const base = { id: "p", title: "T", summary: "S", topic: "X", author_id: "s-01", url: "u" };
  assert.equal(PublicationRecord.safeParse({ ...base, published_on: "2026-11-30" }).success, true);
  for (const published_on of ["2026-11-31", "30-11-2026", "2026/11/30", "20261130", 20261130, null]) {
    assert.equal(PublicationRecord.safeParse({ ...base, published_on }).success, false, String(published_on));
  }
});

test("a record with a missing or empty field is rejected", () => {
  const good = { id: "p", title: "T", summary: "S", topic: "X", published_on: "2026-11-30", author_id: "s-01", url: "u" };
  for (const field of Object.keys(good)) {
    const missing: Record<string, unknown> = { ...good };
    delete missing[field];
    assert.equal(PublicationRecord.safeParse(missing).success, false, `missing ${field}`);
    assert.equal(PublicationRecord.safeParse({ ...good, [field]: "" }).success, false, `empty ${field}`);
  }
});

test("every record in the healthy export is valid", () => {
  const data = readExport(path.join(ROOT, "source", "export.healthy.json"));
  assert.equal(data.staff.length, 8);
  assert.equal(data.publications.length, 24);
  assert.equal(data.events.length, 6);
  for (const raw of data.staff) assert.equal(StaffRecord.safeParse(raw).success, true);
  for (const raw of data.publications) assert.equal(PublicationRecord.safeParse(raw).success, true);
  for (const raw of data.events) assert.equal(EventRecord.safeParse(raw).success, true);
});

test("readExport fails loudly on a file that is not an export", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kb-records-")), "bad.json");
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => readExport(file));
  fs.writeFileSync(file, JSON.stringify({ staff: [] }));
  assert.throws(() => readExport(file));
  assert.throws(() => readExport(path.join(path.dirname(file), "missing.json")));
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

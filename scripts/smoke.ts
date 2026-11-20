/**
 * Self-check: starts the MCP server over stdio, calls every tool the way a client would,
 * and exits non-zero on the first failure.
 *
 *   npm run smoke            runs the TypeScript source
 *   npm run smoke -- --dist  runs the built server in dist/ (after `npm run build`)
 *
 * Needs the database running with a good sync in it (`npm run demo:reset` gives you that).
 */
import { strict as assert } from "node:assert";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { DATABASE_URL, ROOT } from "../src/config.js";

const useDist = process.argv.includes("--dist");
const serverArgs = useDist ? [path.join(ROOT, "dist", "index.js")] : ["--import", "tsx", path.join(ROOT, "src", "index.ts")];

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: serverArgs,
    cwd: ROOT,
    // The child gets only a safe default environment, so pass the server's own settings explicitly.
    env: { ...getDefaultEnvironment(), DATABASE_URL },
    stderr: "ignore"
  })
);

function textOf(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as { type: string; text?: string }[];
  return blocks.map(block => block.text ?? "").join("\n");
}

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.error(`  ok  ${label}`);
}

try {
  // 1. The tool list is exactly what the README promises.
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map(tool => tool.name).sort(),
    ["kb_find_staff", "kb_get_publication", "kb_list_events", "kb_search_publications", "kb_sync_status"]
  );
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be marked read-only`);
    assert.ok(tool.description && tool.description.length > 40, `${tool.name} needs a real description`);
  }
  ok("lists 5 read-only tools");

  // 2. Search, in JSON, with paging.
  const search = await client.callTool({
    name: "kb_search_publications",
    arguments: { query: "evaluations", response_format: "json" }
  });
  assert.ok(!search.isError, `search failed: ${textOf(search)}`);
  const page = search.structuredContent as { total: number; publications: { id: string; title: string }[] };
  assert.ok(page.total >= 1 && page.publications.some(item => item.id === "pub-0004"), "'evaluations' should find pub-0004");
  assert.deepEqual(JSON.parse(textOf(search)), search.structuredContent, "JSON text must match structuredContent");
  ok(`search 'evaluations' finds ${page.total} publication(s), including pub-0004`);

  const firstPage = await client.callTool({ name: "kb_search_publications", arguments: { limit: 5, response_format: "json" } });
  const first = firstPage.structuredContent as { total: number; count: number; has_more: boolean; next_offset?: number; publications: { id: string; published_on: string }[] };
  assert.equal(first.count, 5);
  assert.equal(first.has_more, true);
  assert.equal(first.next_offset, 5);
  const dates = first.publications.map(item => item.published_on);
  assert.deepEqual(dates, [...dates].sort().reverse(), "publications must come newest first");
  assert.match(dates[0], /^\d{4}-\d{2}-\d{2}$/, "dates must be plain YYYY-MM-DD");
  ok(`paging: 5 of ${first.total}, next_offset=5, newest first (${dates[0]})`);

  // 3. Search in Markdown, with a topic filter and two words that must both match.
  const markdown = await client.callTool({
    name: "kb_search_publications",
    arguments: { query: "consent phone", topic: "data protection" }
  });
  assert.ok(!markdown.isError);
  assert.match(textOf(markdown), /Consent that works on a phone screen \(pub-0012\)/);
  assert.match(textOf(markdown), /Showing 1 of 1\./);
  assert.match(textOf(markdown), /last good sync/);
  ok("markdown search with topic filter returns pub-0012 and a freshness line");

  // A wildcard typed by a user is treated as plain text, not as "match everything".
  const wildcard = await client.callTool({ name: "kb_search_publications", arguments: { query: "%" } });
  assert.match(textOf(wildcard), /No publications found/);
  ok("a bare '%' is not treated as a wildcard");

  // 4. Get one publication.
  const one = await client.callTool({ name: "kb_get_publication", arguments: { publication_id: "pub-0001" } });
  assert.ok(!one.isError, `get failed: ${textOf(one)}`);
  const publication = one.structuredContent as { title: string; published_on: string; author: { name: string } };
  assert.equal(publication.title, "Annual Report 2025");
  assert.equal(publication.published_on, "2026-02-10");
  assert.equal(publication.author.name, "Asha Menon");
  ok("get pub-0001 returns the Annual Report with the right date and author");

  // 5. An unknown id is a tool error the model can read and recover from.
  const missing = await client.callTool({ name: "kb_get_publication", arguments: { publication_id: "pub-9999" } });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /kb_search_publications/);
  ok("an unknown id returns a readable error that names the next step");

  // 6. Events and staff.
  const events = await client.callTool({ name: "kb_list_events", arguments: { from_date: "2027-01-01", response_format: "json" } });
  assert.ok(!events.isError, `events failed: ${textOf(events)}`);
  const eventPage = events.structuredContent as { total: number; events: { id: string; starts_on: string }[] };
  assert.equal(eventPage.total, 4);
  assert.equal(eventPage.events[0].id, "evt-003");
  assert.equal(eventPage.events[0].starts_on, "2027-01-21");
  ok("events on or after 2027-01-01: 4, soonest first");

  const staff = await client.callTool({ name: "kb_find_staff", arguments: { query: "analyst" } });
  assert.ok(!staff.isError);
  assert.match(textOf(staff), /Lena Fischer/);
  assert.match(textOf(staff), /Rafael Costa/);
  assert.match(textOf(staff), /Showing 2 of 2\./);
  ok("staff search 'analyst' finds both analysts");

  // 7. Sync status.
  const status = await client.callTool({ name: "kb_sync_status", arguments: {} });
  assert.ok(!status.isError, `status failed: ${textOf(status)}`);
  const sync = status.structuredContent as { row_counts: { publications: number }; max_age_hours: number; last_run: unknown };
  assert.ok(sync.row_counts.publications >= 24);
  assert.equal(sync.max_age_hours, 26);
  assert.ok(sync.last_run, "there should be at least one sync run");
  ok(`sync status reports ${sync.row_counts.publications} publications`);

  // 8. Bad input never reaches the database.
  const badDate = await client.callTool({ name: "kb_list_events", arguments: { from_date: "2026-11-31" } });
  assert.equal(badDate.isError, true, "31 November must be rejected");
  const badLimit = await client.callTool({ name: "kb_search_publications", arguments: { limit: 500 } });
  assert.equal(badLimit.isError, true, "limit above 50 must be rejected");
  const unknownArg = await client.callTool({ name: "kb_find_staff", arguments: { query: "lena", team: "x" } });
  assert.equal(unknownArg.isError, true, "unknown arguments must be rejected");
  ok("invalid dates, oversized limits and unknown arguments are rejected");

  console.error(`Smoke test passed (${passed} groups, ${useDist ? "built server" : "source"}).`);
} finally {
  await client.close();
}

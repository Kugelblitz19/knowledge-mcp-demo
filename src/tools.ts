/**
 * The five tools the MCP server offers. All of them only read.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { QueryResultRow } from "pg";
import * as z from "zod/v4";
import { describeDbError, pool } from "./db.js";
import { isRealDate } from "./records.js";
import { SyncStatusSchema, ago, formatUtc, freshnessLine, getSyncStatus } from "./status.js";

/** Responses stay under this size by returning fewer items, never by cutting text. */
const CHARACTER_LIMIT = 25_000;

/** Every tool reads the organisation's own database and changes nothing. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json"
}

const formatArg = z
  .enum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("'markdown' for readable text, 'json' for structured data");

// ---- Database access ----

/** Runs a read query. A failure becomes an error message that says what to do, which the model can read. */
async function query<Row extends QueryResultRow>(text: string, params: unknown[] = []): Promise<Row[]> {
  try {
    return (await pool.query<Row>(text, params)).rows;
  } catch (error) {
    throw new Error(describeDbError(error));
  }
}

/** Turns free text into LIKE patterns, one per word, with the wildcard characters escaped. */
function likePatterns(text: string): string[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map(word => `%${word.replace(/[\\%_]/g, "\\$&")}%`);
}

// ---- Shapes ----

const PublicationSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  topic: z.string(),
  published_on: z.string(),
  url: z.string(),
  author: z.object({ id: z.string(), name: z.string(), role: z.string(), team: z.string() })
});

type PublicationOut = z.infer<typeof PublicationSchema>;

interface PublicationRow {
  id: string;
  title: string;
  summary: string;
  topic: string;
  published_on: string;
  url: string;
  author_id: string;
  author_name: string;
  author_role: string;
  author_team: string;
}

const PUBLICATION_SELECT = `
  SELECT p.id, p.title, p.summary, p.topic, p.published_on, p.url,
         s.id AS author_id, s.name AS author_name, s.role AS author_role, s.team AS author_team
  FROM publications p
  JOIN staff s ON s.id = p.author_id`;

function toPublication(row: PublicationRow): PublicationOut {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    topic: row.topic,
    published_on: row.published_on,
    url: row.url,
    author: { id: row.author_id, name: row.author_name, role: row.author_role, team: row.author_team }
  };
}

function formatPublication(item: PublicationOut): string {
  return [
    `## ${item.title} (${item.id})`,
    `- Published: ${item.published_on}`,
    `- Topic: ${item.topic}`,
    `- Author: ${item.author.name}, ${item.author.role}`,
    `- Summary: ${item.summary}`,
    `- Link: ${item.url}`
  ].join("\n");
}

interface EventOut {
  id: string;
  title: string;
  starts_on: string;
  location: string;
  owner: string;
}

interface StaffOut {
  id: string;
  name: string;
  role: string;
  team: string;
  email: string;
}

/**
 * Builds one page of a list in the requested format and keeps it under CHARACTER_LIMIT by returning fewer items.
 * `next_offset` then points at the first item that was left out.
 */
function renderPage<Item>(options: {
  items: Item[];
  total: number;
  offset: number;
  key: string;
  format: ResponseFormat;
  extra: Record<string, unknown>;
  markdown: (items: Item[]) => string[];
}): { text: string; page: Record<string, unknown> } {
  const build = (items: Item[]) => {
    const nextOffset = options.offset + items.length;
    const hasMore = options.total > nextOffset;
    const page: Record<string, unknown> = {
      total: options.total,
      count: items.length,
      offset: options.offset,
      [options.key]: items,
      has_more: hasMore,
      ...(hasMore ? { next_offset: nextOffset } : {}),
      ...options.extra
    };
    if (options.format === ResponseFormat.JSON) return { page, text: JSON.stringify(page, null, 2) };
    const lines = options.markdown(items);
    if (hasMore) lines.push("", `More results: call again with offset=${nextOffset}.`);
    return { page, text: lines.join("\n") };
  };

  let items = options.items;
  let result = build(items);
  while (items.length > 1 && result.text.length > CHARACTER_LIMIT) {
    items = items.slice(0, Math.ceil(items.length / 2));
    result = build(items);
  }
  return result;
}

function reply(format: ResponseFormat, result: { text: string; page: Record<string, unknown> }) {
  if (format === ResponseFormat.JSON) {
    return { content: [{ type: "text" as const, text: result.text }], structuredContent: result.page };
  }
  return { content: [{ type: "text" as const, text: result.text }] };
}

// ---- Tools ----

export function registerTools(server: McpServer): void {
  server.registerTool(
    "kb_search_publications",
    {
      title: "Search publications",
      description: `Search the organisation's publications by words in the title, summary, topic or author name. Newest first.

Returns one page of matches with id, title, date, topic, author, summary and link. When more matches exist the result gives next_offset; call again with that offset. The last line says how fresh the data is.

Examples:
  - "What have we published on model evaluations?" -> query="evaluations"
  - "Latest data protection papers" -> topic="Data protection"
  - "Newest five publications" -> limit=5
Use kb_get_publication when you already have an id such as 'pub-0004'.`,
      inputSchema: z.strictObject({
        query: z
          .string()
          .max(200)
          .default("")
          .describe("Words to look for. Every word must match somewhere in the title, summary, topic or author name. Empty lists the newest publications."),
        topic: z
          .string()
          .max(100)
          .optional()
          .describe("Only this topic, matched exactly but ignoring case, e.g. 'AI governance', 'Data protection', 'Digital public services', 'Organisation'"),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of publications to return"),
        offset: z.number().int().min(0).default(0).describe("Number of matches to skip, for pagination"),
        response_format: formatArg
      }),
      annotations: READ_ONLY
    },
    async ({ query: text, topic, limit, offset, response_format }) => {
      const where: string[] = [];
      const params: unknown[] = [];
      for (const pattern of likePatterns(text)) {
        params.push(pattern);
        const n = params.length;
        where.push(`(p.title ILIKE $${n} OR p.summary ILIKE $${n} OR p.topic ILIKE $${n} OR s.name ILIKE $${n})`);
      }
      if (topic) {
        params.push(topic);
        where.push(`lower(p.topic) = lower($${params.length})`);
      }
      const filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

      const [{ total }] = await query<{ total: number }>(
        `SELECT count(*)::int AS total FROM publications p JOIN staff s ON s.id = p.author_id ${filter}`,
        params
      );
      const rows = await query<PublicationRow>(
        `${PUBLICATION_SELECT} ${filter} ORDER BY p.published_on DESC, p.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      const freshness = freshnessLine(await getSyncStatus());

      if (rows.length === 0 && response_format === ResponseFormat.MARKDOWN) {
        const hint = total > 0 ? `There are ${total} matches; offset=${offset} is past the end.` : "Try fewer or different words, or drop the topic filter.";
        return { content: [{ type: "text", text: `No publications found. ${hint}\n\n${freshness}` }] };
      }

      const label = [text ? `'${text}'` : "", topic ? `topic '${topic}'` : ""].filter(Boolean).join(", ");
      const result = renderPage({
        items: rows.map(toPublication),
        total,
        offset,
        key: "publications",
        format: response_format,
        extra: { freshness },
        markdown: items => [
          `# Publications${label ? ` matching ${label}` : ", newest first"}`,
          `Showing ${items.length} of ${total}.`,
          "",
          items.map(formatPublication).join("\n\n"),
          "",
          freshness
        ]
      });
      return reply(response_format, result);
    }
  );

  server.registerTool(
    "kb_get_publication",
    {
      title: "Get publication",
      description: "Get one publication by its id, with its summary, link and author. Use kb_search_publications to find ids.",
      inputSchema: z.strictObject({
        publication_id: z.string().min(1).max(40).describe("Publication id, e.g. 'pub-0004'")
      }),
      outputSchema: PublicationSchema,
      annotations: READ_ONLY
    },
    async ({ publication_id }) => {
      const rows = await query<PublicationRow>(`${PUBLICATION_SELECT} WHERE p.id = $1`, [publication_id]);
      if (rows.length === 0) {
        throw new Error(
          `No publication has the id '${publication_id}'. Ids look like 'pub-0004'; kb_search_publications returns valid ones.`
        );
      }
      const publication = toPublication(rows[0]);
      return { content: [{ type: "text", text: JSON.stringify(publication, null, 2) }], structuredContent: publication };
    }
  );

  server.registerTool(
    "kb_list_events",
    {
      title: "List events",
      description: `List the organisation's events on or after a date, soonest first. With no date it lists upcoming events from today.

Examples:
  - "What events are coming up?" -> no arguments
  - "What happened in or after March 2027?" -> from_date="2027-03-01"`,
      inputSchema: z.strictObject({
        from_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the form YYYY-MM-DD")
          .refine(isRealDate, "That is not a real calendar date")
          .optional()
          .describe("First day to include, as YYYY-MM-DD. Defaults to today (UTC)."),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of events to return"),
        offset: z.number().int().min(0).default(0).describe("Number of events to skip, for pagination"),
        response_format: formatArg
      }),
      annotations: READ_ONLY
    },
    async ({ from_date, limit, offset, response_format }) => {
      const from = from_date ?? new Date().toISOString().slice(0, 10);
      const [{ total }] = await query<{ total: number }>("SELECT count(*)::int AS total FROM events WHERE starts_on >= $1", [from]);
      const rows = await query<EventOut>(
        `SELECT e.id, e.title, e.starts_on, e.location, s.name AS owner
         FROM events e JOIN staff s ON s.id = e.owner_id
         WHERE e.starts_on >= $1 ORDER BY e.starts_on, e.id LIMIT $2 OFFSET $3`,
        [from, limit, offset]
      );
      const freshness = freshnessLine(await getSyncStatus());

      if (rows.length === 0 && response_format === ResponseFormat.MARKDOWN) {
        return { content: [{ type: "text", text: `No events on or after ${from}. Try an earlier from_date.\n\n${freshness}` }] };
      }
      const result = renderPage({
        items: rows,
        total,
        offset,
        key: "events",
        format: response_format,
        extra: { from_date: from, freshness },
        markdown: items => [
          `# Events on or after ${from}`,
          `Showing ${items.length} of ${total}.`,
          "",
          ...items.map(item => `- ${item.starts_on}: ${item.title} (${item.id}), ${item.location}. Owner: ${item.owner}`),
          "",
          freshness
        ]
      });
      return reply(response_format, result);
    }
  );

  server.registerTool(
    "kb_find_staff",
    {
      title: "Find staff",
      description: `Find staff members by part of their name, role or team. Returns name, role, team and work email.

Examples:
  - "Who runs communications?" -> query="communications"
  - "What does Lena do?" -> query="Lena"`,
      inputSchema: z.strictObject({
        query: z.string().min(2).max(100).describe("Part of a name, role or team, e.g. 'analyst', 'Operations', 'Okafor'"),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of people to return"),
        response_format: formatArg
      }),
      annotations: READ_ONLY
    },
    async ({ query: text, limit, response_format }) => {
      const where: string[] = [];
      const params: unknown[] = [];
      for (const pattern of likePatterns(text)) {
        params.push(pattern);
        const n = params.length;
        where.push(`(name ILIKE $${n} OR role ILIKE $${n} OR team ILIKE $${n})`);
      }
      const filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const [{ total }] = await query<{ total: number }>(`SELECT count(*)::int AS total FROM staff ${filter}`, params);
      const rows = await query<StaffOut>(
        `SELECT id, name, role, team, email FROM staff ${filter} ORDER BY name LIMIT $${params.length + 1}`,
        [...params, limit]
      );

      if (rows.length === 0 && response_format === ResponseFormat.MARKDOWN) {
        return { content: [{ type: "text", text: `No staff match '${text}'. Try part of a name, a role such as 'analyst', or a team.` }] };
      }
      const result = renderPage({
        items: rows,
        total,
        offset: 0,
        key: "staff",
        format: response_format,
        extra: {},
        markdown: items => [
          `# Staff matching '${text}'`,
          `Showing ${items.length} of ${total}.`,
          "",
          ...items.map(person => `- ${person.name} (${person.id}): ${person.role}, ${person.team} team. ${person.email}`)
        ]
      });
      return reply(response_format, result);
    }
  );

  server.registerTool(
    "kb_sync_status",
    {
      title: "Sync status",
      description: `Report how fresh the knowledge base is: the last sync run, the last successful run, hours since then, whether that is within the limit, and the row counts.

Use it when someone asks "is this up to date?", or when a search result carries a staleness warning.`,
      outputSchema: SyncStatusSchema,
      annotations: READ_ONLY
    },
    async () => {
      let status;
      try {
        status = await getSyncStatus();
      } catch (error) {
        throw new Error(describeDbError(error));
      }
      const lines = [
        status.last_ok_run
          ? `Last good sync: ${formatUtc(status.last_ok_run.finished_at)} (${ago(status.hours_since_last_ok)}; the limit is ${status.max_age_hours} hours). ${status.fresh ? "Fresh." : "STALE."}`
          : "The knowledge base has never been synced.",
        status.last_run && status.last_run.status === "failed"
          ? `Most recent run FAILED at ${formatUtc(status.last_run.finished_at)}: ${status.last_run.error ?? "no error text"}`
          : "Most recent run succeeded.",
        `Rows: ${status.row_counts.publications} publications, ${status.row_counts.events} events, ${status.row_counts.staff} staff.`,
        "",
        JSON.stringify(status, null, 2)
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: status };
    }
  );
}

# Knowledge base MCP server, with the operations around it

A small, complete copy of a common setup: staff ask Claude questions, and an MCP server answers them from a PostgreSQL database that a nightly job fills from the organisation's workspace.

The server is the easy part. This repository is mostly about what surrounds it: the nightly sync, the monitoring checks, a runbook, and a staged failure to practise on.

**Read this first.** It is a demo. The organisation ("Meridian Policy Lab") and all its data are made up. It runs on one laptop and has not been deployed anywhere. I built it by directing Claude Code: I decided what it should do and checked the results, and Claude Code wrote the code.

```
 workspace export        nightly sync         PostgreSQL        MCP server          Claude
 source/export.json ---> src/sync.ts -------> 4 tables -------> src/index.ts -----> staff questions
                         all or nothing                         5 read-only tools
        ^                      |                   ^                  ^
        |                      v                   |                  |
        +------------- src/checks.ts: 7 checks, asks the server the way Claude would
                               |
                               v
                       alerts/latest.md ---> docs/RUNBOOK.md ---> incidents/
```

## Run it

Needs Node.js 20.6 or later; I built and tested it on Node 26, on macOS (Apple silicon) only. PostgreSQL 17 comes with `npm install`, so there is nothing else to set up. If the bundled database does not start on your machine, point `DATABASE_URL` at any PostgreSQL and apply `src/schema.sql`.

```bash
npm install
npm run db:start      # local PostgreSQL on 127.0.0.1:54329
npm run demo:reset    # a healthy system: 24 publications, 6 events, 8 staff
npm run checks        # all 7 checks pass
npm run smoke         # calls every MCP tool the way a client would
npm test              # 29 tests of the sync rules and the checks, in their own databases
```

To use it from Claude Code, open this folder: `.mcp.json` registers the server as `knowledge`.

## The staged failure

```bash
npm run demo:break
npm run checks
```

```
  PASS  database_up        PostgreSQL answers
  PASS  tables_have_rows   24 publications, 6 events, 8 staff
  FAIL  last_sync_ok       Run #2 failed at 2026-11-20 01:03 UTC: publications pub-0026: published_on '2026-11-31' is not a real calendar date
  FAIL  sync_fresh         Last good sync finished 30 hours ago (2026-11-19 01:02 UTC). The limit is 26 hours.
  PASS  sync_complete      The last good sync left nothing out
  PASS  mcp_answers        Lists 5 tools; test question pub-0001 returns 'Annual Report 2025'
  FAIL  mcp_serves_latest  The export has 'Incident reporting for AI systems: a starter template' (pub-0025, published 2026-11-19) but the MCP server does not serve it. Staff asking Claude will not find it.

3 of 7 checks FAILED. Alert written to alerts/latest.md. Start with docs/RUNBOOK.md.
```

What happened: someone typed 31 November as a publication date. The sync refuses the whole batch when one record is invalid, so nothing new was loaded and the knowledge base went stale. The server is healthy and is answering from old data.

There are three ways to make the alert go away. Only one is right.

| Fix | Verdict |
|---|---|
| Correct the date in the export | No. Nobody on call knows the right date, the workspace is the system of record, and tonight's export would overwrite the edit. |
| Loosen the date validation | No. The rule is right and the record is wrong. |
| Run the sync with that one record left out, after a clean dry run, then tell the owner what to fix | Yes. It is the lever the runbook gives the person on call. |

```bash
npm run sync -- --dry-run
#   INVALID publications pub-0026: published_on '2026-11-31' is not a real calendar date
#   dry run found 1 invalid record. A real run would stop here and load nothing. Nothing was written.

npm run sync -- --dry-run --skip pub-0026
#   dry run OK: 39 records valid, 1 left out (pub-0026). A real run would add 1, change 0 and leave 38 as they are. Nothing was written.

npm run sync -- --skip pub-0026
#   OK 39 records written (1 new, 0 changed, 38 unchanged), 1 left out (pub-0026). Run #3.

npm run checks
#   All 7 checks passed, 1 with a warning.   (sync_complete: pub-0026 stays out until fixed at the source)
```

The finished incident note, with the message to the owner, is in [docs/EXAMPLE-INCIDENT.md](docs/EXAMPLE-INCIDENT.md).

## The rule for acting

The runbook sorts every possible action into three columns. The full table and one section per check are in [docs/RUNBOOK.md](docs/RUNBOOK.md).

| Fix it and log it | Diagnose, then message the owner first | Never without the owner |
|---|---|---|
| Re-run a sync that failed for a passing reason. Leave out one to three bad records after a clean dry run. Restart the server. | Anything else that changes data or the schema. A failure you cannot explain. The same problem a second time. Anything staff have already reported. | Deleting data. Editing anything upstream. Changing rules so that an alert passes. Credentials and access. Deploying code. |

The same rules are written for Claude Code in [CLAUDE.md](CLAUDE.md), so they hold whoever is typing. Two of them are also set as hard rules for Claude Code in `.claude/settings.json`: it may not edit anything under `source/`, and it has to ask before every sync that writes.

## The MCP tools

All five only read.

| Tool | What it answers |
|---|---|
| `kb_search_publications` | Publications by words in the title, summary, topic or author. Paginated, newest first. |
| `kb_get_publication` | One publication by id, with its author. |
| `kb_list_events` | Events on or after a date. |
| `kb_find_staff` | Staff by part of a name, role or team. |
| `kb_sync_status` | How fresh the data is: last run, last good run, hours since, row counts. |

Built on version 2 of the MCP TypeScript SDK. Stdio by default; Streamable HTTP with `TRANSPORT=http`.

## Choices worth a second look

- **The sync is all or nothing.** A half-loaded knowledge base gives answers that are wrong in ways nobody can see. A stale one is at least consistent, and the checks say it is stale.
- **The sync never deletes and never edits the export.** The worst a bad run can do is nothing.
- **A dry run is a preview, not only a validation.** It reads the database and says how many records a real run would add and change, so a surprise shows up before the write.
- **`--skip` is narrow on purpose.** At most three ids per run, each of which must exist in the export. Skipped ids are stored on the run, and the checks keep warning until a run goes through with nothing left out.
- **Answers carry their age.** Search results end with the time of the last good sync, and with a warning once it is older than 26 hours. Someone asking Claude should not need the monitoring to know the data is old.
- **The checks ask the server the way Claude would.** A database check alone would pass while the server is down. `mcp_serves_latest` compares the export with what the server returns, end to end.
- **One definition of a valid record** (`src/records.ts`), shared by the sync and the checks, so they cannot disagree.

## What is not here

- **Authentication.** Over HTTP the server checks Host and Origin headers and refuses to listen on a public address without `ALLOWED_HOSTS`, but it does not verify who is calling. A real deployment needs that in front.
- **A deployment.** [docs/CLOUD-RUN.md](docs/CLOUD-RUN.md) describes how this would map onto Cloud Run and Cloud SQL. I have not done it.
- **Alert delivery.** The alert is a file and an exit code. Sending it to email or chat is the scheduler's job.
- **A real upstream.** A JSON file stands in for the workspace export.
- **Memory of a skip.** A skipped record is skipped for one run. If it is still bad the next night, the sync stops again. That is deliberate here: repeating a skip should be a decision, not a default.

## Layout

```
src/index.ts            MCP server: transport selection
src/tools.ts            the five tools
src/sync.ts             nightly sync
src/checks.ts           monitoring checks
src/runs.ts             lists recent sync runs
src/records.ts          what a valid record is
src/status.ts           how fresh the data is
src/schema.sql          four tables
scripts/                local database, smoke test, demo staging
tests/                  29 tests: record rules, sync, checks
docs/                   runbook, example incident, Cloud Run notes
CLAUDE.md               operating instructions for Claude Code
.claude/settings.json   what Claude Code must ask about and may never edit
```

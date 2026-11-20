# Runbook

For whoever is on call for the knowledge base. Read the rule for acting first. After that there is one section per check, named exactly as `npm run checks` prints it.

## Who and when

- **The owner** built and runs this system and is away. Messages reach them, but do not expect a quick reply.
- **On call** is you. You are covering, not taking over.
- **The sync runs once a night.** The checks run right after it, and again whenever you run them.

## The rule for acting

| Fix it and log it | Diagnose, then message the owner first | Never without the owner |
|---|---|---|
| Re-run a sync that failed for a passing reason: the database was restarting, or the export was not ready yet. | Anything else that changes data or the schema. | Deleting data. |
| Run the sync with one to three bad records left out (`--skip`), once a dry run with those records left out comes back clean. | A failure you cannot explain. | Editing `source/export.json`, or anything else upstream. |
| Restart the MCP server. | The same problem a second time. | Changing the validation rules or the schema so that an alert passes. |
| | More than three bad records in one export. | Changing who can reach the server or the database, or any credential. |
| | A table that is empty, or row counts that dropped. | Deploying new code. |
| | Anything staff have already reported. | |

If a situation is not in this table, treat it as the middle column.

**"Message the owner first" means send the message and wait for the reply.** If waiting would hurt staff, say that in the message. It is still the owner's decision.

Three habits apply to every column:

1. **Look before you touch.** Find the cause in the alert, the logs and the run history before choosing a fix. Looking is always allowed: the checks, `npm run runs` and dry runs never touch the database or the export.
2. **Ask about staff.** Before anything in the first column, ask whether a staff member has already reported the problem. If one has, it moves to the middle column.
3. **Write it down.** After any action, run the checks again, write an incident note, and message the owner the same day: what you saw, what you did, what you left alone and why.

## Commands

| Command | Writes to the database? | Use it to |
|---|---|---|
| `npm run checks` | No. It rewrites its own report, `alerts/latest.md`. | See the state of the system. Exits 1 if any check fails. |
| `npm run runs` | No | List the last sync runs with their errors. |
| `npm run sync -- --dry-run` | No. It leaves a `logs/dryrun-*.log`. | Validate the export as it is now, list every bad record, and preview what a real run would add and change. |
| `npm run sync -- --dry-run --skip <id>` | No | Confirm the export is clean once those records are left out. |
| `npm run sync` | **Yes** | Load the export into the database. All or nothing. |
| `npm run sync -- --skip <id>` | **Yes** | Load everything except the named records. Refuses more than three ids, and ids that are not in the export. |

Logs: one `logs/sync-<start time>.log` per real run, so the newest one is always the last real run. Dry runs log to `logs/dryrun-*.log`. Times are UTC.

---

## database_up

**Means:** the checks could not reach PostgreSQL. Nothing else was checked.

**Look:** the error text in the alert.

**Do:** on this local demo, `npm run db:start`. On a hosted database, do not restart it yourself: message the owner with the exact error and the time. When it is back, run the checks again.

## tables_have_rows

**Means:** a table that should always hold data is empty.

**Do:** stop. Do not run the sync to refill it. An empty table means data was lost or the server points at the wrong database, and a sync on top would hide the evidence. Message the owner at once with the output of `npm run checks` and `npm run runs`.

## last_sync_ok

**Means:** the most recent sync run failed. The sync is all or nothing, so the database is exactly as the last good run left it.

**Look:** `npm run runs`, then the newest `logs/sync-*.log`. A failed run's log lists every bad record it met. The error says which case this is:

| The log says | Case | What to do |
|---|---|---|
| `The database is not reachable` | Passing | See `database_up`. When it is back, `npm run sync`. |
| `could not read the export file` | Usually passing: the export was late or half written | Wait 15 minutes, `npm run sync -- --dry-run`, and if clean `npm run sync`. If it fails twice, message the owner. |
| `INVALID <table> <id>: <reason>` | A bad record upstream | Follow the steps below. |
| Anything else | Unexplained | Change nothing. Message the owner with the log. |

**A bad record upstream:**

1. `npm run sync -- --dry-run` checks the export as it is now. It ends with "dry run found N invalid records" and exits 1. That is the dry run doing its job, not a fault.
2. More than three bad records, or a reason you do not understand: stop and message the owner. That many means something is wrong at the source.
3. One to three, each with a clear reason: `npm run sync -- --dry-run --skip <ids>`. This one must end with "dry run OK". Read its preview of what would be added and changed. A change you did not expect is a reason to stop.
4. `npm run sync -- --skip <ids>`, then `npm run checks`. Expect every check to pass, with a warning on `sync_complete`.
5. Write the incident note and message the owner: which record, what is wrong with it, and that it stays out of the knowledge base until it is fixed at the source.

Do not correct the record yourself, in the export or in the database. You do not know the right value, the source is the system of record, and the next export would overwrite your edit anyway.

## sync_fresh

**Means:** no sync has succeeded in the last 26 hours, so staff may be getting old answers. The sync runs nightly; 26 hours leaves two hours of slack.

**Look:** `npm run runs`.

- The last run failed: this is the same incident as `last_sync_ok`. Fix that one.
- There was no run last night: the scheduler missed it. `npm run sync -- --dry-run`, and if clean `npm run sync`. Tell the owner the scheduled run did not happen; finding out why is theirs.

## sync_complete (warning)

**Means:** the last good sync was told to leave records out. Everything else is current.

**Do:** nothing to the system. Make sure the owner has the record ids. The warning clears by itself on the first sync that runs with nothing left out, which happens once the records are fixed at the source.

A skip is not remembered. If the record is still bad tomorrow, the nightly sync fails on it again. That is "the same problem a second time": message the owner and wait before repeating the skip.

## mcp_answers

**Means:** the MCP server did not start, is missing a tool, or gave the wrong answer to the test question (`kb_get_publication` for `pub-0001` must return "Annual Report 2025").

**Do:**

- It did not answer at all: read its log and restart it, then run the checks again. A restart is in the first column. (On this local demo there is nothing to restart: each client starts its own copy of the server.)
- It answered wrongly, or a tool is missing: do not restart and hope. Something changed in the code or the data. Message the owner.

## mcp_serves_latest

**Means:** the newest valid publication in the export cannot be fetched through the MCP server. This is the end-to-end check: export, database and server must all agree.

**Do:** if `last_sync_ok` or `sync_fresh` is also failing, this is their consequence; fix the sync and it clears. If the sync checks pass and this one still fails, it is unexplained: message the owner.

---

## The incident note

Copy `incidents/TEMPLATE.md` to `incidents/YYYY-MM-DD-short-name.md` and fill it in. One page is enough. `docs/EXAMPLE-INCIDENT.md` shows the shape of a finished note: take the shape from it, never the facts.

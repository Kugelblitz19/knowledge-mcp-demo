# How this would map onto Cloud Run and Cloud SQL

**I have not deployed this demo.** These are notes on what would change, not a tested guide. The code paths they rely on are tested locally: the server runs over Streamable HTTP, and the checks can test a server by URL.

## Mapping

| Here | On Google Cloud | What changes |
|---|---|---|
| `npm run mcp` (stdio) | Cloud Run service | Run `node dist/index.js` with `TRANSPORT=http`. Cloud Run sets `PORT`. |
| Local PostgreSQL on port 54329 | Cloud SQL for PostgreSQL | `DATABASE_URL` comes from Secret Manager. Apply `src/schema.sql` once. |
| `npm run sync`, run by hand | Cloud Run job, started nightly by Cloud Scheduler | Run `node dist/sync.js`. The job's exit code tells the scheduler whether it failed. |
| `npm run checks`, run by hand | A second Cloud Run job, scheduled after the sync | Run `node dist/checks.js` with `MCP_URL` set to the service URL, so it tests the deployed server and not a local copy. |
| `logs/*.log` | Cloud Logging | Both jobs already print every log line to stdout. |
| `alerts/latest.md` | An alert on job failure | `checks` exits 1 when a check fails. |
| `source/export.json` | Wherever the workspace export lands | Set `SOURCE_FILE`, or replace the reader in `src/records.ts`. |

## Settings the server reads

| Variable | Purpose |
|---|---|
| `TRANSPORT=http` | Serve Streamable HTTP at `/mcp` instead of stdio. |
| `PORT` | Port to listen on. Default 8080. |
| `HOST` | Address to bind. Default `127.0.0.1`. A container needs `0.0.0.0`. |
| `ALLOWED_HOSTS` | Host names the server answers to, comma separated. Required when `HOST` is not localhost: the server refuses to start without it. |
| `DATABASE_URL` | PostgreSQL connection string. |

`GET /healthz` returns 200 only when the database answers.

## Before any of this is real

1. **Authentication.** The server does not verify who is calling. On Cloud Run that means keeping the service private and letting only known callers in, or adding bearer-token checks in the server. The MCP SDK has middleware for the second.
2. **A read-only database user for the server.** The server never writes, so its database user should not be able to. Only the sync job needs write access.
3. **The local file writes.** `sync` and `checks` also write files under `logs/` and `alerts/`. A container's disk is temporary, so those would go: stdout and the `sync_runs` table are the record.
4. **A deploy and a rollback that have each been tried once**, before anyone is on call for it.

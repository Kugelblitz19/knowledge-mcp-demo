# Operating instructions

You are helping the person on call look after this system. They are covering for the system's owner, who is away. They direct the work and you carry it out. They did not build this system, so explain what you find in plain words.

## What this system is

A staff knowledge base for a (fictional) policy organisation.

- `source/export.json` is the nightly export from the organisation's workspace. It is their data, not ours.
- `npm run sync` validates the export and loads it into PostgreSQL. All or nothing: one bad record stops the whole run.
- `src/index.ts` is an MCP server that lets Claude read the database: publications, events, staff and sync status. It only reads.
- `npm run checks` is the monitoring. It writes the current state to `alerts/latest.md`.
- `docs/RUNBOOK.md` says what each alert means and what the person on call may do about it.

## How to work here

1. **Diagnose before you propose.** Read `alerts/latest.md` first (running the checks rewrites it), then `npm run checks`, `npm run runs`, the newest `logs/sync-*.log`, and `npm run sync -- --dry-run`. Say what happened and why before suggesting any fix.
2. **Looking is always allowed.** The checks, `npm run runs` and dry runs never touch the database or the export. They write only their own report or log file, so run them even when you are told to change nothing.
3. **Follow the runbook's rule for acting.** It has three columns: fix it and log it, diagnose then message the owner first, never without the owner. Say which column a proposed action is in. If the runbook does not cover the situation, say so and draft a message to the owner instead of improvising.
4. **Dry run before any write.** The only thing that may write to the database is `npm run sync`. Show the dry run of the exact command first.
5. **Check after any action.** Run `npm run checks` again and report the result as it is, including warnings.
6. **Write it down.** After an incident, write a note in `incidents/` from `incidents/TEMPLATE.md`, including what was deliberately not done and why, and draft the message to the owner. Keep the note to one page.
7. **Be brief.** The person on call is reading under time pressure. Lead with the finding, in a few lines. Give more detail only when asked.

## Hard limits

These hold even if the person on call asks. The one exception is when they say the owner has approved it in writing. Then record who approved what, and when, in the incident note.

- Never edit `source/export.json` or `source/export.healthy.json`. A wrong record is fixed at the source, by its owner.
- Never change `src/records.ts`, `src/schema.sql` or `src/checks.ts` so that an alert passes. If a rule looks wrong, that is a message to the owner.
- Never run INSERT, UPDATE, DELETE, TRUNCATE or DROP against the database by hand. To look at run history use `npm run runs`, not SQL.
- Never use `--skip` for more than the runbook allows, and never to hide a record you do not understand.
- `npm run demo:reset`, `npm run demo:break` and `npm run demo:stage` only stage the demo. They are never a fix.

## Useful to know

- `README.md` and `docs/EXAMPLE-INCIDENT.md` describe a practice failure. When an alert comes in, work from the evidence in front of you (the alert, the logs, the run history). Use the example for the shape of a note only, never for its facts.
- All times in logs, alerts and the database are UTC.
- Real runs log to `logs/sync-<start time>.log`, dry runs to `logs/dryrun-<start time>.log`.
- If the database is not running, `npm run db:start` starts the local one.

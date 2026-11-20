# Incident: nightly sync stopped by one publication with an impossible date

This is the note for the failure that `npm run demo:break` stages. The times are from one run of the demo.

- Date: 20 November 2026 (times in UTC)
- Raised by: `last_sync_ok`, `sync_fresh`, `mcp_serves_latest`
  - `last_sync_ok` FAIL: Run #2 failed at 2026-11-20 01:03 UTC: publications pub-0026: published_on '2026-11-31' is not a real calendar date
  - `sync_fresh` FAIL: Last good sync finished 30 hours ago (2026-11-19 01:02 UTC). The limit is 26 hours.
  - `mcp_serves_latest` FAIL: The export has 'Incident reporting for AI systems: a starter template' (pub-0025, published 2026-11-19) but the MCP server does not serve it.
- Handled by: the person on call, directing Claude Code, which ran the commands
- Runbook column: fix it and log it
- Staff reports: none known
- Status: restored, one item waiting on the owner

## What happened

Last night's sync (run #2, 01:03) failed and loaded nothing. The knowledge base stayed as the previous night's run left it, so by morning it was 30 hours old. A publication added yesterday, pub-0025 "Incident reporting for AI systems: a starter template", could not be found through the MCP server. The server itself was healthy and kept answering from the older data.

## Cause

The export held a second new publication, pub-0026 "Notes from the November evaluation roundtable", with `published_on` set to 2026-11-31. November has 30 days. The sync is all or nothing by design, so one invalid record stopped all 40.

Evidence, from `logs/sync-20261120T010300.log`:

```
INVALID publications pub-0026: published_on '2026-11-31' is not a real calendar date
FAILED 1 invalid record. Nothing was written. Run #2.
```

## What was done

1. `npm run checks`: 3 of 7 failed.
2. Read the alert, `npm run runs` and the log of run #2. Changed nothing.
3. `npm run sync -- --dry-run`: exactly one invalid record, pub-0026.
4. Checked the runbook. One bad record with a clear reason is in the first column, once a dry run without it comes back clean.
5. `npm run sync -- --dry-run --skip pub-0026`: "dry run OK: 39 records valid, 1 left out. A real run would add 1, change 0 and leave 38 as they are."
6. `npm run sync -- --skip pub-0026`: run #3, 39 records written (1 new, 0 changed, 38 unchanged). The only step that wrote to the database.
7. `npm run checks`: all 7 pass. `sync_complete` warns that pub-0026 is left out.

## What was not done, and why

- The date in the export was not corrected. Nobody on call knows the right date, the workspace is the system of record, and tonight's export would overwrite an edit anyway.
- The date validation was not loosened. The rule is right. The record is wrong.
- Nothing was written to the database by hand.

## State now

25 publications are served, including pub-0025. pub-0026 is not in the knowledge base. All 7 checks pass, with one warning.

## Open for the owner

- The date of pub-0026 needs correcting in the workspace. Until then, tonight's sync will stop on it again, because a skip is not remembered.
- If it is still open tomorrow morning, that is the same problem a second time. I will message you and wait before repeating the skip.
- A suggestion, not done: the sync could set a bad record aside by itself and raise a warning, instead of stopping everything. That changes how the system behaves, so it is yours to decide.

## Message to the owner

> Last night's sync failed on one record: pub-0026, "Notes from the November evaluation roundtable", has the date 31 November, which does not exist. Nothing was loaded, so the knowledge base was 30 hours old this morning and yesterday's new publication (pub-0025) was missing. No staff member has reported it.
>
> I re-ran the sync with only pub-0026 left out, after a clean dry run. Everything else is current and all checks pass. I did not change the record, the validation or the database.
>
> Still open: the date of pub-0026 needs fixing in the workspace by whoever owns it. Until then tonight's sync will stop on it again. I will check tomorrow morning, and I will message you before leaving it out a second time.

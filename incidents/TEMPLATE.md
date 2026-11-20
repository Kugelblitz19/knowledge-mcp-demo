# Incident: (one line: what broke)

- Date: (times in UTC)
- Raised by: (which checks failed; paste their lines, because the alert file is rewritten by the next check)
- Handled by: (who was on call; say if Claude Code ran the commands)
- Runbook column: (fix it and log it / message the owner first / never without the owner)
- Staff reports: (none known / who reported what, and when)
- Status: (restored / restored, one item waiting on the owner / waiting on the owner / open)

## What happened

(What staff would have seen, and since when. Two or three sentences.)

## Cause

(The actual cause, with the evidence: log line, run number, record id.)

## What was done

(Every command that mattered, in order, with its result in a few words.)

## What was not done, and why

(The fixes that were possible but were not ours to make.)

## State now

(Result of the last `npm run checks`, including warnings.)

## Open for the owner

(What only the owner can do, and what happens if it waits.)

## Message to the owner

(The message as sent. If it has not gone yet, write "DRAFT, not sent" above it.)

---
description: Transition a tracked task to a new status (active|paused|blocked|done|abandoned|rotting|superseded).
---

## Your task

Move a tracked task to a new status via the `taskwatch` MCP server.

1. Parse `$ARGUMENTS` as `<id> <to> [optional note...]`. The id may be a bare id or a full `task://t/<id>` URI.

2. If either id or status is missing, ask once and stop. Reject statuses not in `active|paused|blocked|done|abandoned|rotting|superseded`.

3. Follow the "Append an update" flow from the taskwatch skill: read the current TaskMeta, build a status-kind update with `payload: { from, to }` and `message` set to the user's note (or `"status → <to>"` if no note), then write the update + updated TaskMeta (with `status: <to>`) in one `b3nd_receive` batch.

4. Confirm in one line.

Arguments: $ARGUMENTS

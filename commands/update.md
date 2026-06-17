---
description: Append a status update to a tracked task.
---

## Your task

Append a status update to a taskwatch task.

1. Parse `$ARGUMENTS`. Expected form: `<id> <message...>`. The id may be a bare id or a full `task://t/<id>` URI. The message is everything after the id.

2. If the message is missing, ask the user for it in one short prompt and stop.

3. Use the `taskwatch` MCP server:
   - Read the current `task://t/<id>` to get the latest `updateCount`, `updateUris`, and other meta fields.
   - Pick the update kind based on the message content: status transition language → `status`, work milestones → `progress`, longer thinking → `note`. Default to `note`.
   - Follow the "Append an update" flow from the taskwatch skill — single `b3nd_receive` batch with (optional) hash-content, the new update URI, and the updated TaskMeta.

4. Confirm the new update URI and the resulting state in one line.

Arguments: $ARGUMENTS

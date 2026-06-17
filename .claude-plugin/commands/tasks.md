---
description: List currently tracked tasks. Optionally filter by status or tag.
---

## Your task

List the tracked taskwatch tasks via the `taskwatch` MCP server.

1. Read `task://t/list` via `b3nd_read`. If the user provided `$ARGUMENTS` of the form `status=<s>`, `tag=<t>`, or `parent=<uri>`, append them as a query string (e.g. `task://t/list?status=active`). Otherwise default to **active** tasks only.

2. Print a concise table — one line per task: `<id>  <status>  <title>  (updated <relative-time>)`. Group rotting/blocked tasks at the top with a small header so the user sees them first.

3. If there are zero tasks, say so plainly. Don't invent any.

Arguments: $ARGUMENTS

---
description: List currently tracked tasks. Optionally filter by status or tag.
---

## Your task

List the tracked taskwatch tasks.

1. Read `{basepath}index/?fn=ls&format=full` via `b3nd_read`. Each row is `[index-uri, title]`.

2. For each task, derive its current status by reading `{basepath}task/{ts}/{slug}/entries/?fn=ls&format=uris` and picking the latest URI matching `*-status-*` (default `active` if none). See the **taskwatch** skill for the fold rules.

3. If `$ARGUMENTS` carries `status=<s>` or `tag=<t>`, filter client-side.

4. Print a concise table — one line per task: `<ts>-<slug>  <status>  <title>  (updated <relative-time>)`. Group rotting / blocked / paused tasks at the top so the user sees what may have rotted first.

5. If there are zero tasks, say so plainly.

Arguments: $ARGUMENTS

---
description: View a single tracked task with its update log and resources.
---

## Your task

Show the full state of one taskwatch task.

1. Resolve the task address from `$ARGUMENTS`. Accept either `{ts}-{slug}`, the bare `{slug}` (look up via the index and disambiguate), or a full task URI.

2. Use the synthetic view locator — one round trip:
   ```
   b3nd_read { urls: ["{basepath}task/{ts}/{slug}?fn=view"] }
   ```
   Returns a `TaskView` with title, description, status, context, tags, entries (sorted), resources. See the **taskwatch** skill for the shape.

3. Render: title + status pill + context, then description, then the entry log in seq order (timestamp + kind + body), then resources. Use the `body` field of each entry directly — it's already plain text.

If the task doesn't exist (no title returned), say so clearly with the URI that was tried. Don't guess.

Arguments: $ARGUMENTS

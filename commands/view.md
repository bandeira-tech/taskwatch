---
description: View a single tracked task with its update log and resources.
---

## Your task

Show the full state of one taskwatch task.

1. Resolve the task id from `$ARGUMENTS`. Accept either a bare id (`abc123def4`) or a full URI (`task://t/abc123def4`).

2. Use the `taskwatch` MCP server (`b3nd_read`) to fetch:
   - `task://t/<id>` — the metadata
   - Then in a second batch: every URI in `meta.updateUris`, every URI in `meta.resourceUris`, and `meta.contentRef` if set.
   - For any `hash://sha256/...` URI in the update bodies (`update.contentRef`), include those in a third batch.

3. Render: title + status + context (worktree/repo/branch/pr/agent), the original description (decoded from the `hash://...` content), then the update log in seq order (timestamp, kind, message, body), then resources.

If the task doesn't exist, say so clearly with the URI that was tried. Don't guess.

Arguments: $ARGUMENTS

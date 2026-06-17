---
description: Append a status update or progress entry to a tracked task.
---

## Your task

Append one entry to a taskwatch task. **Single write — no read first.**

1. Parse `$ARGUMENTS` — expected form `<addr> <message...>`. Address is `{ts}-{slug}` or a bare slug. Resolve as in `/taskwatch:view`.

2. Pick the entry kind from the message shape:
   - status-transition language ("paused", "done", "blocked") → `status-<value>`
   - work milestones ("shipped", "deployed", "implemented") → `progress`
   - longer thinking / context / handoff notes → `note` or `handoff`
   - default → `note`

3. Construct one URI: `{basepath}task/{ts}/{slug}/entries/{ts2}-{kind}` where `{ts2}` is the current UTC `YYYYMMDDhhmmss`. The message is the payload (plain text).

4. Send one `b3nd_receive` with that single message. Confirm the new entry URI back to the user.

Arguments: $ARGUMENTS

---
description: Triage rotting / blocked tasks — surface them and ask what to do.
---

## Your task

Surface rotting and blocked tasks for triage.

1. Read both `task://t/list?status=rotting` and `task://t/list?status=blocked` from the `taskwatch` MCP server.

2. Read each one's full state (meta + last 1–2 updates) so the user has context without having to view each individually.

3. For each, present a short block: title, last update timestamp, last update message, and a one-line recommendation (revive / supersede / abandon / unblock) based on what the update log says.

4. Don't take action yourself. Wait for the user to direct.

If there are none, say so plainly and stop.

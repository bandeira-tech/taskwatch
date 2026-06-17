---
description: Triage rotting / blocked tasks — surface them and ask what to do.
---

## Your task

Surface rotting, blocked, and stale tasks for triage.

1. Read `{basepath}index/?fn=ls&format=full`. For each task, derive its current status (see the **taskwatch** skill for the fold rules). Keep the ones with status `rotting` or `blocked`, plus any `active` task whose last entry is older than 14 days.

2. For each survivor, read its `?fn=view` so you have its title, description, and last few entries.

3. Present each one as a short block: title, current status, last-updated, last-entry message, and a one-line recommendation (revive / supersede / abandon / unblock) drawn from the entry log.

4. Don't act. Wait for the user to direct.

If nothing surfaces, say so plainly.

---
description: Capture what you're working on right now as a taskwatch task.
---

## Your task

Capture the current piece of work as a taskwatch task.

1. **Gather context** from the conversation and environment:
   - Title: a short one-line description of what's being done. If the user provided arguments via `$ARGUMENTS`, treat that as the title.
   - Description: 1–3 sentences of why and what — the kind of thing future-you would want to see when picking this back up. Pull from recent conversation context.
   - Context fields: worktree (current working directory), repo (parse from `git remote get-url origin` if available), branch (`git branch --show-current`), pr (open PR URL if known), agent ("claude").
   - Tags: infer 1–3 from the work shape (e.g. `frontend`, `auth`, `infra`, `bug`, `refactor`).

2. **Write the task** via the `taskwatch` MCP server using `b3nd_receive`. Follow the protocol shape from the taskwatch skill — that is, hash the description and write it at `hash://sha256/{hex}`, then write the TaskMeta at `task://t/{id}` with `contentRef` pointing at the hash URI. Do both in a single `b3nd_receive` batch.

3. **Confirm to the user** with the new task URI and id, plus a one-line summary of what was captured. If the user has the web UI configured (env `TASKWATCH_UI_URL`), include that link.

If you're unsure of any field, ask a single clarifying question before writing. Don't ask multiple — keep the friction low.

Arguments (optional title): $ARGUMENTS

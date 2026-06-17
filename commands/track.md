---
description: Capture what you're working on right now as a taskwatch task.
---

## Your task

Capture the current piece of work as a taskwatch task following the **taskwatch** skill (URI shapes, slug rules, ts format).

1. **Gather context** from the conversation and environment:
   - **Title** — short imperative one-liner. If `$ARGUMENTS` is set, use it as the title.
   - **Description** — 1–3 sentences of why and what. Pull from recent conversation context.
   - **Context fields** (each its own URI): `worktree` (current working dir), `repo` (parse from `git remote get-url origin`), `branch` (`git branch --show-current`), `pr` (open PR URL if known), `agent` ("claude").
   - **Tags** — infer 1–3 from the work shape (`frontend`, `auth`, `infra`, `bug`, `refactor`).

2. **Construct the URIs** from the skill:
   - `{ts}` = current UTC `YYYYMMDDhhmmss`
   - `{slug}` = slugified title
   - Build the batch: title, description (if any), each non-empty context field, each tag (empty payload), and the index URI carrying the title.

3. **Send one `b3nd_receive` batch.** No prior read. No JSON envelope. Each payload is plain text.

4. **Confirm to the user**: the task root URI (`{basepath}task/{ts}/{slug}`) and a one-line summary of what was captured.

If you're unsure of a field, ask one short clarifying question before writing.

Arguments (optional title): $ARGUMENTS

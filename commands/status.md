---
description: Transition a tracked task to a new status.
---

## Your task

Transition a tracked task's status. **One write.**

1. Parse `$ARGUMENTS` — expected form `<addr> <to> [note...]`. The `to` must be one of `active|paused|blocked|done|abandoned|rotting|superseded`. Address is `{ts}-{slug}` or bare slug.

2. Reject any other status value with a one-line error and stop.

3. Construct one URI: `{basepath}task/{ts}/{slug}/entries/{ts2}-status-<to>` where `{ts2}` is now in UTC. Payload is the optional note (or empty).

4. Send one `b3nd_receive`. Confirm the new entry URI.

No read first. The task's derived status updates the next time anyone reads `?fn=view`.

Arguments: $ARGUMENTS

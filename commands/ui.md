---
description: Open the taskwatch web UI in the browser.
allowed-tools: Bash(deno run:*), Bash(open:*), Bash(curl:*)
---

## Your task

Launch the taskwatch web UI and open it in the browser.

1. If env `TASKWATCH_UI_URL` is set, `open` that URL and stop.

2. Otherwise, check if anything is already serving on port 7474:
   - `curl -s http://localhost:7474/config` — if it returns JSON with `protocol: "taskwatch"`, the server is up. Just `open http://localhost:7474/`.

3. If not running, start it in the background:
   ```sh
   deno run -A ${CLAUDE_PLUGIN_ROOT}/src/serve.ts > /tmp/taskwatch-serve.log 2>&1 &
   ```
   Wait one second, then `open http://localhost:7474/`.

4. Print the URL you opened and the basepath the server reported (from `/config`).

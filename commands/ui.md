---
description: Open the taskwatch web UI in the browser.
allowed-tools: Bash(deno run:*), Bash(open:*)
---

## Your task

Launch the taskwatch web UI and open it in the browser.

1. If env `TASKWATCH_UI_URL` is set (e.g. `https://taskwatch.example/`), just `open` that URL.

2. Otherwise, start the local server:
   ```sh
   deno run -A ${CLAUDE_PLUGIN_ROOT}/src/serve.ts &
   ```
   then `open http://localhost:7474`.

3. Print the URL you opened. Don't block; the server runs in the background.

If port 7474 is already in use, assume a server is already running and just `open` the URL — don't try to kill or restart.

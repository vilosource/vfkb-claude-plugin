<!-- vfkb:how-we-track-work -->
## How we track work HERE — vfkb

This repo uses **vfkb** as its knowledge substrate (project `vfkb-claude-plugin`). Knowledge is recorded
**deliberately, through the engine** — never by hand-editing `.vfkb/` (a PreToolUse hook gates that).

- **Session start** injects the resume digest + knowledge bundle automatically (SessionStart hook).
- **Record knowledge** with the `mcp__vfkb__kb_add` tool (or `node .vfkb/bin/bootstrap.mjs cli add …`):
  `decision`, `fact`, `gotcha`, `pattern`, `link` — put a decision's rationale in its text.
  **Capture load-bearing decisions immediately — don't defer.**
- Only `.vfkb/entries.jsonl`, `.vfkb/manifest.json`, and `.vfkb/bin/` are committed;
  `.vfkb/index-meta.json`, `.sessions/`, `.signals/` are derived/gitignored.

Two env vars: **`VFKB_DATA_DIR`** = this repo's brain (`.vfkb`, set by the wiring) · **`VFKB_BUNDLE_DIR`**
= the shared vfkb engine bundles — set it once per machine, e.g. `export VFKB_BUNDLE_DIR=/path/to/vfkb/dist/bundles`.
If it is unset, a session-start banner tells you; run `vfkb doctor` to check.

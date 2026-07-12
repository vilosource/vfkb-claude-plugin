<!-- vfkb:how-we-track-work -->
## How we track work HERE — vfkb

This repo uses **vfkb** (ViloForge KnowledgeBase) via the **vfkb Claude Code plugin**
([vilosource/vfkb-claude-plugin](https://github.com/vilosource/vfkb-claude-plugin)), installed at
project scope through `.claude/settings.json` (`extraKnownMarketplaces` + `enabledPlugins`). The
plugin bundles the engine, the `kb_*` MCP tools, and the hooks (session-start resume injection,
brain-write gating, end-of-turn decision reminder, session-end brain auto-commit) — no env vars,
no `.mcp.json` entry, no bootstrap script.

- Record knowledge deliberately with the `kb_add` MCP tool (`decision`/`fact`/`gotcha`/`pattern`/`link`);
  put a decision's rationale in `why`. **Capture load-bearing decisions immediately — don't defer.**
- Only `.vfkb/entries.jsonl` (+ `manifest.json`) is committed — the brain ships with the repo;
  `.vfkb/.sessions/`, `.signals/`, `index-meta.json` are derived/gitignored.

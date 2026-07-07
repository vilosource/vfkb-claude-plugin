# Migration guide — moving a project from `vfkb init` to the plugin

For a project **already** wired via the old mechanism (`vfkb init`, RFC-010/ADR-0030 — a
hand-written `.mcp.json` + `.claude/settings.json` + a committed `.vfkb/bin/bootstrap.mjs`
resolving the engine from `$VFKB_BUNDLE_DIR`). If the project has no vfkb wiring at all yet, use
[`SETUP_GUIDE.md`](SETUP_GUIDE.md) instead.

**This migration is optional.** `vfkb init` stays fully supported (ADR-0045 keeps it as the
fallback for CI/scripted/non-interactive environments). Migrate when you want the plugin's
simpler, self-contained install — not because the old path is being removed.

## What migrates and what doesn't

| Keep (this is your data) | Remove (this was the old wiring) |
|---|---|
| `.vfkb/entries.jsonl` | `.mcp.json`'s `vfkb` server entry |
| `.vfkb/manifest.json` | `.claude/settings.json`'s vfkb hook entries |
| Any project-specific content in `AGENTS.md`/`CLAUDE.md` | `.vfkb/bin/bootstrap.mjs` |
| | The `<!-- vfkb:how-we-track-work -->`-marked section in `AGENTS.md`/`CLAUDE.md`, if present (it describes the mechanism you're replacing) |

**Never delete `.vfkb/entries.jsonl`.** It's the actual knowledge record — everything else in this
list is disposable scaffolding that either the old `vfkb init` or the new plugin can regenerate.

## Steps

1. **Install the plugin first**, before touching anything else, so there's no gap where neither
   mechanism is active:
   ```
   /plugin marketplace add vilosource/vfkb-claude-plugin
   /plugin install vfkb@vfkb
   ```
   Approve the MCP server + hooks when prompted.

2. **Verify the plugin sees the existing brain** before removing the old wiring — ask "what does
   vfkb know about this project?" and confirm it reflects your actual, existing
   `.vfkb/entries.jsonl` content (not an empty brain — if it looks empty, stop and check
   `VFKB_DATA_DIR` resolution before proceeding).

3. **Remove the old wiring:**
   - In `.mcp.json`: delete the `vfkb` entry under `mcpServers`. If it was the only server, delete
     the whole file.
   - In `.claude/settings.json`: delete the four vfkb hook entries (`SessionStart`, `PreToolUse`,
     `Stop`, `SessionEnd`). If nothing else used hooks, delete the whole file.
   - Delete `.vfkb/bin/bootstrap.mjs` and the now-empty `.vfkb/bin/` directory — the plugin vendors
     its own engine, this is no longer needed.
   - If `AGENTS.md`/`CLAUDE.md` has a `<!-- vfkb:how-we-track-work -->`-marked section describing
     the old mechanism (env vars, bootstrap path, `$VFKB_BUNDLE_DIR`), replace it with a short note
     that this project uses the vfkb Claude Code plugin — no env vars or bootstrap script to
     document anymore.

4. **Verify again** — start a fresh session, confirm the resume digest / a test query still
   reflects your real knowledge, with no wiring files left behind.

5. **Commit** the removals plus the `.gitignore`/doc updates, same branch → PR discipline as any
   other change to the project.

## If something looks wrong

Don't delete `.vfkb/entries.jsonl` while debugging. Re-run `vfkb init` (the old mechanism still
works) to restore the previous wiring as a fallback while you investigate — the data itself is
untouched by any of this, since both mechanisms read and write the identical file format.

## Note on `$VFKB_BUNDLE_DIR`

If this was the last project on the machine still using `vfkb init`, you no longer need
`$VFKB_BUNDLE_DIR` set for it specifically. Leaving it set doesn't hurt (other, non-migrated
projects may still depend on it) — this migration doesn't require touching that env var at all.

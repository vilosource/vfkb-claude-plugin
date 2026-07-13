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

   > ⚠️ **This step is interactive, and it is the one that actually installs the plugin.**
   > Writing `enabledPlugins["vfkb@vfkb"]` into `.claude/settings.json` only *declares* the
   > plugin — it does not install it. The install is recorded in Claude Code's
   > `~/.claude/plugins/installed_plugins.json`, created by `/plugin install` (or
   > `claude plugin install vfkb@vfkb --scope project`) — **not** by editing settings.
   >
   > So a migration performed by an **automated PR or an agent** can land the settings edit
   > yet leave the plugin *declared but not installed*: the session then runs with **no MCP
   > tools, no hooks, no resume digest, and no capture — silently**. If you migrate this way,
   > a human must still run `claude plugin install vfkb@vfkb --scope project` in the repo (or
   > `/plugin install vfkb@vfkb` interactively) before the migration is real. Verify it landed
   > in Step 4 below.

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

4. **Verify the plugin actually loaded** — do not assume the settings edit is enough (see the
   Step 1 warning). Start a fresh session and confirm **both**:
   - the vfkb **resume digest** appears at session start (proves the `SessionStart` hook ran), and
   - a `kb_*` MCP tool is available / a test query reflects your real `.vfkb/entries.jsonl` knowledge.

   If you have the `vfkb` CLI, `vfkb doctor` is the authoritative check: its `plugin` line must read
   `vfkb@vfkb installed, version …` — **not** the WARN
   `enabled in settings but not found in the local plugin registry`. That WARN (or an absent resume
   digest) is the *declared-but-not-installed* state from Step 1 — fix it with
   `claude plugin install vfkb@vfkb --scope project`, then re-verify. Only then remove no more wiring
   and continue.

5. **Commit** the removals plus the `.gitignore`/doc updates, same branch → PR discipline as any
   other change to the project.

## Strongly recommended: add the INACTIVE guard (ADR-0059)

This is the **automated backstop** for the Step 1 / Step 4 failure mode above: the plugin cannot warn
you when it is *not* running — an uninstalled or unapproved plugin means a session silently runs
without vfkb (no resume digest, no brain-write gate, no capture, no banner). The manual `vfkb doctor`
check only catches it if someone runs it; this guard catches it on **every** session start. Add it as
part of the migration, not as an afterthought:

1. Copy [`templates/vfkb-guard.mjs`](templates/vfkb-guard.mjs) (from this plugin repo) into your
   project at `.claude/vfkb-guard.mjs` and commit it. It is Node-stdlib-only and **fails open** —
   any error exits silently, it can never block a session.
2. Add a `SessionStart` hook to the same `.claude/settings.json` that declares the plugin:
   ```json
   "hooks": {
     "SessionStart": [
       { "hooks": [ { "type": "command", "command": "node ${CLAUDE_PROJECT_DIR:-.}/.claude/vfkb-guard.mjs" } ] }
     ]
   }
   ```
   This hook lives in the **project** settings, not the plugin's `hooks.json`, precisely so it runs
   even when the plugin doesn't. It compares your `enabledPlugins` declaration against Claude Code's
   `installed_plugins.json` and prints `vfkb INACTIVE` with the fix when the plugin is declared but
   not installed for this session. (Known limitation: it can't yet see the installed-but-*unapproved*
   state — it covers uninstalled / never-fulfilled / wrong-project.)

## If something looks wrong

Don't delete `.vfkb/entries.jsonl` while debugging. Re-run `vfkb init` (the old mechanism still
works) to restore the previous wiring as a fallback while you investigate — the data itself is
untouched by any of this, since both mechanisms read and write the identical file format.

## Note on `$VFKB_BUNDLE_DIR`

If this was the last project on the machine still using `vfkb init`, you no longer need
`$VFKB_BUNDLE_DIR` set for it specifically. Leaving it set doesn't hurt (other, non-migrated
projects may still depend on it) — this migration doesn't require touching that env var at all.

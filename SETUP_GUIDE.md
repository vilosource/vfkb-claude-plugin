# Setup guide — installing vfkb as a Claude Code plugin

This is the **primary, recommended** way to wire vfkb into a project for Claude Code (ADR-0045 in
[vilosource/vfkb](https://github.com/vilosource/vfkb)). If you're moving a project that was set up
the *old* way (`vfkb init`, a hand-copied `.mcp.json`/`.claude/settings.json`), see
[`MIGRATION_GUIDE.md`](MIGRATION_GUIDE.md) instead — this guide is for a project with no vfkb
wiring at all yet.

## Prerequisites

- Claude Code CLI (a recent version — this plugin was built and verified against v2.1.202;
  plugin-bundled hooks/MCP servers correctly resolving `${CLAUDE_PROJECT_DIR}` requires a version
  at or after the fix for [anthropics/claude-code#9447](https://github.com/anthropics/claude-code/issues/9447),
  reported fixed as of v2.0.45).
- Node.js on `PATH` — the plugin's bundled engine (`dist/bundles/*.mjs`) runs under Node.

Nothing else. No `npm install` of vfkb itself, no `$VFKB_BUNDLE_DIR` to set, no manual JSON editing.

## Install

Inside the project you want to wire up:

```
/plugin marketplace add vilosource/vfkb-claude-plugin
/plugin install vfkb@vfkb
```

Claude Code will prompt you to approve the bundled MCP server and hooks the first time — approve
them once, same as any other plugin.

That's it. No `.mcp.json` or `.claude/settings.json` to hand-edit — the plugin installs both.

## Confirm it's working

Start a session in the project and ask something like *"what does vfkb know about this project?"*
— the bundled `vfkb` skill (and the MCP tools, for autonomous agent use) should respond, even if
the answer is just "nothing recorded yet" for a brand-new project.

The first time anything gets recorded, you'll see `.vfkb/entries.jsonl` appear in the project root.

## What to commit

Only `.vfkb/entries.jsonl` is meant to be committed — it's the durable knowledge record (same
convention as [ADR-0019](https://github.com/vilosource/vfkb/blob/main/docs/adr/ADR-0019-self-hosted-design-brain.md)
in vfkb's own repo). Add this to the project's `.gitignore`:

```
.vfkb/index-meta.json
.vfkb/.sessions/
.vfkb/.signals/
```

Everything else under `.vfkb/` is derived or session-local — safe to regenerate, not meant to be
shared across clones.

## How this differs from the old `vfkb init` flow

| | Plugin (this guide) | `vfkb init` (RFC-010/ADR-0030, still supported) |
|---|---|---|
| Setup | `/plugin install vfkb@vfkb`, once | `npm install`, `vfkb init`, manual `$VFKB_BUNDLE_DIR` |
| Engine location | Vendored inside the plugin, no env var | Resolved from `$VFKB_BUNDLE_DIR` at runtime |
| `.mcp.json` / `.claude/settings.json` | Written by the plugin install, not present in your repo | Hand-written into your repo by `vfkb init` |
| Best for | Interactive Claude Code CLI use | CI, scripted/non-interactive environments, or any harness with no plugin concept |

Both write to the same `.vfkb/entries.jsonl` format — there's no lock-in either way.

## Recommended: the INACTIVE guard (ADR-0059)

Because the plugin can't warn you when it isn't running, an uninstalled or unapproved plugin means
a session silently runs without vfkb. To get a `vfkb INACTIVE` banner in that case, copy
[`templates/vfkb-guard.mjs`](templates/vfkb-guard.mjs) into your repo at `.claude/vfkb-guard.mjs`
and wire it as a `SessionStart` hook in the same `.claude/settings.json` that enables the plugin:

```json
"hooks": {
  "SessionStart": [
    { "hooks": [ { "type": "command", "command": "node ${CLAUDE_PROJECT_DIR:-.}/.claude/vfkb-guard.mjs" } ] }
  ]
}
```

It's Node-stdlib-only and fails open (any error exits silently, never blocks a session). See the
[Migration Guide](MIGRATION_GUIDE.md#recommended-add-the-inactive-guard-adr-0059) for the full
rationale and its known limitation.

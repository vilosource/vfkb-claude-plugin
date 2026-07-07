# vfkb-claude-plugin

The Claude Code plugin for **vfkb (ViloForge KnowledgeBase)** — the primary distribution path for
vfkb's Claude Code harness face, per [ADR-0045](https://github.com/vilosource/vfkb/blob/main/docs/adr/ADR-0045-vfkb-claude-code-plugin.md)
(accepts [RFC-021](https://github.com/vilosource/vfkb/blob/main/docs/rfc/RFC-021-vfkb-claude-code-plugin.md)
in [vilosource/vfkb](https://github.com/vilosource/vfkb)).

## Why this is a separate repo

vfkb's own dev repo has a `src/`, `test/`, `scenarios/`, and its own internal `.vfkb/` design
brain — none of which should ship to a plugin consumer. RFC-021's Phase 0 research found that a
same-repo, subdirectory-scoped plugin `source` is **not** sufficient to prevent that: a real
GitHub-sourced `claude plugin marketplace add` performs a full, unscoped `git clone` before any
plugin-level scoping applies. This repo exists to make that structurally impossible rather than
dependent on every consumer remembering a `--sparse` flag — it contains **only** what the plugin
needs, deliberately kept separate from vfkb's dev repo.

## Status

Scaffolding only — the plugin manifest, skill, hooks, and bundled MCP server declaration
(ADR-0045's Phase 1) have not been built yet. See ADR-0045 for the full plan.

## Relationship to vfkb

This repo tracks its own development using **vfkb** (dogfooding, same pattern as
[okf-skill](https://github.com/vilosource/okf-skill)) — see `AGENTS.md` for how work here is
recorded. The actual vfkb engine this plugin will bundle lives in
[vilosource/vfkb](https://github.com/vilosource/vfkb); this repo only ever vendors its **built**,
harness-agnostic bundles (`dist/bundles/vfkb.mjs`, `vfkb-mcp.mjs`) — never its source.

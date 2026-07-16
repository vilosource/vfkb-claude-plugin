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

## Install

See [`SETUP_GUIDE.md`](SETUP_GUIDE.md) for a new project, or
[`MIGRATION_GUIDE.md`](MIGRATION_GUIDE.md) if the project already uses the old `vfkb init`
mechanism.

> [!NOTE]
> **Delivery is proven.** A sandboxed, agent-driven L4 ([`scenarios/install-path.mjs`](scenarios/install-path.mjs),
> DEMONSTRATED 2026-07-16 — fresh 3/3, upgrade 3/3, contrast 0/3) installs the current release **and
> upgrades from an older release** through the real github marketplace path (`marketplace add` /
> `install` / `update` — **not** `--plugin-dir`) and observes a working `/vfkb:brief`; its can-fail
> contrast arm, with the capability stripped, sees `Unknown command: /vfkb:brief`.
>
> This closes the gap [ADR-0051](https://github.com/vilosource/vfkb/blob/main/docs/adr/ADR-0051-delivery-honesty.md)
> named. The status is not prose: [`scenarios/release-gate.mjs`](scenarios/release-gate.mjs) DERIVES it
> from [`scenarios/records/install-path.json`](scenarios/records/install-path.json) and reverts it to
> "unproven" automatically if a release ships without re-pinning that record to the new version.
>
> Machine-readable status: [`DELIVERY-STATUS.json`](DELIVERY-STATUS.json).

## Status

Phase 1 (ADR-0045) is built and verified: the plugin manifest, a human-facing skill, hooks, and a
bundled MCP server declaration, all resolving vendored copies of vfkb's engine bundles. Verified
via a contrast-based, multi-trial scenario (`scenarios/plugin-parity.md`) and dogfooded read-only
against a real consumer (`okf-skill`) — see that scenario file and ADR-0045 for the full record.
Being dogfooded internally next, starting with `vilosource/vfkb` itself.

v0.4.0 adds session-start continuity end-to-end (vfkb ADR-0049): the vendored engine **pins the
newest handoff/next-tagged entry** (`## Last handoff`) at the top of the injected session-start
context — deterministic, no model — and ships **`/vfkb:brief`**, an opt-in enriched briefing
(handoff → git delta → GitHub queue → discrepancies) that runs entirely on a **Haiku-pinned**
agent (`agents/briefer.md`) so invoking it stays cheap on any billing model. Both arms verified
live via `--plugin-dir` sandboxes: wired brief named the seeded next-step exactly; a
handoff-less contrast reported UNKNOWN rather than inventing one.

## Relationship to vfkb

This repo tracks its own development using **vfkb** (dogfooding, same pattern as
[okf-skill](https://github.com/vilosource/okf-skill)) — see `AGENTS.md` for how work here is
recorded. The actual vfkb engine this plugin will bundle lives in
[vilosource/vfkb](https://github.com/vilosource/vfkb); this repo only ever vendors its **built**,
harness-agnostic bundles (`dist/bundles/vfkb.mjs`, `vfkb-mcp.mjs`) — never its source.

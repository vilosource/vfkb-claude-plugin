# CLAUDE.md — vfkb-claude-plugin

Orientation for an agent working in **this** repo. Read it fully at session start. For *how to record
knowledge* (the vfkb tracking mechanics), see [`AGENTS.md`](AGENTS.md); this file is about the repo
itself.

## What this repo is

**`vfkb-claude-plugin`** is the **Claude Code plugin that packages and delivers vfkb** (ADR-0045) — the
distribution vehicle, not the engine. It bundles, from the vfkb engine:

- the **vendored engine bundles** (`plugin/dist/bundles/vfkb.mjs` + `vfkb-mcp.mjs`),
- the **`kb_*` MCP server** (9 tools, namespaced `mcp__plugin_vfkb_vfkb__kb_*` when loaded),
- the **hooks** (SessionStart resume-injection, PreToolUse brain-write gate, Stop decision-reminder,
  SessionEnd brain auto-commit),
- the human-facing **skills** (`plugin/skills/`, e.g. `/vfkb:brief`) + **agents** (`plugin/agents/`),
- the **`vfkb-guard.mjs` template** (`templates/`) consumers commit for the ADR-0059 INACTIVE signal.

A consumer repo wires this plugin via two committed `.claude/` files + a one-time
`claude plugin install`. This repo **dogfoods its own plugin** (it is itself plugin-wired — see
`AGENTS.md`).

## ⚠️ ADRs, RFCs, and design live in the **vfkb** repo — not here

This repo has **no `docs/adr/` or `docs/rfc/`**. All architectural decisions and proposals are authored
in **`vilosource/vfkb`** (`~/VFKB/vfkb/docs/adr/`, `docs/rfc/`). When a decision here is
standard-setting, **write the ADR in the vfkb repo** and reference it from code/docs here (as
`RELEASING.md` and `DELIVERY-STATUS.json` already do). The ADRs that most govern this repo:

- **ADR-0045** — this plugin exists / the plugin migration.
- **ADR-0051** — delivery is an unproven capability; the honesty disclosure is mechanically enforced.
- **ADR-0059** — the INACTIVE guard (the `templates/vfkb-guard.mjs` this repo ships).
- **ADR-0060** — every release is tagged `vfkb--v{version}` (release tagging policy).
- **ADR-0022 / ADR-0029** — the L4 proof discipline (DEMONSTRATED ≥2/3, observed-not-asserted,
  can-fail arm) that the `scenarios/` records must satisfy.

The vfkb repo also holds the cross-repo plan for in-flight work, e.g.
`~/VFKB/vfkb/docs/install-path-L4-PLAN.md`.

## Relationship to the vfkb engine

The engine is **vendored** here as built bundles; this repo does not contain engine source. A release
is typically a **re-vendor**: rebuild bundles in the vfkb repo, copy into `plugin/dist/bundles/`, note
the vfkb sha. **Dev-loop implication:** editing behavior of the engine means changing it in vfkb and
re-vendoring — you cannot fix engine logic by editing files here.

## How releases work (see `RELEASING.md`)

Releases are **hand-cut** (no release-please here — that's the vfkb *engine/npm* repo). The flow:
bump `plugin/.claude-plugin/plugin.json` `version` → **re-pin the version-bound L4 records** (metered,
one at a time) → deterministic gates green → PR → merge → **tag** with `claude plugin tag plugin --push`
(creates `vfkb--v{version}`, ADR-0060). **Bump-and-tag is one atomic step** — a version that ships
without its `vfkb--v{version}` tag is a release defect (it leaves "the previous release" unresolvable
and lets features drift onto a shipped version, as happened to `0.5.0`). All versions `v0.1.0`–`v0.5.0`
are tagged.

- **The release-gate CI Brake** (`scenarios/release-gate.mjs`, run by `release-gate.yml`) is
  deterministic and must be green: it fails any PR whose committed records don't match the tree, and
  enforces the delivery disclosure. The **live L4 scenarios are NOT run in CI** (they need the
  operator's Claude-Code OAuth) — their committed, version-bound records are what CI verifies.

## Delivery honesty is mandatory (ADR-0051)

`DELIVERY-STATUS.json` is `delivery: "unproven"` and the README carries the disclosure string **until
`scenarios/records/install-path.json` lands** (a DEMONSTRATED, version-bound delivery proof). The gate
**derives** the status from that record — do **not** hand-flip `DELIVERY-STATUS.json` or drop the
disclosure. Until then, every release note / handoff must keep stating delivery is unproven.

## The L4 scenarios (`scenarios/`)

`brief-skill.mjs`, `hooks-smoke.mjs`, `inactive-signal.mjs` (and the pending `install-path.mjs`) are
**live, metered** proofs — real `claude -p` in a sandboxed HOME, `claudeAiOauth` only (ADR-0022 §8),
run **one at a time**. Records land in `scenarios/records/*.json`, **version-bound** to the shipping
`pluginVersion`; the gate rejects a record bound to any other version. `verdict()` (in
`release-gate.mjs`) is the single source of DEMONSTRATED (≥2/3 positive, ≤1/3 contrast).

## How we track work HERE

This repo is a vfkb consumer (dogfooding). Record decisions/facts/gotchas/patterns **deliberately**
via the `kb_*` MCP tools (the brain `.vfkb/entries.jsonl` is committed). Capture load-bearing
decisions immediately — don't defer. If the plugin is not loaded in a session (the guard banners
`vfkb INACTIVE`), run `claude plugin install vfkb@vfkb --scope project` and restart; as a CLI fallback
for manual brain edits use `VFKB_DATA_DIR=.vfkb node ~/VFKB/vfkb/dist/cli.js <cmd>`.

## Commit rules

- **No AI attribution** in any commit (no `Co-Authored-By: Claude`, no 🤖, no "Generated with").
- **Always branch → PR**, never push to `main` directly. Report clickable PR + file URLs after a push.
- **Tags are the exception** — `claude plugin tag … --push` pushes a tag directly (that's the release
  mechanism, ADR-0060), not a branch.
- **VERIFIED = observed, not asserted** — never relay a gate's/scenario's "passed" without reading
  ground truth.

## Layout

- `plugin/` — the plugin: `.claude-plugin/plugin.json` (name/version/marketplace identity),
  `skills/`, `agents/`, hooks, `dist/bundles/` (vendored engine).
- `.claude-plugin/marketplace.json` — the marketplace manifest (`plugins[0].source = ./plugin`).
- `scenarios/` — the L4 proofs + `release-gate.mjs` (+ `.selftest.mjs`) + `records/`.
- `templates/vfkb-guard.mjs` — the ADR-0059 guard consumers commit.
- `RELEASING.md`, `DELIVERY-STATUS.json`, `MIGRATION_GUIDE.md`, `SETUP_GUIDE.md`, `README.md`.

## Current in-flight work (2026-07-16)

- **`install-path` delivery L4** (earns the ADR-0051 `delivery: proven` flip): **Phase 0 DONE** —
  tagging adopted (ADR-0060), all versions tagged, a tag verified to resolve as a github marketplace
  ref. **Phase 1 in progress** — writing `scenarios/install-path.mjs` (fresh / upgrade / contrast arms;
  upgrade pair is `v0.3.0` no-brief → `v0.4.0` brief-present), RED-verified, no metered cost, then a
  hard stop before the Phase 2 metered run. Plan: `~/VFKB/vfkb/docs/install-path-L4-PLAN.md`.
- **Possible concurrent agent** on **automated plugin versioning** (would own `RELEASING.md`,
  `.github/workflows/`, release config, and a new ADR in vfkb). If you are that agent, **stay off**
  `scenarios/install-path.mjs`, `scenarios/records/install-path.json`, the delivery Brake in
  `scenarios/release-gate.mjs`, and the vfkb plan doc — and **preserve the `vfkb--v{version}` tag
  format** (ADR-0060).

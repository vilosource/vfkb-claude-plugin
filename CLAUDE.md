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
one at a time) → deterministic gates green → PR → merge. **Bump-and-tag is one atomic step**
(ADR-0060), and the tag half is now **automated**: `release-tag.yml` re-runs the deterministic gates
on every `main` push and creates the annotated `vfkb--v{version}` tag at that commit if the version
is untagged (manual `claude plugin tag plugin --push` is only the fallback if that workflow is red —
verify the tag actually landed either way). A version that ships without its tag is a release defect
(it leaves "the previous release" unresolvable and lets features drift onto a shipped version, as
happened to `0.5.0` — the version Brake and the auto-tag exist because both hand-run halves were
once skipped).

- **The release-gate CI Brake** (`scenarios/release-gate.mjs`, run by `release-gate.yml`) is
  deterministic and must be green: it fails any PR whose committed records don't match the tree, and
  enforces the delivery disclosure. The **live L4 scenarios are NOT run in CI** (they need the
  operator's Claude-Code OAuth) — their committed, version-bound records are what CI verifies.
- **Release PRs need no approval hold** (operator ruling 2026-07-18; vfkb brain decision
  `872c1ff0ff90` — same rule as vfkb CLAUDE.md, adapted to this repo's chain). A release PR here
  (re-vendor + version bump) rides the standing autonomous-PR grant: the engine changes it vendors
  were already reviewed in the vfkb repo before landing on its `main`, and this repo's packaging /
  evidence / version surface is enforced by the deterministic Brakes above — so do **not** hold the
  PR for the operator and do **not** re-review the vendored engine content. Chain: PR → required
  checks green → merge → `release-tag.yml` auto-tags `vfkb--v{version}` (**verify the tag landed on
  origin**) → consumers pick it up via `claude plugin marketplace update` + `claude plugin update`
  (broadcast when the release warrants it). What remains is **cadence** ("is this batch complete?")
  plus the unchanged DoD gate: a release carrying a new user-facing capability still needs its
  version-bound L4 records re-pinned *before* the bump — that's release content, not merge approval.
  Report merges with the outward-publish callout: **merging to `main` IS distribution** — the
  marketplace clone every consumer tracks is this repo.

## Delivery honesty is mandatory (ADR-0051)

`DELIVERY-STATUS.json` is **`delivery: "proven"` since 2026-07-16**: `scenarios/records/install-path.json`
is a DEMONSTRATED, version-bound delivery proof (fresh 3/3, upgrade 3/3, contrast 0/3, through the real
marketplace path — not `--plugin-dir`). The gate **derives** the status from that record and flips it
back to `unproven` (re-requiring the README disclosure) if a
release ships without re-pinning the record to the new `pluginVersion` — so do **not** hand-edit
`DELIVERY-STATUS.json` in either direction; keep the record pinned instead.

## The L4 scenarios (`scenarios/`)

`brief-skill.mjs`, `hooks-smoke.mjs`, `inactive-signal.mjs`, `install-path.mjs` are
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
- **Tags are the exception** — the `vfkb--v{version}` release tag is pushed directly, not via a
  branch (ADR-0060). Normally `release-tag.yml` does it automatically on `main` push; the manual
  `claude plugin tag … --push` is the fallback when that workflow is red.
- **VERIFIED = observed, not asserted** — never relay a gate's/scenario's "passed" without reading
  ground truth.

## Layout

- `plugin/` — the plugin: `.claude-plugin/plugin.json` (name/version/marketplace identity),
  `skills/`, `agents/`, hooks, `dist/bundles/` (vendored engine).
- `.claude-plugin/marketplace.json` — the marketplace manifest (`plugins[0].source = ./plugin`).
- `scenarios/` — the L4 proofs + `release-gate.mjs` (+ `.selftest.mjs`) + `records/`.
- `templates/vfkb-guard.mjs` — the ADR-0059 guard consumers commit.
- `RELEASING.md`, `DELIVERY-STATUS.json`, `MIGRATION_GUIDE.md`, `SETUP_GUIDE.md`, `README.md`.

## Recently completed (kept for orientation; the queue lives in GitHub issues)

- **`install-path` delivery L4 — DONE 2026-07-16** (the ADR-0051 `delivery: proven` flip):
  `scenarios/install-path.mjs` DEMONSTRATED through the real marketplace path (fresh 3/3, upgrade
  3/3, contrast 0/3), record re-pinned per release since (currently bound to `0.10.0`).
- **Automated versioning/tagging — DONE**: `release-tag.yml` + the version Brake (ADR-0060/0061)
  now enforce bump-and-tag mechanically; the `vfkb--v{version}` tag format is a contract
  (ref-pinning + the install-path upgrade arm resolve it) — **preserve it**.

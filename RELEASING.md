# Releasing

Releases are cut by hand — **except the two steps that were being skipped** (ADR-0061). You bump
`plugin/.claude-plugin/plugin.json`'s `version`, re-pin the evidence, and open a PR; CI refuses the
PR if the bump is missing, and **creates the `vfkb--v{version}` tag for you on merge**. You never run
`claude plugin tag` by hand, and you cannot forget it.

**Bump-and-tag is one atomic step (ADR-0060), now enforced (ADR-0061).** Two Brakes make it so:

| Brake | When | Rule |
| --- | --- | --- |
| `scenarios/version-bump.mjs` | every PR | A shipped version is **immutable**: if `plugin/` or `templates/` differs from what `vfkb--v{version}` already shipped, the version is stale → **bump it**. |
| `.github/workflows/release-tag.yml` | merge to `main` | If the version on `main` has no tag, CI creates and pushes `vfkb--v{version}` at that commit. |

Together: a surface change forces a bump, and a bump always gets its tag. That closes the `0.5.0`
defect — `templates/vfkb-guard.mjs` (#16) shipped into an already-released `0.5.0` because both
halves were skippable. (Versions `v0.1.0`–`v0.5.0` were retro-tagged in Phase 0; the invariant holds
**forward** from `0.5.0`, whose retro-tag deliberately blesses that existing drift.)

**What counts as the release surface:** `plugin/` and `templates/` — the bytes a consumer installs or
commits. `scenarios/`, `.github/`, docs and `.vfkb/` are **not** surface: they change no shipped byte,
so they need no bump. (ADR-0060 lists the `hooks-smoke` L4 #15 as drift; observed, it touched only
`scenarios/` + `RELEASING.md`, so it isn't.)

## Evidence under the hybrid model (ADR-0067, RFC-036 accepted 2026-07-25)

The four L4 records can now be produced two ways, and **both count** — the gate's rules
(DEMONSTRATED ≥2/3 recomputed, tree-bound, can-fail arm) are identical for both:

| Leg | How | Credential | What it proves |
| --- | --- | --- | --- |
| **CI (per release)** | dispatch `.github/workflows/l4-evidence.yml` **on the release branch** (`gh workflow run l4-evidence.yml --ref <branch>`); its `vouch` job commits the records to that branch once every verdict recomputes clean | `DEEPSEEK_TOKEN` repo secret — no personal credential | harness wiring (hooks, skills, MCP, marketplace resolution) on `deepseek-v4-pro`; each record says so in its `producedBy` block |
| **Laptop (occasional)** | `node scenarios/release.mjs` as before | your Claude OAuth, which **never leaves this machine** | the production model config real consumers run |

The laptop leg has **no mechanical trigger** — run it at your own cadence (before major releases,
or when CI evidence looks off). If it quietly decays to "never", the fidelity check is gone; this
paragraph exists so that decay is at least visible. A bad/rotated `DEEPSEEK_TOKEN` makes turns
**hang to the timeout** rather than fail fast (observed, plugin#45) — read a first-turn timeout as
an auth problem, not model flake.

Two vouch-commit caveats: the vouch push uses `GITHUB_TOKEN` + `[skip ci]`, so **the vouched head
gets no check runs** — the release PR still needs the usual user-authored empty commit before its
required checks certify the head that actually contains the records. And release-please
force-pushes its release branch on every `main` push (standing gotcha), which would silently wipe
a vouch commit — don't push to `main` mid-release.

## Self-merge (ADR-0068)

A **green release PR merges itself.** The `vouch` job enables GitHub's native auto-merge on the
PR for the dispatched branch, so the merge happens if and only if the required checks
(`release-gate`) pass — branch protection, not a bot's judgment, is what decides. A red PR
visibly does not merge.

- **To stop one:** label the PR `hold` before dispatching (vouch skips it), or
  `gh pr merge <n> --disable-auto` after. Draft PRs are skipped too.
- **`enabled` is not `merged`.** A PR with auto-merge on and a check that never reports looks
  identical to success in a summary. Both paths report the state they actually observed — and note
  that `gh` does **not** enable auto-merge when the PR is already mergeable: it merges on the spot,
  so "merged immediately" is a normal outcome, not an anomaly.
- **A CI self-merge does not tag by itself, and that is handled in two places.** A merge performed
  with the repository's `GITHUB_TOKEN` does not trigger `push:`-triggered workflows, so
  `release-tag.yml` would never run for it. Coverage:
  - *merged while the vouch job was still running* → the job dispatches `release-tag.yml`
    explicitly and **asserts the tag exists on origin**, failing loudly if it does not;
  - *merged later* (the common shape — auto-merge waits for the empty commit below) → nothing is
    left running to notice, so `release-tag.yml` also runs **hourly as a reconciler**. It
    re-verifies every gate and is idempotent, so it tags an untagged release and no-ops otherwise.
    Worst-case tag latency is therefore about an hour, not never.
  - Manual recovery, any time: `gh workflow run release-tag.yml --ref main`.
  - **Status: built, not yet verified** (ADR-0051 clause 2) — no release has yet self-merged and
    been observed tagging end to end. Until one has, watch the tag after a self-merge.
- Scope is release PRs — the vouch job only queues branches matching `release/*`, `re-vendor/*`,
  `repin/*` or `chore/re*vendor*`. **Name your release branch accordingly** (step 1 below); a
  differently-named branch silently falls back to a manual merge. Feature PRs still go through the
  ADR-0052 review gate.

## Release checklist

1. **Re-vendor** (if the engine changed): rebuild bundles in vfkb, copy into
   `plugin/dist/bundles/`, note the vfkb sha in the commit message.
2. **Bump** `plugin/.claude-plugin/plugin.json` `version`.
3. **Re-pin the live L4 records against the new version** (metered, run locally, one at a time —
   the gate rejects a record bound to any other `pluginVersion`):
   - `node scenarios/brief-skill.mjs` — the `/vfkb:brief` purpose proof.
   - `node scenarios/hooks-smoke.mjs` — the shipped-wiring proof (issue #6, relocated ADR-0028
     principle): loads THIS checkout through a real `claude plugin marketplace add` +
     `claude plugin install` in a sandboxed HOME and observes all four hooks + the MCP server
     working (resume injection, brain-write gate, Stop termination, session-end auto-commit,
     kb_add round-trip, tools/list = 9). Contrast arm runs the same sandbox without the plugin.
   - `node scenarios/inactive-signal.mjs` — the INACTIVE-guard proof (issue #4 / ADR-0059):
     a sandbox that declares the plugin + wires `templates/vfkb-guard.mjs` surfaces a
     `vfkb INACTIVE` banner when the plugin is NOT installed (absent arm) and stays silent when
     it IS (present/contrast arm — which also certifies the install path).
   - `node scenarios/install-path.mjs` — the **delivery** proof (ADR-0051 / RFC-024 §4): a real
     agent installs the **ref under test** (run it from the PUSHED release branch — every arm
     resolves `owner/repo@<branch>`, and the record is **tree-bound** to the exact `plugin/` tree,
     issue #22) AND upgrades from the newest pre-`/vfkb:brief` release through the github
     marketplace path, getting a working `/vfkb:brief` (can-fail contrast: capability stripped →
     `Unknown command`). ~12 metered sessions; needs the real `~/.ssh` github key. **Re-pin every
     release** to keep `DELIVERY-STATUS.json` `proven` — skipping it (or changing any `plugin/`
     byte after pinning) reverts the gate to `unproven` (cost is not a reason to skip it).
4. **Deterministic gates green locally** — the same four CI runs, so a red is a local red first:
   ```sh
   node scenarios/release-gate.selftest.mjs && node scenarios/version-bump.selftest.mjs \
     && node scenarios/release-gate.mjs && node scenarios/version-bump.mjs
   ```
   `version-bump.mjs` compares your **working tree** against the release tag, so it answers "does
   this still need a bump?" before you commit.
5. Commit the records with the bump; open the PR. CI re-runs the deterministic gates; the live
   scenarios are **not** run in CI (they need the operator's Claude Code OAuth) — their committed,
   version-bound records are what CI verifies.
6. **Merge. The tag creates itself (ADR-0061).** `release-tag.yml` re-runs the deterministic gates
   on `main` and pushes the annotated `vfkb--v{version}` at the release commit — the same ref
   `claude plugin tag` would have produced. Nothing to run by hand.

   Verify (observed, not assumed): `git ls-remote --tags origin | grep vfkb--v`.

   The tag name is the CC-native `vfkb--v{version}` (not a bare `v{version}`); ref-pinning and the
   `install-path` upgrade arm read that exact name, and `release-tag.yml` asserts the format before
   pushing.

## If the version Brake goes red

It is telling you the truth: **this version already shipped with different contents.** The fix is
always to bump `plugin/.claude-plugin/plugin.json` and re-pin the L4 records (steps 2–3) — not to
move the tag. A published tag is a consumer's pin; moving it silently changes what an install
resolves to. There is no skip label, by design (ADR-0050: a Brake that can be waved through is
prose). If the Brake is ever *wrong*, fix the Brake and add the case to
`scenarios/version-bump.selftest.mjs`.

## Delivery honesty (ADR-0051)

**Delivery is PROVEN (2026-07-16, v0.5.0).** `scenarios/install-path.mjs` DEMONSTRATED it 3/3 — a real
agent installs the current release AND upgrades from `vfkb--v0.3.0` through the github marketplace path
and gets a working `/vfkb:brief`; the committed `scenarios/records/install-path.json` flips
`DELIVERY-STATUS.json` to `proven` (the gate DERIVES it, never a hand-edit). This is what earlier
releases lacked: the `hooks-smoke` check proves the wiring works when installed from **this checkout**
(a directory-source marketplace), not that a consumer's github-sourced, versioned install/upgrade
delivers it — that is the gap `install-path` closes.

**Staying proven is per-release work.** The record is version-bound, so a release that ships without
re-running `install-path.mjs` (step 3 above) reverts the gate to `unproven` and re-requires the README
disclosure — by design (ADR-0051). The `claude plugin tag` prerequisite (ADR-0060) that unblocked this
remains in force: every release is tagged and a tag resolves as a github marketplace ref.

**Dispatch target note (observed 2026-07-25):** `main` is branch-protected (required check
`release-gate`), so a `l4-evidence.yml` dispatch on `main` produces and verifies but its vouch
push is rejected — dispatch on a branch (the release branch) and land the vouched records via PR.

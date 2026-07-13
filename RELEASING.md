# Releasing

Releases are cut by hand: bump `plugin/.claude-plugin/plugin.json`'s `version`, commit
(convention: `re-vendor engine bundles from vfkb <ref> — vX.Y.Z` when the bump is a re-vendor),
and let consumers pick it up via `claude plugin update`. Before any release commit lands, the
evidence has to exist — the CI Brake (`release-gate.yml` → `scenarios/release-gate.mjs`) fails
every PR whose committed records don't match the tree it ships.

## Pre-tag checklist

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
4. **Deterministic gates green locally**: `node scenarios/release-gate.selftest.mjs && node
   scenarios/release-gate.mjs`.
5. Commit the records with the bump; open the PR. CI re-runs the deterministic gates; the live
   scenarios are **not** run in CI (they need the operator's Claude Code OAuth) — their committed,
   version-bound records are what CI verifies.

## Delivery honesty (ADR-0051)

`DELIVERY-STATUS.json` stays `unproven` — and every release note keeps saying **"delivery is
unproven"** — until `scenarios/records/install-path.json` lands (blocked upstream on
`claude plugin tag`). The hooks-smoke check does NOT prove delivery: it proves the wiring works
when installed from this checkout, not that a consumer's install/upgrade path delivers it.

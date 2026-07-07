# L4 scenario: plugin-parity

**Proves:** a plugin-installed vfkb captures knowledge identically to a `vfkb init`-wired vfkb for
a real session, and that neither the plugin nor `vfkb init` alone is a no-op (the capability is
genuinely absent without either) — per ADR-0045's Definition of Done and ADR-0022's
contrast/multi-trial methodology (N=3, ≥2/3 = DEMONSTRATED).

## Method

Three arms, same task, three fresh throwaway project directories per arm (never reused):

- **Arm A (plugin):** no `vfkb init` run. `claude --plugin-dir <this-repo>/plugin -p "<task>"
  --dangerously-skip-permissions`.
- **Arm B (`vfkb init`, baseline):** `node "$VFKB_BUNDLE_DIR/vfkb.mjs" init <name>` run first, then
  `claude -p "<task>" --dangerously-skip-permissions` (no `--plugin-dir`) — the existing,
  already-shipped mechanism (RFC-010/ADR-0030).
- **Arm C (contrast — no wiring at all):** a bare directory, same `claude -p "<task>"
  --dangerously-skip-permissions` call, nothing vfkb-related present.

**Task (identical across arms):** *"We've decided to use PostgreSQL as the database for this
project because of its strong JSON support. Please make sure this is recorded so we don't lose
it."*

**Pass condition:** `.vfkb/entries.jsonl` contains an entry mentioning PostgreSQL. Arms A and B are
expected to pass; Arm C is expected to fail (this is the can-fail check — a contrast arm that also
always passed would mean the test wasn't actually testing anything).

## Result — 2026-07-07, CLI v2.1.202

| Arm | Trial 1 | Trial 2 | Trial 3 | Verdict |
|---|---|---|---|---|
| A — plugin | CAPTURED | CAPTURED | CAPTURED | **3/3 DEMONSTRATED** |
| B — `vfkb init` | CAPTURED | CAPTURED | CAPTURED | **3/3 DEMONSTRATED** |
| C — no wiring | NOT_CAPTURED | NOT_CAPTURED | NOT_CAPTURED | **0/3 — confirms the test can fail** |

All three Arm A captures were genuine `decision`-type entries with a proper `Why:` rationale and
relevant tags (`database`, `postgresql`, `architecture`), structurally identical in shape to Arm
B's captures — not just a keyword match. Example (Arm A, trial 1):

```json
{"id":"d5b9e546db72","type":"decision","text":"Use PostgreSQL as the database for this project.\n\nWhy: Strong JSON support (JSONB, JSON operators/indexing) fits the project's needs.","tags":["database","postgresql","architecture"],"author":{"role":"human"},"provenance":{"status":"verified"},"status":"accepted", …}
```

All 9 throwaway project directories, and any plugin cache/data artifacts created by `--plugin-dir`
session loads, were removed after the run — nothing left registered.

## Not yet covered

- This exercised the MCP/capture path (the highest-value, most novel part of the plugin). It did
  not separately exercise `SessionStart`'s resume-digest *rendering* content, or `Stop`/`SessionEnd`
  behavior beyond "did not error" (already checked once during Phase 1's manual verification, not
  repeated here at N=3).
- Real-consumer dogfooding (the DoD's other open item) is tracked separately, not folded into this
  scenario.

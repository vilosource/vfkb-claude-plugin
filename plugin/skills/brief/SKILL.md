---
name: brief
description: Session-start briefing — what the last session finished, what has moved since, and what's next, from the project's vfkb handoff cross-checked against git and the GitHub queue. Use when the user asks to be briefed, "where did we leave off", "what's next", "catch me up", or at the start of a work session. Opt-in and cheap by design (runs on a Haiku-pinned agent — ADR-0049 Layer 1); the free floor is the pinned "Last handoff" already injected at session start.
context: fork
agent: vfkb:briefer
---

# Session-start brief

Produce the operator's session-start briefing from this project's recorded continuity. Work the
checklist in order; report **UNKNOWN** where a source is silent rather than inventing.

## 1. Guard

Check that `.vfkb/entries.jsonl` exists in the project root. If it doesn't, reply that this
project isn't using vfkb and stop — do not fabricate a brief.

## 2. The handoff (primary source)

Run from the project root:

    VFKB_DATA_DIR="$PWD/.vfkb" node ${CLAUDE_PLUGIN_ROOT}/dist/bundles/vfkb.mjs resume

Read the `## Last handoff` section — the engine pins the newest handoff/next-tagged entry there
(engine ≥ 0.4.0). Note the handoff's **date** and its **named next steps** (codenames, PR/issue
numbers) exactly. If the section is absent (older engine or no handoff recorded), fall back to:

    VFKB_DATA_DIR="$PWD/.vfkb" node ${CLAUDE_PLUGIN_ROOT}/dist/bundles/vfkb.mjs search "handoff next"

and use the newest handoff-looking fact; if none exists, say so and brief from git alone.

## 3. What moved since (cross-check)

    git log --oneline -25

Identify commits **newer than the handoff's date**. Compare their subjects against the handoff's
named next steps: anything already done? Anything landed that the handoff didn't anticipate?
These are your **discrepancy** candidates — flag them; do not editorialize beyond what the
subjects say.

## 4. Open queue (best-effort)

If the `gh` CLI is available and the repo has a GitHub remote:

    gh pr list --state open --limit 10
    gh issue list --state open --limit 10

If `gh` is missing or errors (offline, no auth), skip this step and note "queue state
unavailable" in one line.

## 5. The brief (fixed template)

Reply with exactly these five sections, complete sentences, ≤ ~25 lines total:

- **Last done** — what the handoff says was finished (with its date).
- **Moved since** — commits/merges newer than the handoff, one line each; "nothing" if none.
- **What's next** — the handoff's named next steps, verbatim identifiers, in its stated order.
- **Open queue** — open PRs/issues count + the notable ones, or the one-line skip note.
- **Discrepancies** — next steps already done, or contradictions between handoff and git;
  "none observed" if clean.

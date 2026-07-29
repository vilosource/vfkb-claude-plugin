---
name: handoff
description: End-of-session synthesis — reviews everything done this session (decisions, work, gotchas, open threads) and writes one comprehensive handoff entry so the next /vfkb:brief starts with full context instead of a thin floor. Use when the user asks to "write a handoff", "wrap up", "leave notes for next session", or before ending a session with work worth carrying forward. Complements, does not replace, the automatic Stop-hook nudge (ADR-0034) and SessionEnd fallback (ADR-0033) — this is the deliberate, thorough version invoked on purpose, with the full session's context available to draw on.
---

# Session-end handoff

Write the single best account of this session that a cold-start successor — reading nothing but
this entry — would need to pick up with zero context loss. This runs **in this conversation**, not
a forked subagent: the thing that makes the handoff good (what was actually discussed, decided, and
left open) lives in this session's context, not in any file a fresh agent could re-derive.

## 1. Guard

Check that `.vfkb/entries.jsonl` exists in the project root. If it doesn't, say this project isn't
using vfkb and stop.

## 2. Find the baseline — what's already on record

Run:

    VFKB_DATA_DIR="$PWD/.vfkb" node ${CLAUDE_PLUGIN_ROOT}/dist/bundles/vfkb.mjs resume

to see the previous handoff (its date, its named next steps) and the current knowledge bundle.
Then identify what this session already captured deliberately — `kb_list`/`kb_search` for recent
entries, or `git diff` on `.vfkb/entries.jsonl` since the previous handoff's commit. Don't restate
these in full in the new handoff; reference them by id/type instead of duplicating their content.

## 3. Reconstruct the session from the conversation itself

This is the part no external tool can see — review the conversation directly:

- **What was actually done** — features built, bugs fixed, PRs opened/merged/reviewed, files
  changed, questions answered.
- **Decisions made in discussion but not yet captured.** If the user explicitly stated or confirmed
  a choice and it was never recorded as its own `decision`/`fact` entry, record it now (with `why`)
  as its own entry — don't just fold it into handoff prose, so it stays independently searchable and
  supersedable later. Only record what was actually stated; don't infer a decision the user didn't
  make.
- **Gotchas or surprises** hit along the way that aren't yet on record.
- **Threads left open** — deliberately deferred, blocked, or explicitly "not now."

## 4. Cross-check against git

    git log --oneline -15
    git status -sb
    git log --oneline @{u}..HEAD 2>/dev/null

Confirm the session's work matches what's actually committed. `git status -sb` names the upstream
and how far ahead/behind it the branch is; `git status --porcelain` alone cannot show this, and a
plain `git log` cannot tell a locally-committed change from a pushed one. If there's no upstream
(`@{u}` errors), say so rather than guessing push state. Note anything still uncommitted or
unpushed — the SessionEnd hook only auto-commits `.vfkb/entries.jsonl` (ADR-0033), never code — so
the next session knows the true state of the branch.

## 5. Write the handoff

One entry, `type: fact`, tagged `handoff,next` (not `auto` — that tag is reserved for the
SessionEnd floor, ADR-0033), via `mcp__vfkb__kb_add` (CLI fallback: `VFKB_DATA_DIR="$PWD/.vfkb"
node ${CLAUDE_PLUGIN_ROOT}/dist/bundles/vfkb.mjs add fact "…" --tag handoff,next`). Structure the
text in four short labeled sections so a cold-start reader gets full context, not a summary
sentence:

- **Done** — what this session finished, concrete enough to verify against git.
- **Decisions** — load-bearing choices made, referencing entry ids / ADR numbers where they exist.
- **Next** — named, concrete next steps (codenames, issue/PR numbers), in priority order.
- **Watch for** — gotchas, risks, or context the next session would otherwise waste time
  rediscovering.

If a previous handoff-tagged entry is now stale and superseded by this one, note that explicitly
(don't leave two live "Last handoff" candidates competing).

## 6. Report back

Tell the user the new entry's id and a one-line confirmation of what got written. Remind them this
does not commit or push anything by itself — SessionEnd auto-commit (ADR-0033) or their own `git add
.vfkb && git commit` still has to happen for the handoff to survive `/exit` on a fresh clone.

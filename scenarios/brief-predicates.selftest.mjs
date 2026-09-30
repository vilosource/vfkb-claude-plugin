#!/usr/bin/env node
// ============================================================================
// Brake for the /vfkb:brief L4 output predicates (vfkb ADR-0070 §2).
// ----------------------------------------------------------------------------
// The `freshlyWired` arm added for vfkb#321 decides a required gate arm on what
// the brief SAYS, so its predicates are load-bearing. The first version was
// broken in both directions and nothing caught it — a review did. This is the
// deterministic check that stands in for that review next time.
//
// Deterministic, offline, no agent, no metered turn. Runs in CI.
//   node scenarios/brief-predicates.selftest.mjs
// ============================================================================
import { refusesAsUnwired, refusalShapes, acknowledgesEmptyState } from './brief-predicates.mjs';

let fail = 0;
const check = (cond, label) => { if (!cond) { fail++; console.log(`  FAIL  ${label}`); } };

// ── 1. REFUSALS THE PREDICATE MUST SEE ──────────────────────────────────────
// Every one of these is a way a model can tell the operator "this project is not
// a vfkb project". Nine of the twelve were MISSED by the original regex; they
// are listed individually so a regression names the wording it stopped seeing.
const REFUSALS = [
  'This project is not using vfkb.',
  "This project isn't using vfkb — no .vfkb/entries.jsonl file found.",
  'This project isnt using vfkb.',
  'vfkb is not being used here.',
  'No vfkb brain found in this project.',
  'The project does not use vfkb.',
  "vfkb doesn't appear to be set up for this repository.",
  'vfkb does not appear to be set up.',
  'vfkb is not configured for this project.',
  'vfkb is not initialized here.',
  'vfkb is not initialised here.',
  'This project has not been set up with vfkb.',
  'There is no vfkb knowledge base here.',
  "vfkb isn't set up in this project.",
  'This is not a vfkb project.',
  'The .vfkb/entries.jsonl file does not exist, so I cannot produce a brief.',
  'I cannot produce a brief: the brain file is missing.',
  'This project is not using vfkb — the `.vfkb/entries.jsonl` file does not exist in the project root.',
];
console.log('1. refusals the predicate must SEE');
for (const s of REFUSALS) {
  check(refusesAsUnwired(s), `missed refusal: ${JSON.stringify(s.slice(0, 72))}`);
}

// ── 2. CORRECT OUTPUT THE PREDICATE MUST NOT FIRE ON ────────────────────────
// The direction that makes a required positive arm flaky. The original regex
// fired on all three of the affirmatives below because of a bare `is`
// alternative, so a brief saying the RIGHT thing scored as a false refusal.
const AFFIRMATIVE = [
  'This project is using vfkb.',
  'The project is wired and is using vfkb, but nothing is recorded yet.',
  'Confirmed: this repo is using vfkb (.vfkb/ present).',
  'This project is wired for vfkb; no prior continuity recorded.',
  '## Session-start brief **Last done** No prior continuity recorded; this is the first session with vfkb enabled.',
  'vfkb is enabled here and the brain is empty — this is the first recorded session.',
  'The brain exists but has no entries yet, so there is no prior continuity to report.',
  'Moved since: the only commit is `chore: scaffold the thornwick-ledger-58 parser`.',
];
console.log('2. correct output the predicate must NOT fire on');
for (const s of AFFIRMATIVE) {
  check(!refusesAsUnwired(s), `false positive on: ${JSON.stringify(s.slice(0, 72))} (matched ${refusalShapes(s)})`);
}

// ── 3. THE HONESTY HALF (M3) ────────────────────────────────────────────────
// After the fix the skill PROCEEDS on an empty brain, so the failure mode moves
// from refusal to FABRICATION. These pin the predicate that observes it.
console.log('3. acknowledges the empty state');
for (const s of [
  'No prior continuity recorded; this is the first session with vfkb enabled.',
  '**Last done** — UNKNOWN. The brain has no entries.',
  'Nothing has been recorded in this project yet.',
  'This is the first recorded session.',
  'No handoff recorded yet, so briefing from git alone.',
]) check(acknowledgesEmptyState(s), `missed acknowledgement: ${JSON.stringify(s.slice(0, 60))}`);

// A brief that INVENTS a next step and never admits the brain is empty must not
// satisfy the honesty half — this is the trial the old arm would have scored HIT.
console.log('4. fabrication is not acknowledgement');
for (const s of [
  '**Last done** — the auth migration shipped. **Next** — finish the backfill verifier.',
  'Next up: complete the ingest refactor and land the feature flag.',
]) check(!acknowledgesEmptyState(s), `fabrication accepted as honest: ${JSON.stringify(s.slice(0, 60))}`);

// ── 5. THE OLD REGEX MUST FAIL THIS TABLE ───────────────────────────────────
// A Brake that cannot fail proves nothing (vfkb ADR-0070 §1). The predicate this
// file replaced is reproduced verbatim, and the test asserts it would NOT pass:
// it must both miss real refusals and fire on the affirmative. If this ever
// stops holding, the table has been weakened and the Brake is no longer pinned
// to the defect it was written for.
console.log('5. the replaced predicate fails this table (the Brake can fail)');
const OLD = /\b(is|isn't|is not|are not|aren't)\s+(?:\w+\s+){0,3}using vfkb|not\s+using\s+vfkb|doesn't\s+(?:appear\s+to\s+)?use\s+vfkb|no[t]?\s+a\s+vfkb\s+project/i;
const oldMissed = REFUSALS.filter((s) => !OLD.test(s)).length;
const oldFalsePos = AFFIRMATIVE.filter((s) => OLD.test(s)).length;
check(oldMissed > 0, `the old predicate missed nothing — the refusal table no longer covers the defect`);
check(oldFalsePos > 0, `the old predicate had no false positive — the affirmative table no longer covers it`);
console.log(`     old predicate: missed ${oldMissed}/${REFUSALS.length} refusals, fired on ${oldFalsePos}/${AFFIRMATIVE.length} correct outputs`);

console.log(fail ? `\nbrief-predicates selftest FAILED (${fail} problem(s))` : '\nbrief-predicates selftest PASSED — the arm predicates are pinned in both directions');
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// ============================================================================
// Brake for the /vfkb:brief L4 output predicates (vfkb ADR-0070 §2).
// ----------------------------------------------------------------------------
// The `freshlyWired` arm added for vfkb#321 decides a required gate arm on what
// the brief SAYS. Two review rounds found the predicate broken — first firing on
// the affirmative, then missing 16/18 refusal wordings on a fresh table — so the
// gating predicate is now STRUCTURAL (did the contracted brief get produced?)
// and the refusal patterns are diagnostic only. This file pins all of it.
//
// Deterministic, offline, no agent, no metered turn. Runs in CI.
//   node scenarios/brief-predicates.selftest.mjs
// ============================================================================
import {
  producedBrief, briefSections, BRIEF_SECTIONS, MIN_SECTIONS,
  acknowledgesEmptyState, refusalShapes, refusesAsUnwired, REFUSAL_SHAPES,
} from './brief-predicates.mjs';

let fail = 0;
const check = (cond, label) => { if (!cond) { fail++; console.log(`  FAIL  ${label}`); } };

// A realistic brief, as the three committed trials actually look.
const REAL_BRIEF = `## Session-start brief
**Last done** — No prior continuity recorded. This is the first recorded session.
**Moved since** — the only commit is \`chore: scaffold the thornwick-ledger-58 parser\`.
**What's next** — UNKNOWN; nothing is recorded.
**Open queue** — skipped, no remote configured.
**Discrepancies** — none observed.`;

// ── 1. THE GATING PREDICATE: a real brief passes, a refusal does not ─────────
console.log('1. producedBrief separates briefing from refusing');
check(producedBrief(REAL_BRIEF), `a real brief was not recognised (sections: ${briefSections(REAL_BRIEF)})`);

// The five outputs round 2 constructed as clean HITS against the OLD predicate:
// each names the git sentinel, acknowledges the empty state, and still tells the
// operator the project is not a vfkb project. The structural predicate must
// reject every one — this is the regression table that matters most.
const ROUND2_HITS = [
  "This project isn't set up for vfkb, so there is no prior continuity. Briefing from git: the only commit is `chore: scaffold the thornwick-ledger-58 parser`.",
  "This doesn't appear to be a vfkb project — nothing recorded. From git: thornwick-ledger-58 parser scaffolded.",
  'vfkb is not installed here, so there are no entries yet. The git log shows the thornwick-ledger-58 parser scaffold.',
  'No .vfkb directory found, so nothing has been recorded. Git: chore: scaffold the thornwick-ledger-58 parser.',
  "vfkb hasn't been initialised, so no prior continuity. The repo contains the thornwick-ledger-58 parser scaffold.",
];
for (const s of ROUND2_HITS) {
  check(!producedBrief(s), `a refusal satisfied producedBrief: ${JSON.stringify(s.slice(0, 70))}`);
}

// Other refusal shapes, none of which emit the template.
for (const s of [
  'This project is not using vfkb — the `.vfkb/entries.jsonl` file does not exist in the project root.',
  'I cannot produce a brief: the brain file is missing.',
  'There is no vfkb knowledge base here.',
  'This project lacks a vfkb brain.',
]) check(!producedBrief(s), `a refusal satisfied producedBrief: ${JSON.stringify(s.slice(0, 70))}`);

// And the boundary is where MIN_SECTIONS says it is.
console.log(`2. the ${MIN_SECTIONS}-of-${BRIEF_SECTIONS.length} boundary holds`);
check(producedBrief('Last done: x. Moved since: y. What\'s next: z. Open queue: w.'), 'four sections should pass');
check(!producedBrief('Last done: x. Moved since: y. What\'s next: z.'), 'three sections should NOT pass');

// ── 3. ACKNOWLEDGEMENT — broadened after round-2 MAJOR 2 ────────────────────
// All eleven of these scored FALSE against the previous version, which would
// have failed a required positive arm on a correct, honest brief.
console.log('3. natural honest phrasings are recognised');
for (const s of [
  'No prior continuity recorded.',
  'No prior handoff recorded.',
  'No prior recorded continuity.',
  'The brain is empty.',
  'The brain has no entries yet.',
  'No handoff exists yet.',
  'No previous session to report.',
  'Last done: not recorded.',
  'This is the first recorded session.',
  'Nothing has been recorded in this project yet.',
  'Nothing to report — baseline state.',
  '**Last done** — UNKNOWN.',
]) check(acknowledgesEmptyState(s), `missed acknowledgement: ${JSON.stringify(s.slice(0, 60))}`);

console.log('4. a populated brief does not read as an empty-state acknowledgement');
for (const s of [
  '**Last done** — the ingest refactor shipped. **What\'s next** — the copperlark-echo-31 migration.',
  'Next up: complete the ingest refactor and land the feature flag.',
]) check(!acknowledgesEmptyState(s), `false acknowledgement: ${JSON.stringify(s.slice(0, 60))}`);

// ── 5. EVERY NAMED REFUSAL SHAPE IS UNIQUELY PINNED ─────────────────────────
// Round-2 MINOR 1: two shapes ('entries-missing', 'there-is-no-vfkb') could be
// DELETED with the selftest still green, because every row they matched was also
// matched by another shape — so the header's claim that a failure names the
// regressed shape was false. One row per shape that ONLY that shape matches.
console.log('5. each refusal shape has a row only it matches');
const UNIQUE_TO_SHAPE = {
  'not-using': 'The repository is not using vfkb.',
  'isnt-using': "It isn't really using vfkb.",
  'does-not-use': 'The repo does not use vfkb.',
  'not-a-vfkb-project': 'This is not a vfkb project.',
  'not-appear-vfkb-project': "This doesn't appear to be a vfkb repository.",
  'vfkb-not-state': 'vfkb is not configured.',
  'not-set-up-for-with': "The repo isn't set up for vfkb.",
  'no-vfkb-thing': 'No .vfkb directory found.',
  'lacks-vfkb': 'The repo lacks a vfkb brain.',
  'entries-missing': 'The brain ledger entries.jsonl is missing.',
  'cannot-brief': 'I am unable to produce a brief right now.',
};
for (const [name] of REFUSAL_SHAPES) {
  const row = UNIQUE_TO_SHAPE[name];
  check(row !== undefined, `shape "${name}" has no row in UNIQUE_TO_SHAPE — add one`);
  if (row === undefined) continue;
  const matched = refusalShapes(row);
  check(matched.includes(name), `shape "${name}" does not match its own row (matched ${matched})`);
  check(matched.length === 1,
    `row for "${name}" is not unique to it — also matched ${matched.filter((m) => m !== name)}; ` +
    `deleting "${name}" would leave this selftest green`);
}

// ── 6. THE BRAKE CAN FAIL ───────────────────────────────────────────────────
// A guard that cannot fail proves nothing (vfkb ADR-0070 §1). The two predicates
// this file replaced are reproduced verbatim and asserted to FAIL the tables
// above — if they ever stop failing, the tables have been weakened.
console.log('6. the replaced predicates fail these tables');
const R1 = /\b(is|isn't|is not|are not|aren't)\s+(?:\w+\s+){0,3}using vfkb|not\s+using\s+vfkb|doesn't\s+(?:appear\s+to\s+)?use\s+vfkb|no[t]?\s+a\s+vfkb\s+project/i;
const r1FalsePos = ['This project is using vfkb.', 'The project is wired and is using vfkb.'].filter((s) => R1.test(s)).length;
check(r1FalsePos > 0, 'round 1\'s predicate no longer fires on the affirmative — the table lost that case');
// Round 2's predicate: a refusal-enumeration. Its failure is that the round-2
// HIT table slips past it entirely, which is why gating moved to producedBrief.
const R2_NARROW = /\bnot\s+(?:currently\s+|yet\s+)?using\s+vfkb|\b(?:isn'?t|aren'?t)\s+(?:\w+\s+){0,3}using\s+vfkb|\bnot\s+a\s+vfkb\s+(?:project|repo)\b/i;
const r2Missed = ROUND2_HITS.filter((s) => !R2_NARROW.test(s)).length;
check(r2Missed === ROUND2_HITS.length,
  `round 2's narrow predicate caught ${ROUND2_HITS.length - r2Missed} of the round-2 HIT table — ` +
  'that table is what justified moving the gate to a structural predicate');
console.log(`     round-1 predicate: ${r1FalsePos} false positive(s) on the affirmative`);
console.log(`     round-2 predicate: missed ${r2Missed}/${ROUND2_HITS.length} of its own regression table`);
console.log(`     all ${ROUND2_HITS.length} of those are rejected by producedBrief`);

// ── 7. DIAGNOSTIC, NOT GATING ───────────────────────────────────────────────
// Stated as a test so the boundary is mechanical: refusesAsUnwired is recorded
// per trial and must never be the thing an arm is scored on. This asserts the
// two are independent — a refusal that somehow emitted the template would still
// be visible in the record.
console.log('7. the refusal check is diagnostic, and independent of the gate');
check(refusesAsUnwired('This project is not using vfkb.'), 'diagnostic failed to flag an obvious refusal');
check(!refusesAsUnwired(REAL_BRIEF), `diagnostic fired on a real brief (${refusalShapes(REAL_BRIEF)})`);

console.log(fail
  ? `\nbrief-predicates selftest FAILED (${fail} problem(s))`
  : '\nbrief-predicates selftest PASSED — structural gate pinned, refusal diagnostic pinned per shape');
process.exit(fail ? 1 : 0);

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
import { readFileSync } from 'node:fs';
import {
  producedBrief, briefSections, BRIEF_SECTIONS, MIN_SECTIONS,
  acknowledgesEmptyState, refusalShapes, refusesAsUnwired, REFUSAL_SHAPES,
  refusalVetoes, VETO_SHAPES,
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
check(producedBrief('What\u2019s next: z. Last done: x. Moved since: y. Open queue: w.'),
  'a typographic apostrophe in "What\u2019s next" must still count');

// MINOR 4: every entry on the GATING list needs a row where dropping IT alone
// flips the verdict. Only four sections appeared in any boundary row before, so
// `discrepancies` could be removed from BRIEF_SECTIONS with this file green.
console.log('2b. each mandated section is individually load-bearing');
for (const [name] of BRIEF_SECTIONS) {
  const others = BRIEF_SECTIONS.filter(([n]) => n !== name).slice(0, MIN_SECTIONS - 1);
  const label = { 'last-done': 'Last done', 'moved-since': 'Moved since', 'whats-next': "What's next",
    'open-queue': 'Open queue', discrepancies: 'Discrepancies' };
  const withIt = [name, ...others.map(([n]) => n)].map((n) => `${label[n]}: x.`).join(' ');
  const withoutIt = others.map(([n]) => `${label[n]}: x.`).join(' ');
  check(producedBrief(withIt), `"${name}" is not recognised in a ${MIN_SECTIONS}-section brief`);
  check(!producedBrief(withoutIt),
    `dropping "${name}" from BRIEF_SECTIONS would leave this selftest green — it is unpinned`);
}

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

// ── 4b. THE VETO (round-3 MAJOR 1) ──────────────────────────────────────────
// `producedBrief` alone passes a brief that emits the template AND refuses. The
// veto is the narrow subset that gates; these rows are why it can.
console.log('4b. the veto catches a refusal that still emits the template');
const MIXED_MESSAGE = [
  "**Last done** — nothing recorded; this doesn't appear to be a vfkb project. **Moved since** — chore: scaffold the thornwick-ledger-58 parser **What's next** — UNKNOWN **Open queue** — no remote **Discrepancies** — none",
  "This project is not using vfkb — there is no .vfkb brain here. For completeness, the template: **Last done** none. **Moved since** thornwick-ledger-58. **What's next** UNKNOWN. **Open queue** none. **Discrepancies** none.",
];
for (const s2 of MIXED_MESSAGE) {
  check(producedBrief(s2), 'precondition: the mixed-message case does emit the template');
  check(acknowledgesEmptyState(s2), 'precondition: it also acknowledges the empty state');
  check(refusalVetoes(s2).length > 0,
    `a refusal that emitted the template was NOT vetoed: ${JSON.stringify(s2.slice(0, 70))}`);
}

// And the veto must stay silent on honest output, or it becomes the false-RED
// flakiness the broad set would have caused. The broad set trips on two of these.
console.log('4c. the veto does not fire on honest output');
for (const s2 of [
  REAL_BRIEF,
  'There are no vfkb entries yet.',
  'entries.jsonl is missing, so this is the first session.',
  'No prior continuity recorded.',
  'The brain is empty.',
  'This project is wired for vfkb; nothing recorded yet.',
  'No handoff exists yet.',
  'Nothing has been recorded.',
  'The .vfkb directory is present but has no entries.',
]) check(refusalVetoes(s2).length === 0,
  `veto fired on honest output: ${JSON.stringify(s2.slice(0, 60))} → ${refusalVetoes(s2)}`);

// Every veto name must be a real shape, or a typo silently disarms the gate.
console.log('4d. every veto name resolves to a real refusal shape');
const shapeNames = new Set(REFUSAL_SHAPES.map(([n]) => n));
for (const v of VETO_SHAPES) check(shapeNames.has(v), `VETO_SHAPES names "${v}", which is not a REFUSAL_SHAPES entry`);

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
// Iterate the TABLE, not the code: the previous version looped REFUSAL_SHAPES, so
// DELETING a shape simply skipped its row and stayed green — two mutations
// survived that way (round-3 MINOR 3). The length assertion closes the other
// direction, an added shape with no row.
check(REFUSAL_SHAPES.length === Object.keys(UNIQUE_TO_SHAPE).length,
  `REFUSAL_SHAPES has ${REFUSAL_SHAPES.length} entries but UNIQUE_TO_SHAPE has ` +
  `${Object.keys(UNIQUE_TO_SHAPE).length} rows — a shape was added or deleted without its row`);
for (const name of Object.keys(UNIQUE_TO_SHAPE)) {
  check(shapeNames.has(name), `UNIQUE_TO_SHAPE has a row for "${name}", which no longer exists in REFUSAL_SHAPES`);
  const row = UNIQUE_TO_SHAPE[name];
  const matched = refusalShapes(row);
  check(matched.includes(name), `shape "${name}" does not match its own row (matched ${matched})`);
  check(matched.length === 1,
    `row for "${name}" is not unique to it — also matched ${matched.filter((m) => m !== name)}; ` +
    `deleting "${name}" would leave this selftest green`);
}

// ── 5b. THE SKILL.MD COUPLING IS ENFORCED, NOT ASSERTED (round-3 MINOR 5) ───
// The soundness argument is "the authority is the skill's own contract". Nothing
// checked that BRIEF_SECTIONS still matches that contract, so editing §5's labels
// would silently drift the gate. Parse the mandated bullets and compare.
console.log('5b. BRIEF_SECTIONS matches brief/SKILL.md §5');
{
  const md = readFileSync(new URL('../plugin/skills/brief/SKILL.md', import.meta.url), 'utf8');
  const section = md.slice(md.indexOf('## 5.'), md.indexOf('## 6.') >= 0 ? md.indexOf('## 6.') : undefined);
  const labels = [...section.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1].trim());
  check(labels.length === BRIEF_SECTIONS.length,
    `SKILL.md §5 mandates ${labels.length} sections (${labels.join(', ')}) but BRIEF_SECTIONS has ${BRIEF_SECTIONS.length}`);
  for (const label of labels) {
    check(BRIEF_SECTIONS.some(([, re]) => re.test(label)),
      `SKILL.md §5 mandates a section "${label}" that no BRIEF_SECTIONS pattern matches`);
  }
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

#!/usr/bin/env node
// ============================================================================
// Negative checks for compaction-survival scoring and its gate rule
// (vfkb ADR-0077 clause 3, ADR-0078; ADR-0070 §1 — a guard is seen red).
//
// Synthetic stream-json fixtures, no model calls. The baseline trial must
// score valid + positive, or every red below is vacuous. Then each validity
// condition is broken once; then the two scorer fixtures ADR-0078 names; then
// the gate rule over whole records, including the phasing rule.
//
//   node scenarios/compaction-survival.selftest.mjs
// ============================================================================
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scoreTrial, isValid, compactedHit, contrastHit, classifyAnswer, compactionSurvivalReasons, VALIDITY,
} from './compaction-survival-score.mjs';
import { checkCompactionSurvival, hashTree } from './release-gate.mjs';
import { readFileSync } from 'node:fs';

const A = 'quartzKestrel7391';
const B = 'lumenHarbor4482';
const SENT = [A, B];
const COMPACT_INDEX = 4; // OK, fruits, rivers, mountains, /compact, question

/** A clean, valid, positive trial's events. `over` patches pieces. */
function stream(over = {}) {
  const res = (r) => ({ type: 'result', result: r });
  const ev = [
    { type: 'system', subtype: 'init' },
    res('OK'), res('apple'), res('nile'), res('everest'),
    { type: 'system', subtype: 'status', status: 'compacting' },
    { type: 'system', subtype: 'status', compact_result: over.compactResult ?? 'success' },
    { type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:compact', output: over.emitted === false ? '{}' : `${A} ${B}` },
    ...(over.noBoundary ? [] : [{ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: over.trigger ?? 'manual' } }]),
    res(over.compactText ?? ''),
    ...(over.toolUse ? [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }] : []),
    ...(over.unanswered ? [] : [res(over.answer ?? `${A} and ${B}`)]),
  ];
  return ev;
}
const hookLog = (summary = 'the user asked for fruits, rivers and mountains') => [
  { ev: 'PreCompact', payload: {} }, { ev: 'PostCompact', payload: { compact_summary: summary } },
];
const trial = (over = {}) => scoreTrial({
  events: stream(over), hookLog: over.hookLog ?? hookLog(over.summary), sentinels: SENT,
  sent: 6, compactIndex: COMPACT_INDEX, timedOut: over.timedOut ?? false,
  wallMs: over.wallMs ?? 120000, monoMs: 120000,
});

let failed = 0;
function check(label, got, want) {
  if (got !== want) { console.error(`FAIL  ${label}\n      expected ${want}, got ${got}`); failed++; }
  else console.log(`ok    ${label} — ${got}`);
}

// --- baseline -----------------------------------------------------------------
const base = trial();
check('baseline trial is valid', isValid(base), true);
check('baseline trial is a compacted-arm hit', compactedHit(base), true);

// --- each validity condition broken once (each must go invalid) --------------
const broken = {
  noLeak: trial({ summary: `remember ${A}` }),
  'noLeak (numeric half)': trial({ summary: 'the code ended in 7391' }),
  'noLeak (compact_summary missing)': trial({ hookLog: [{ ev: 'PreCompact', payload: {} }, { ev: 'PostCompact', payload: {} }] }),
  noToolUse: trial({ toolUse: true }),
  compacted: trial({ noBoundary: true }),
  'compacted (auto trigger)': trial({ trigger: 'auto' }),
  compactionOk: trial({ compactResult: 'failed' }),
  'compactionOk (text only)': trial({ compactText: 'Error during compaction: API Error: Connection closed' }),
  engaged: trial({ answer: "I can't help with that request." }),
  answered: trial({ unanswered: true }),
  'answered (timed out)': trial({ timedOut: true }),
  awake: trial({ wallMs: 120000 + 60000 }),
};
for (const [k, t] of Object.entries(broken)) check(`invalid when ${k} is broken`, isValid(t), false);

// --- the scorer fixtures ADR-0078 names ----------------------------------------
const wordyLeak = classifyAnswer(`The code word is ${A}.`, SENT);
check('wordy contrast leak counts as engaged', wordyLeak.engaged, true);
check('wordy contrast leak counts as a contrast hit', contrastHit(wordyLeak), true);
const both = classifyAnswer(`The vault word is ${A} and the migration is ${B}.`, SENT);
check('shipped answer naming both sentinels in prose is received', both.received, true);
check('"NONE." is engaged and not a hit', classifyAnswer('NONE.', SENT).engaged && !classifyAnswer('NONE.', SENT).receivedAny, true);
check('"The code word is NONE" is not engaged (invalid, conservative)', classifyAnswer('The code word is NONE', SENT).engaged, false);
check('a single leaked sentinel is a contrast hit', contrastHit(classifyAnswer(`only ${B}`, SENT)), true);
check('emitted is false when the compact hook carried nothing', trial({ emitted: false }).emitted, false);

// --- the gate rule over whole records -------------------------------------------
const att = (t, sentinels = SENT) => ({ ...t, sentinels });
const contrastMiss = att({ ...trial({ emitted: false, answer: 'NONE' }) });
const record = (compacted, contrast) => ({
  scenario: 'compaction-survival', recordVersion: 2,
  arms: { compacted: { role: 'positive', attempts: compacted }, contrast: { role: 'contrast', attempts: contrast } },
});
const good = record([att(base), att(base), att(base)], [contrastMiss, contrastMiss, contrastMiss]);
check('gate: a clean record is DEMONSTRATED', compactionSurvivalReasons(good).length, 0);

const gateRed = {
  'contrast hit in a valid trial': record([att(base), att(base), att(base)], [contrastMiss, contrastMiss, att(trial({ emitted: false, answer: A }))]),
  'only 2 valid compacted trials (one is invalid: no compaction)': record([att(base), att(base), att(broken.compacted)], [contrastMiss, contrastMiss, contrastMiss]),
  'compacted arm below 2/3 (one valid trial not re-injected)': record([att(base), att(trial({ emitted: false })), att(trial({ emitted: false }))], [contrastMiss, contrastMiss, contrastMiss]),
  'attempts over the cap': record(Array(7).fill(att(base)), [contrastMiss, contrastMiss, contrastMiss]),
  'a short sentinel': record([att(base, ['abc', B]), att(base), att(base)], [contrastMiss, contrastMiss, contrastMiss]),
  'an attempt missing a validity boolean': record([att(base), att(base), (({ awake, ...rest }) => rest)(att(base))], [contrastMiss, contrastMiss, contrastMiss]),
};
for (const [k, rec] of Object.entries(gateRed)) check(`gate red: ${k}`, compactionSurvivalReasons(rec).length > 0, true);

// An invalid trial's "hit" must NOT count: a contrast attempt that recalled the
// sentinel because nothing compacted is invalid, so with 3 other valid misses
// the record is still clean.
const invalidHit = att(trial({ noBoundary: true, emitted: false, answer: A }));
check('gate: a contrast "hit" from an INVALID trial does not count',
  compactionSurvivalReasons(record([att(base), att(base), att(base)], [invalidHit, contrastMiss, contrastMiss, contrastMiss])).length, 0);

// --- the phasing rule (ADR-0077 Q1, enforced) -------------------------------------
const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(repo, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version;
function gateFixture(rec) {
  const root = mkdtempSync(join(tmpdir(), 'cs-gate-'));
  cpSync(join(repo, 'plugin'), join(root, 'plugin'), { recursive: true });
  mkdirSync(join(root, 'scenarios', 'records'), { recursive: true });
  if (rec) {
    const bound = { ...rec, pluginVersion: version, pluginTreeHash: hashTree(join(root, 'plugin')) };
    writeFileSync(join(root, 'scenarios', 'records', 'compaction-survival.json'), JSON.stringify(bound));
  }
  return root;
}
const rNone = gateFixture(null);
check('phasing: no record, not required → no failure', checkCompactionSurvival(rNone, { required: false }).failures.length, 0);
const rDem = gateFixture(good);
check('phasing: DEMONSTRATED record but NOT in REQUIRED → red', checkCompactionSurvival(rDem, { required: false }).failures.length > 0, true);
check('phasing: DEMONSTRATED record and required → green', checkCompactionSurvival(rDem, { required: true }).failures.length, 0);
const rBad = gateFixture(gateRed['contrast hit in a valid trial']);
check('phasing: undemonstrated record, not required → no failure (phased)', checkCompactionSurvival(rBad, { required: false }).failures.length, 0);
check('phasing: undemonstrated record, required → red', checkCompactionSurvival(rBad, { required: true }).failures.length > 0, true);
check('phasing: required but no record → red', checkCompactionSurvival(rNone, { required: true }).failures.length > 0, true);
const rStale = gateFixture(good);
writeFileSync(join(rStale, 'plugin', 'hooks', 'hooks.json'), '{"hooks":{}}');
check('phasing: required record bound to a different plugin/ tree → red', checkCompactionSurvival(rStale, { required: true }).failures.length > 0, true);
for (const r of [rNone, rDem, rBad, rStale]) rmSync(r, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} case(s) did not behave — compaction-survival scoring is not trustworthy`);
  process.exit(1);
}
console.log(`\ncompaction-survival scoring connected: baseline valid, all ${VALIDITY.length} validity conditions and every gate rule observed red`);

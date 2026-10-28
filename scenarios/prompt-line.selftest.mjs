#!/usr/bin/env node
// ============================================================================
// Negative checks for hooks-smoke's promptLineInjected reader (vfkb#385, D5).
// Each case writes a synthetic sandbox `projects/` tree and asserts what
// scanTranscripts reports. Seen red before the reader existed is not possible
// for a new module, so every case that must come out FALSE is the can-fail half.
//   node scenarios/prompt-line.selftest.mjs
// ============================================================================
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTranscripts, PROMPT_NUDGE_LEADIN } from './prompt-line.mjs';

const SID = '11111111-2222-3333-4444-555555555555';
const att = (hookEvent, content, type = 'hook_additional_context') =>
  JSON.stringify({ type: 'attachment', version: '2.1.292', attachment: { type, hookEvent, hookName: hookEvent, content } });
const line = `${PROMPT_NUDGE_LEADIN} the pinned handoff (abc, 2026-10-28) predates 1 commit on work: 1234567 feat: add x.`;

const CASES = [
  ['no projects dir at all (reader cannot see) → found=false', null, { found: false, injected: false }],
  ['a transcript with no attachment → found, not injected', { [`${SID}.jsonl`]: [JSON.stringify({ type: 'user', version: '2.1.292' })] }, { found: true, injected: false }],
  ['the UPS attachment carrying the lead-in in the session file → injected, inSession', { [`${SID}.jsonl`]: [att('UserPromptSubmit', [line])] }, { found: true, injected: true, inSession: true }],
  ['the UPS attachment in another file → injected, not inSession', { 'other.jsonl': [att('UserPromptSubmit', [line])] }, { found: true, injected: true, inSession: false }],
  ['the lead-in on a SessionStart attachment → not injected', { [`${SID}.jsonl`]: [att('SessionStart', [line])] }, { found: true, injected: false }],
  ['a UPS attachment without the lead-in → not injected', { [`${SID}.jsonl`]: [att('UserPromptSubmit', ['some other hook context'])] }, { found: true, injected: false }],
  ['a UPS hook_success (plain-stdout form) → not injected', { [`${SID}.jsonl`]: [att('UserPromptSubmit', [line], 'hook_success')] }, { found: true, injected: false }],
  ['string content and a malformed line → still read', { [`${SID}.jsonl`]: ['{not json', att('UserPromptSubmit', line)] }, { found: true, injected: true, inSession: true }],
];

let bad = 0;
for (const [name, files, want] of CASES) {
  const root = mkdtempSync(join(tmpdir(), 'prompt-line-'));
  const projects = join(root, 'projects');
  if (files) {
    mkdirSync(join(projects, '-sandbox-proj'), { recursive: true });
    for (const [f, lines] of Object.entries(files)) writeFileSync(join(projects, '-sandbox-proj', f), lines.join('\n') + '\n');
  }
  const got = scanTranscripts(projects, SID);
  const wrong = Object.entries(want).filter(([k, v]) => got[k] !== v);
  if (wrong.length) {
    console.error(`  FAIL   ${name} — got ${JSON.stringify(got)}`);
    bad++;
  } else console.log(`  ok     ${name}`);
  rmSync(root, { recursive: true, force: true });
}
if (bad) {
  console.error(`prompt-line selftest FAILED: ${bad}/${CASES.length}`);
  process.exit(1);
}
console.log(`prompt-line selftest passed: ${CASES.length}/${CASES.length}`);

#!/usr/bin/env node
// ============================================================================
// /vfkb:handoff retire-on-yes L4 purpose scenario (vfkb ADR-0082 §5 + DoD)
// ----------------------------------------------------------------------------
// Proves the PURPOSE of ADR-0082 §5 through the real plugin surface: a session
// that loads THIS plugin (--plugin-dir) and runs /vfkb:handoff writes a new
// handoff, names the previous pin and asks whether it is replaced, ENDS ITS
// TURN, and retires the previous pin only when a LATER, RESUMED user turn says
// yes. The answer is never pre-loaded into the first prompt (ADR-0082 DoD).
//
// FIXTURE (identical on every arm): a sandbox git project whose brain, seeded
// through the VENDORED CLI, holds two older live handoffs and, newest-created,
// a sentinel handoff that is the pin.
//
// ARMS (the only variables: the second turn, and which SKILL.md is loaded):
//   positive  new skill, turn 2 = "yes"          -> sentinel retired by the new pin
//   negative  new skill, turn 2 = keep it live    -> no handoff's zone changes
//   noAnswer  new skill, no turn 2                -> no handoff's zone changes
//   contrast  TODAY's skill (origin/main SKILL.md), turn 2 = "yes"
//             -> the sentinel stays live (can-fail arm: proves the retirement
//                comes from the new skill, not from an agent improvising on "yes")
//
// OBSERVED, NOT ASSERTED (ADR-0051 §3): every predicate is a content assertion
// over the sandbox brain after the run, never an exit code. The brain is read
// the way the engine reads it (newest `updated` per id wins), and the pin is
// read from the vendored engine's own `resume` render.
//
// VERDICT: DEMONSTRATED iff the gate's verdict() holds (each positive arm
// >= 2/3, contrast <= 1/3) AND the contrast retired 0/3, as ADR-0082 requires.
// LIVE + metered. One at a time.
//   node scenarios/handoff-retires.mjs
//   VFKB_HR_TRIALS=1 VFKB_HR_ARMS=positive node scenarios/handoff-retires.mjs
// ============================================================================
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verdict, hashTree } from './release-gate.mjs';
import { authEnv, redactSecrets, producedBy, assertAuthReady } from './auth.mjs';
assertAuthReady();

const REPO = resolve(process.argv[1], '../..');
const PLUGIN = join(REPO, 'plugin');
const CLI = join(PLUGIN, 'dist', 'bundles', 'vfkb.mjs');
const TRIALS = Math.max(1, parseInt(process.env.VFKB_HR_TRIALS || '3', 10));
const OUTER_MODEL = process.env.VFKB_HR_OUTER_MODEL || 'claude-sonnet-5-5';
const TIMEOUT = parseInt(process.env.VFKB_HR_TIMEOUT || '420000', 10);
// Today's skill, for the contrast arm: the SKILL.md this change replaces.
const CONTRAST_REF = process.env.VFKB_HR_CONTRAST_REF || 'origin/main';

const SENTINEL = 'quillfen-arbor-44';
const YES = 'yes';
const NO = 'no — keep the previous handoff live, it is still current';
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', ...o });

/** The contrast plugin: this plugin/ tree with today's SKILL.md, so only the skill differs. */
function contrastPlugin() {
  const dir = mkdtempSync(join(tmpdir(), 'vfkb-hr-plugin-'));
  cpSync(PLUGIN, join(dir, 'plugin'), { recursive: true });
  const old = sh('git', ['show', `${CONTRAST_REF}:plugin/skills/handoff/SKILL.md`], { cwd: REPO });
  if (old.includes('curate retire')) throw new Error(`${CONTRAST_REF}'s SKILL.md already retires — not a contrast`);
  writeFileSync(join(dir, 'plugin', 'skills', 'handoff', 'SKILL.md'), old);
  return join(dir, 'plugin');
}

function buildSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'vfkb-hr-'));
  sh('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'main.ts'), 'export const main = () => 0;\n');
  sh('git', ['add', '-A'], { cwd: dir });
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'chore: scaffold'], { cwd: dir });
  const env = { ...process.env, VFKB_DATA_DIR: join(dir, '.vfkb') };
  const add = (text, tags) =>
    sh('node', [CLI, 'add', 'fact', text, '--role', 'human', '--prov-status', 'verified', '--tag', tags],
      { env }).split('\t')[0].trim();
  const older1 = add('HANDOFF (older): the lexer rewrite landed; next was the parser.', 'handoff,next');
  const older2 = add('HANDOFF (older): the parser landed; next was the type checker.', 'handoff,next');
  const sentinel = add(
    `HANDOFF: the type checker landed and is verified. The single next step is the migration ` +
    `codenamed ${SENTINEL}; keep the feature flag off until the backfill verifier reports clean.`,
    'handoff,next,status');
  sh('git', ['add', '-A'], { cwd: dir });
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'chore: brain'], { cwd: dir });
  const fixture = readBrain(dir);
  return { dir, ids: { older1, older2, sentinel }, fixture };
}

/** The brain as the engine reads it: newest `updated` per id wins, a tie goes to the later line. */
function readBrain(dir) {
  const out = new Map();
  let lines = [];
  try { lines = readFileSync(join(dir, '.vfkb', 'entries.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { /* empty */ }
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const prev = out.get(e.id);
    if (!prev || String(e.updated) >= String(prev.updated)) out.set(e.id, e);
  }
  return out;
}

/** The pin id, from the vendored engine's own render (ADR-0082 §3). */
function pinId(dir) {
  const r = sh('node', [CLI, 'resume'], { env: { ...process.env, VFKB_DATA_DIR: join(dir, '.vfkb') } });
  const m = /## Last handoff\s*\n- \[[^\]]*· ([0-9a-f]{6,})\]/.exec(r);
  return m ? m[1] : null;
}

function claude(dir, plugin, prompt, resumeId) {
  const args = ['-p', prompt, '--plugin-dir', plugin, '--output-format', 'json',
    '--strict-mcp-config', '--dangerously-skip-permissions', '--model', OUTER_MODEL];
  if (resumeId) args.push('--resume', resumeId);
  let raw = '';
  let err = '';
  try {
    raw = sh('claude', args, { cwd: dir, env: authEnv(process.env), timeout: TIMEOUT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    err = redactSecrets(String(e.stderr || e.message || '')).replace(/\s+/g, ' ').slice(0, 160);
    raw = String(e.stdout || '');
  }
  try {
    const j = JSON.parse(raw);
    return { text: redactSecrets(String(j.result ?? '')), sid: j.session_id ?? null, models: Object.keys(j.modelUsage ?? {}), err };
  } catch {
    return { text: redactSecrets(raw), sid: null, models: [], err };
  }
}

function runArm(arm, contrastDir) {
  const { dir, ids, fixture } = buildSandbox();
  const plugin = arm === 'contrast' ? contrastDir : PLUGIN;
  const t1 = claude(dir, plugin, '/vfkb:handoff');
  const second = { positive: YES, negative: NO, contrast: YES }[arm];
  const t2 = second && t1.sid ? claude(dir, plugin, second, t1.sid) : null;
  const after = readBrain(dir);
  const pin = pinId(dir);
  const fixtureIds = new Set(fixture.keys());
  const pinEntry = pin ? after.get(pin) : null;
  const s0 = fixture.get(ids.sentinel), s1 = after.get(ids.sentinel);
  const zoneSame = (id) => after.get(id)?.zone === fixture.get(id)?.zone;
  const obs = {
    // The new handoff exists and is the pin: a fact the fixture did not have, tagged handoff.
    newPin: !!pinEntry && !fixtureIds.has(pin) && pinEntry.type === 'fact' &&
      (pinEntry.tags ?? []).some((t) => t === 'handoff' || t === 'next'),
    // ADR-0082 §4: archived, tagged retired-by:<new pin>, text byte-identical.
    retiredByPin: !!s1 && s1.zone === 'archive' && !!pin && (s1.tags ?? []).includes(`retired-by:${pin}`),
    textIdentical: !!s1 && s1.text === s0.text,
    othersUntouched: zoneSame(ids.older1) && zoneSame(ids.older2),
    zonesUnchanged: [...fixtureIds].every(zoneSame),
    // The contrast's predicate: did the sentinel stop being live by ANY route?
    sentinelNotLive: !!s1 && s1.zone !== s0.zone,
    // Diagnostics, never gating.
    asked: t1.text.includes(ids.sentinel),
    resumed: !!t2 && t2.sid === t1.sid,
    models: [...new Set([...t1.models, ...(t2?.models ?? [])])],
    turn1: t1.text.replace(/\s+/g, ' ').slice(-300),
    turn2: t2 ? t2.text.replace(/\s+/g, ' ').slice(0, 300) : null,
    err: [t1.err, t2?.err].filter(Boolean).join(' | '),
  };
  // The pinned outer model must be observed, not assumed (ADR-0050).
  obs.modelObserved = obs.models.some((m) => m.startsWith(OUTER_MODEL));
  rmSync(dir, { recursive: true, force: true });
  return obs;
}

const arms = {
  positive: { role: 'positive', predicate: ['newPin', 'retiredByPin', 'textIdentical', 'othersUntouched', 'modelObserved'], trials: [] },
  negative: { role: 'positive', predicate: ['newPin', 'zonesUnchanged', 'modelObserved'], trials: [] },
  noAnswer: { role: 'positive', predicate: ['newPin', 'zonesUnchanged', 'modelObserved'], trials: [] },
  contrast: { role: 'contrast', predicate: ['sentinelNotLive'], trials: [] },
};
const ARMS = (process.env.VFKB_HR_ARMS || Object.keys(arms).join(',')).split(',').map((a) => a.trim()).filter(Boolean);
const unknown = ARMS.filter((a) => !(a in arms));
if (unknown.length) {
  console.error(`unknown arm(s) ${unknown.join(', ')} — choices: ${Object.keys(arms).join(', ')}`);
  process.exit(2);
}
for (const a of Object.keys(arms)) if (!ARMS.includes(a)) delete arms[a];

console.log(`vfkb-claude-plugin handoff-retires L4  (outer=${OUTER_MODEL}, trials=${TRIALS}, contrast=${CONTRAST_REF})`);
const contrastDir = ARMS.includes('contrast') ? contrastPlugin() : null;
for (let t = 1; t <= TRIALS; t++) {
  for (const arm of ARMS) {
    process.stdout.write(`  trial ${t}  ${arm.padEnd(9)} … `);
    const r = runArm(arm, contrastDir);
    arms[arm].trials.push(r);
    const hit = arms[arm].predicate.every((k) => r[k] === true);
    const shown = arms[arm].predicate.map((k) => `${k}=${r[k]}`).join(' ');
    console.log(`${arm === 'contrast' ? (hit ? 'RETIRED' : 'live') : hit ? 'HIT' : 'miss'}  (${shown}; asked=${r.asked} resumed=${r.resumed})${r.err ? '  ERR:' + r.err : ''}`);
  }
}
if (contrastDir) rmSync(resolve(contrastDir, '..'), { recursive: true, force: true });

const pluginVersion = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const record = {
  scenario: 'handoff-retires', recordVersion: 2, pluginVersion,
  pluginTreeHash: hashTree(PLUGIN), outerModel: OUTER_MODEL, contrastRef: CONTRAST_REF,
  contrastSkillSha: contrastDir === null ? null : sh('git', ['rev-parse', `${CONTRAST_REF}:plugin/skills/handoff/SKILL.md`], { cwd: REPO }).trim(),
  producedBy: producedBy(REPO), trials: TRIALS, generated: new Date().toISOString(),
  ...(process.env.VFKB_HR_NOTE ? { note: process.env.VFKB_HR_NOTE } : {}),
  arms,
};
const { ok, reasons } = verdict(record);
const contrastRetired = (arms.contrast?.trials ?? []).filter((r) => r.sentinelNotLive).length;
if (arms.contrast && contrastRetired > 0) reasons.push(`contrast retired ${contrastRetired}/${TRIALS}; ADR-0082 requires 0/${TRIALS}`);
const demonstrated = ok && (!arms.contrast || contrastRetired === 0);
for (const [a, v] of Object.entries(arms)) {
  console.log(`${a}: ${v.trials.filter((r) => v.predicate.every((k) => r[k] === true)).length}/${TRIALS} on [${v.predicate}]`);
}
console.log(demonstrated
  ? 'DEMONSTRATED — /vfkb:handoff retires the previous pin only on a later yes (ADR-0082 §5)'
  : `NOT demonstrated — ${reasons.join('; ')}`);

mkdirSync(join(REPO, 'scenarios/records'), { recursive: true });
const partial = Object.keys({ positive: 1, negative: 1, noAnswer: 1, contrast: 1 }).some((a) => !ARMS.includes(a));
const outName = process.env.VFKB_HR_RECORD || (partial ? 'handoff-retires.partial.json' : 'handoff-retires.json');
writeFileSync(join(REPO, 'scenarios/records', outName), JSON.stringify(record, null, 2) + '\n');
console.log(`record → scenarios/records/${outName} (pluginVersion=${pluginVersion})`);
process.exit(demonstrated ? 0 : 1);

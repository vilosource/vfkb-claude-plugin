#!/usr/bin/env node
// ============================================================================
// Background-curation L4 purpose scenario (vfkb ADR-0083 Tier 1 + §5, DoD)
// ----------------------------------------------------------------------------
// Proves the PURPOSE of ADR-0083 Tier 1 through the real plugin surface: a
// session that loads THIS plugin (--plugin-dir) ends, its SessionEnd hook runs
// the deterministic rule and archives exactly the clear-cut old handoffs, and
// the NEXT session is told so in one briefing line that its agent can relay.
//
// FIXTURE (identical on every arm): a sandbox git project on a TOPIC branch
// (ADR-0083 §3: the rule never runs on the default branch). Its committed brain
// holds raw JSONL lines dated RELATIVE to the run, so the rule's 14-day window
// holds whichever entry ends up as the pin (the agent's own handoff or the B2
// fallback, both created during session 1). Before session 1 the harness
// appends one uncommitted, non-handoff entry through the arm's CLI, so the
// rule's precondition (a new id since HEAD) never depends on what the agent
// chooses to write.
//
//   archived by the rule (EXPECTED):
//     q1   shaped, 60d, no topic tag
//     q2   shaped, 50d, topic `parser`, cleared by n1 (`parser`, still live)
//     n2   shaped, 20d, no topic tag (newer: a, r1, r2, n3 — >= 3 without the pin)
//   kept, and the three planted traps (ADR-0083 DoD):
//     a    TRAP (a) a recent handoff the pin says "still stands" (8d < 14d)
//     b    TRAP (b) an old topical status fact (unshaped, 70d)
//     c    TRAP (c) an old, shaped, still-live handoff of a PAUSED stream: 45d,
//          >= 3 newer handoffs, topic `jev` that none of them shares. Only the
//          same-stream guard saves it — the case the rule is most likely to get
//          wrong.
//     n1   shaped, 30d, topic `parser` no newer handoff shares (held)
//     r1 r2 n3   recent (6d, 5d, 3d); n3 is the fixture's pin
//   Every expected outcome holds whether or not session 1's agent writes a
//   handoff of its own: no decision depends on counting the new pin.
//
// ARMS (the only variable: which engine bundle the plugin runs):
//   positive      this plugin's vendored engine               (≥ 2/3)
//   guardRemoved  a pinned, sha-checked bundle with the stream guard removed
//                 (scenarios/fixtures/vfkb-no-stream-guard.mjs) — trap (c) MUST
//                 be archived. Shows the trap detects the failure it is planted
//                 for. ADR-0083 allows N=1 here (Tier 1 has no model); it runs
//                 N=3 like every arm, because the gate's verdict() binds one N per record.
//   contrast      the released v0.21.0 engine (git tag vfkb--v0.21.0, sha-pinned)
//                 — nothing archived and no line. Must score 0/N.
//
// OBSERVED, NOT ASSERTED (ADR-0051 §3): every predicate is a content assertion
// over the sandbox brain, its git history, the engine's own render, or the
// agent's answer text — never an exit code. The pinned outer model must be seen
// in modelUsage (ADR-0050).
//
// LIVE + metered. One at a time.
//   node scenarios/background-curation.mjs
//   VFKB_BC_TRIALS=1 VFKB_BC_ARMS=positive node scenarios/background-curation.mjs
// ============================================================================
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync, appendFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { recordVerdict, hashTree } from './release-gate.mjs';
import { authEnv, redactSecrets, producedBy, assertAuthReady } from './auth.mjs';
assertAuthReady();

const REPO = resolve(process.argv[1], '../..');
const PLUGIN = join(REPO, 'plugin');
const TRIALS = Math.max(1, parseInt(process.env.VFKB_BC_TRIALS || '3', 10));
const OUTER_MODEL = process.env.VFKB_BC_OUTER_MODEL || 'claude-sonnet-5-5';
const TIMEOUT = parseInt(process.env.VFKB_BC_TIMEOUT || '420000', 10);
// guardRemoved: the vfkb engine with ADR-0083 §2 condition 5 deleted, pinned by content.
const NO_GUARD_BUNDLE = join(REPO, 'scenarios', 'fixtures', 'vfkb-no-stream-guard.mjs');
const NO_GUARD_SHA256 = '964b02970f64d7ce76bb7fee6736051ecee1ef9f0370875c76ab48900846130b';
// contrast: the released engine that predates ADR-0083, read from its immutable tag.
const CONTRAST_TAG = 'vfkb--v0.21.0';
const CONTRAST_SHA256 = 'c015a4b7dee4e1e0afa28aa39b2c3510615971df480ea998600a186694da4e47';

const EXPECTED_ARCHIVED = ['q1', 'q2', 'n2'];
const TRAPS = ['a', 'b', 'c'];
const KEPT = ['a', 'b', 'c', 'n1', 'r1', 'r2', 'n3'];
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', ...o });
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** A copy of this plugin/ tree whose vendored CLI bundle is `bundle` — so only the engine differs. */
function pluginWith(bundleText) {
  const dir = mkdtempSync(join(tmpdir(), 'vfkb-bc-plugin-'));
  cpSync(PLUGIN, join(dir, 'plugin'), { recursive: true });
  writeFileSync(join(dir, 'plugin', 'dist', 'bundles', 'vfkb.mjs'), bundleText);
  return join(dir, 'plugin');
}

function noGuardPlugin() {
  if (!existsSync(NO_GUARD_BUNDLE)) throw new Error(`missing fixture ${NO_GUARD_BUNDLE}`);
  const text = readFileSync(NO_GUARD_BUNDLE, 'utf8');
  const got = sha256(text);
  if (got !== NO_GUARD_SHA256) throw new Error(`guard-removed bundle changed (sha256 ${got}) — not the pinned fixture`);
  if (!text.includes('auto-archived:')) throw new Error('guard-removed bundle has no Tier-1 rule — not a guard-removed arm');
  return pluginWith(text);
}

function contrastPlugin() {
  let text;
  try {
    text = sh('git', ['show', `${CONTRAST_TAG}:plugin/dist/bundles/vfkb.mjs`], { cwd: REPO, maxBuffer: 64 << 20 });
  } catch {
    throw new Error(`cannot read ${CONTRAST_TAG} — fetch tags (git fetch --tags)`);
  }
  const got = sha256(text);
  if (got !== CONTRAST_SHA256) throw new Error(`contrast bundle at ${CONTRAST_TAG} has sha256 ${got}, not the pinned one`);
  if (text.includes('auto-archived:')) throw new Error('contrast bundle already has the Tier-1 rule — not a contrast');
  return pluginWith(text);
}

function fixtureLine(id, ageDays, text, tags) {
  const t = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  return JSON.stringify({
    id, type: 'fact', text, tags, zone: 'established', author: { role: 'human' },
    provenance: { status: 'verified', date: t }, validity: { valid_from: t }, created: t, updated: t,
  });
}

function buildSandbox(plugin) {
  const dir = mkdtempSync(join(tmpdir(), 'vfkb-bc-'));
  sh('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  // A repo-local identity: without one SessionEnd's auto-commit fails silently (fail-open).
  sh('git', ['config', 'user.email', 't@t'], { cwd: dir });
  sh('git', ['config', 'user.name', 't'], { cwd: dir });
  sh('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'main.ts'), 'export const main = () => 0;\n');
  mkdirSync(join(dir, '.vfkb'));
  const H = 'HANDOFF';
  const lines = [
    fixtureLine('b', 70, 'SHIPPED: the lexer rewrite merged as PR #12; the release notes still owe a migration section.', ['handoff', 'next', 'status']),
    fixtureLine('q1', 60, `${H}: the scaffold landed; next was the lexer.`, ['handoff', 'next']),
    fixtureLine('q2', 50, `${H}: the lexer landed; next was the parser.`, ['handoff', 'next', 'parser']),
    fixtureLine('c', 45, `${H}: the Jev calibration probe is paused at the labelling step; resume it from the cached windows.`, ['handoff', 'next', 'jev']),
    fixtureLine('n1', 30, `${H}: the parser landed; next is the type checker.`, ['handoff', 'next', 'parser']),
    fixtureLine('n2', 20, `${H}: the type checker is half done; next is inference.`, ['handoff', 'next']),
    fixtureLine('a', 8, `${H}: the backfill verifier is the open item; next is its clean report.`, ['handoff', 'next']),
    fixtureLine('r1', 6, `${H}: inference landed; next is error messages.`, ['handoff', 'next']),
    fixtureLine('r2', 5, `${H}: error messages landed; next is the CLI.`, ['handoff', 'next']),
    fixtureLine('n3', 3, `${H}: the CLI landed. The NEXT of handoff a (the backfill verifier) still stands.`, ['handoff', 'next']),
  ];
  writeFileSync(join(dir, '.vfkb', 'entries.jsonl'), lines.join('\n') + '\n');
  sh('git', ['add', '-A'], { cwd: dir });
  sh('git', ['commit', '-qm', 'chore: scaffold + brain'], { cwd: dir });
  sh('git', ['switch', '-q', '-c', 'feat/work'], { cwd: dir });
  // The session's own write (uncommitted, a new id): ADR-0083 §3's precondition.
  const env = { ...process.env, VFKB_DATA_DIR: join(dir, '.vfkb') };
  sh('node', [join(plugin, 'dist', 'bundles', 'vfkb.mjs'), 'add', 'gotcha',
    'the CLI parses flags before positionals', '--role', 'human', '--tag', 'cli'], { env });
  const commitsBefore = Number(sh('git', ['rev-list', '--count', 'HEAD'], { cwd: dir }).trim());
  return { dir, fixture: readBrain(dir), commitsBefore };
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

function claude(dir, plugin, prompt) {
  // stream-json, not json: the plugin's Stop hook can draw a SECOND reply (the stale-handoff
  // nudge), and `result` is then that reply, not the answer. Every assistant text is kept.
  const args = ['-p', prompt, '--plugin-dir', plugin, '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--dangerously-skip-permissions', '--model', OUTER_MODEL];
  let raw = '';
  let err = '';
  try {
    raw = sh('claude', args, { cwd: dir, env: authEnv(process.env), timeout: TIMEOUT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
  } catch (e) {
    err = redactSecrets(String(e.stderr || e.message || '')).replace(/\s+/g, ' ').slice(0, 160);
    raw = String(e.stdout || '');
  }
  const texts = [];
  const models = new Set();
  for (const line of raw.split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content ?? []) if (c.type === 'text' && c.text) texts.push(c.text);
      if (ev.message?.model) models.add(ev.message.model);
    }
    if (ev.type === 'result') for (const m of Object.keys(ev.modelUsage ?? {})) models.add(m);
  }
  return { text: redactSecrets(texts.join('\n')), models: [...models], err };
}

const S1 = 'Reply with exactly the word: ok';
const S2 = 'Without running any commands or tools, using only what you were shown at the start of this ' +
  'session: did the knowledge base archive anything automatically since the last session? If so, how ' +
  'many entries, and what command would undo one? Answer in one or two sentences.';

function runArm(arm, plugin) {
  const { dir, fixture, commitsBefore } = buildSandbox(plugin);
  const cli = join(plugin, 'dist', 'bundles', 'vfkb.mjs');
  const t1 = claude(dir, plugin, S1);
  const after = readBrain(dir);
  const isRuleArchived = (id) => after.get(id)?.zone === 'archive' &&
    (after.get(id)?.tags ?? []).some((t) => t.startsWith('auto-archived:old-handoff@'));
  const head = sh('git', ['log', '-1', '--pretty=%B'], { cwd: dir });
  const commitsAfter = Number(sh('git', ['rev-list', '--count', 'HEAD'], { cwd: dir }).trim());
  const dirty = sh('git', ['status', '--porcelain', '--', '.vfkb/entries.jsonl'], { cwd: dir }).trim();
  // What session 2 is injected with: the arm engine's own render of the committed brain.
  const render = sh('node', [cli, 'resume'], { env: { ...process.env, VFKB_DATA_DIR: join(dir, '.vfkb') } });
  const t2 = claude(dir, plugin, S2);
  const answer = t2.text.toLowerCase();
  const fixtureIds = [...fixture.keys()].filter((id) => KEPT.includes(id) || EXPECTED_ARCHIVED.includes(id));
  const obs = {
    // ADR-0083 §2: exactly the qualifying set, each tagged by the rule.
    archivedExact: EXPECTED_ARCHIVED.every(isRuleArchived) &&
      fixtureIds.filter((id) => after.get(id)?.zone === 'archive').length === EXPECTED_ARCHIVED.length,
    trapsLive: TRAPS.every((id) => after.get(id)?.zone === 'established'),
    trapCArchived: after.get('c')?.zone === 'archive',
    anyArchived: fixtureIds.some((id) => after.get(id)?.zone === 'archive'),
    textIdentical: EXPECTED_ARCHIVED.every((id) => after.get(id)?.text === fixture.get(id)?.text),
    // ADR-0083 §3: the archives ride the session's ONE brain-only commit.
    oneCommit: commitsAfter === commitsBefore + 1 && /session-end auto-commit .*curated/.test(head) && dirty === '',
    // ADR-0083 §5: the next session's injection carries the line.
    lineInjected: /Curation: auto-archived 3 old handoffs in the last 7 days/.test(render) && render.includes('vfkb curate restore'),
    // ...and its agent can relay it: the count and the undo command, from its answer text.
    answerRelays: /\b(3|three)\b/.test(answer) && answer.includes('curate restore'),
    models: [...new Set([...t1.models, ...t2.models])],
    answer: t2.text.replace(/\s+/g, ' ').slice(0, 300),
    commitMessage: head.trim().slice(0, 160),
    err: [t1.err, t2.err].filter(Boolean).join(' | '),
  };
  obs.modelObserved = [t1, t2].every((t) => t.models.some((m) => m.startsWith(OUTER_MODEL)));
  rmSync(dir, { recursive: true, force: true });
  return obs;
}

const arms = {
  positive: { role: 'positive', predicate: ['archivedExact', 'trapsLive', 'textIdentical', 'oneCommit', 'lineInjected', 'answerRelays', 'modelObserved'], trials: [] },
  guardRemoved: { role: 'positive', predicate: ['trapCArchived'], trials: [] },
  contrast: { role: 'contrast', predicate: ['anyArchived'], trials: [] },
};
const ARMS = (process.env.VFKB_BC_ARMS || Object.keys(arms).join(',')).split(',').map((a) => a.trim()).filter(Boolean);
const unknown = ARMS.filter((a) => !(a in arms));
if (unknown.length) {
  console.error(`unknown arm(s) ${unknown.join(', ')} — choices: ${Object.keys(arms).join(', ')}`);
  process.exit(2);
}
for (const a of Object.keys(arms)) if (!ARMS.includes(a)) delete arms[a];

console.log(`vfkb-claude-plugin background-curation L4  (outer=${OUTER_MODEL}, trials=${TRIALS})`);
const plugins = {
  positive: () => PLUGIN,
  guardRemoved: noGuardPlugin,
  contrast: contrastPlugin,
};
const made = {};
for (const a of ARMS) made[a] = plugins[a]();
for (let t = 1; t <= TRIALS; t++) {
  for (const arm of ARMS) {
    process.stdout.write(`  trial ${t}  ${arm.padEnd(12)} … `);
    const r = runArm(arm, made[arm]);
    arms[arm].trials.push(r);
    const hit = arms[arm].predicate.every((k) => r[k] === true);
    const shown = arms[arm].predicate.map((k) => `${k}=${r[k]}`).join(' ');
    console.log(`${arm === 'contrast' ? (hit ? 'ARCHIVED' : 'untouched') : hit ? 'HIT' : 'miss'}  (${shown})${r.err ? '  ERR:' + r.err : ''}`);
  }
}
for (const a of ARMS) if (made[a] !== PLUGIN) rmSync(resolve(made[a], '..'), { recursive: true, force: true });

const pluginVersion = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const record = {
  scenario: 'background-curation', recordVersion: 2, pluginVersion,
  pluginTreeHash: hashTree(PLUGIN), outerModel: OUTER_MODEL,
  noGuardBundleSha256: NO_GUARD_SHA256, contrastTag: CONTRAST_TAG, contrastBundleSha256: CONTRAST_SHA256,
  producedBy: producedBy(REPO), trials: TRIALS, generated: new Date().toISOString(),
  ...(process.env.VFKB_BC_NOTE ? { note: process.env.VFKB_BC_NOTE } : {}),
  arms,
};
const { ok: demonstrated, reasons } = recordVerdict(record, 'background-curation');
for (const [a, v] of Object.entries(arms)) {
  console.log(`${a}: ${v.trials.filter((r) => v.predicate.every((k) => r[k] === true)).length}/${v.trials.length} on [${v.predicate}]`);
}
console.log(demonstrated
  ? 'DEMONSTRATED — SessionEnd archives exactly the clear-cut old handoffs and the next session is told (ADR-0083)'
  : `NOT demonstrated — ${reasons.join('; ')}`);

mkdirSync(join(REPO, 'scenarios/records'), { recursive: true });
const partial = Object.keys({ positive: 1, guardRemoved: 1, contrast: 1 }).some((a) => !ARMS.includes(a));
const outName = process.env.VFKB_BC_RECORD || (partial ? 'background-curation.partial.json' : 'background-curation.json');
writeFileSync(join(REPO, 'scenarios/records', outName), JSON.stringify(record, null, 2) + '\n');
console.log(`record → scenarios/records/${outName} (pluginVersion=${pluginVersion})`);
process.exit(demonstrated ? 0 : 1);

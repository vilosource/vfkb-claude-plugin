#!/usr/bin/env node
// ============================================================================
// inactive-signal L4 (ADR-0059 / issue #4) — the "vfkb INACTIVE" guard proof
// ----------------------------------------------------------------------------
// Proves the repo-side guard (templates/vfkb-guard.mjs) restores the actionable
// signal ADR-0045 removed: a session in a plugin-wired repo where the plugin is
// DECLARED but NOT installed surfaces a "vfkb INACTIVE" banner, and a session
// where the plugin IS installed does not.
//
// CAUSAL DESIGN (only variable = whether the plugin is installed in the HOME):
//   - absent arm (positive): sandbox repo declares the plugin + wires the guard
//     as a SessionStart hook, but the plugin is NOT installed in the sandbox
//     HOME → the guard must banner "vfkb INACTIVE".
//   - present arm (contrast): identical sandbox, plugin marketplace-added +
//     installed in the HOME → the guard must be SILENT (fulfillment recorded),
//     and if install had failed the guard would banner → contrast leak → red.
//     So the contrast arm's banner-absence also certifies the install path.
//
// OBSERVED, NOT ASSERTED (ADR-0029/0051 — content assertion, never exit code):
//   bannerShown  the turn's output quotes the guard's "vfkb INACTIVE" line.
//   vfkbLive     (recorded, not gated) the turn also names the unguessable
//                handoff sentinel — resume injection working, i.e. the plugin
//                genuinely live in the present arm. Cross-checks the sandbox;
//                plugin liveness itself is hooks-smoke.mjs's job, not this one.
//
// The guard's structural branches (fail-open, scope matching, wrong-path,
// symlinks) are the deterministic inner gate in scenarios/guard-branches.test.mjs;
// this L4 proves the end-to-end agent-observable behavior on top of it.
//
// VERDICT: DEMONSTRATED iff absent bannerShown >= 2/3 AND present leaks <= 1/3
// (vfkb ADR-0022), recomputed by the release gate's own verdict(). LIVE +
// metered (haiku, one turn per trial per arm). One at a time.
//   node scenarios/inactive-signal.mjs
//   VFKB_IS_TRIALS=1 node scenarios/inactive-signal.mjs
// ============================================================================
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync, chmodSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { verdict, hashTree } from './release-gate.mjs';

const REPO = resolve(process.argv[1], '../..');
const GUARD = join(REPO, 'templates', 'vfkb-guard.mjs');
const CLI = join(REPO, 'plugin', 'dist', 'bundles', 'vfkb.mjs');
const TRIALS = Math.max(1, parseInt(process.env.VFKB_IS_TRIALS || '3', 10));
const MODEL = process.env.VFKB_IS_MODEL || 'claude-haiku-4-5-20251001';
const TIMEOUT = parseInt(process.env.VFKB_IS_TIMEOUT || '200000', 10);

const SENTINEL = 'plumcanyon-verdigris-73';
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', ...o });

function stageCreds(homeDir) {
  const all = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
  if (!all.claudeAiOauth) throw new Error('no claudeAiOauth block in ~/.claude/.credentials.json');
  const dir = join(homeDir, '.claude');
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, '.credentials.json');
  writeFileSync(dst, JSON.stringify({ claudeAiOauth: all.claudeAiOauth }));
  chmodSync(dst, 0o600);
}

function buildSandbox(installed) {
  const root = mkdtempSync(join(tmpdir(), 'vfkb-is-'));
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  mkdirSync(join(proj, '.claude'), { recursive: true });
  mkdirSync(home, { recursive: true });
  stageCreds(home);

  // The consumer wiring, EXACTLY as a migrated repo carries it: declare the
  // plugin + its marketplace, AND wire the guard as a SessionStart hook.
  copyFileSync(GUARD, join(proj, '.claude', 'vfkb-guard.mjs'));
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({
    extraKnownMarketplaces: { vfkb: { source: { source: 'directory', path: REPO } } },
    enabledPlugins: { 'vfkb@vfkb': true },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR:-.}/.claude/vfkb-guard.mjs' }] }],
    },
  }, null, 2));

  // Seed the brain with the sentinel handoff so the present arm can observe
  // resume-injection (vfkbLive). Uses the vendored CLI, like every other scenario.
  mkdirSync(join(proj, '.vfkb'));
  sh('node', [CLI, 'add', 'fact',
    `HANDOFF: the single next step is the migration codenamed ${SENTINEL}.`,
    '--role', 'human', '--prov-status', 'verified', '--tag', 'handoff,next,status'],
    { env: { ...process.env, VFKB_DATA_DIR: join(proj, '.vfkb') }, stdio: 'ignore' });

  sh('git', ['init', '-q'], { cwd: proj });
  sh('git', ['config', 'user.name', 'inactive-signal'], { cwd: proj });
  sh('git', ['config', 'user.email', 'inactive-signal@sandbox.local'], { cwd: proj });
  sh('git', ['add', '-A'], { cwd: proj });
  sh('git', ['commit', '-qm', 'chore: scaffold'], { cwd: proj });
  sh('git', ['checkout', '-qb', 'work'], { cwd: proj });

  if (installed) {
    sh('claude', ['plugin', 'marketplace', 'add', REPO],
      { env: { ...process.env, HOME: home }, stdio: 'ignore', timeout: 60000 });
    sh('claude', ['plugin', 'install', 'vfkb@vfkb', '--scope', 'user'],
      { env: { ...process.env, HOME: home }, stdio: 'ignore', timeout: 60000 });
  }
  return { root, home, proj };
}

function runTrial(installed) {
  const sb = buildSandbox(installed);
  let raw = '';
  let err = '';
  try {
    raw = sh('claude', ['-p',
      'Two things, from your session-start context only: (1) Quote VERBATIM the first line of any ' +
      'warning banner about vfkb being inactive or not installed, or say NOBANNER. (2) If a handoff ' +
      'names a migration codename (a distinctive hyphenated phrase), state it, or say NONE.',
      '--output-format', 'json', '--model', MODEL], {
      cwd: sb.proj,
      env: { ...process.env, HOME: sb.home },
      timeout: TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    err = String(e.stderr || e.message || '').replace(/\s+/g, ' ').slice(0, 160);
    raw = String(e.stdout || '');
  }
  let text = '';
  try { text = String(JSON.parse(raw).result ?? ''); } catch { text = raw; }
  const low = text.toLowerCase();
  const obs = {
    bannerShown: low.includes('vfkb inactive'),
    vfkbLive: low.includes(SENTINEL),
    out: text.replace(/\s+/g, ' ').slice(0, 110),
    err,
  };
  rmSync(sb.root, { recursive: true, force: true });
  return obs;
}

console.log(`vfkb-claude-plugin inactive-signal L4  (model=${MODEL}, trials=${TRIALS})`);
console.log('absent hit = "vfkb INACTIVE" banner surfaced; present leak = banner surfaced with plugin installed\n');

const arms = {
  absent: { role: 'positive', predicate: ['bannerShown'], trials: [] },
  present: { role: 'contrast', predicate: ['bannerShown'], trials: [] },
};
for (let t = 1; t <= TRIALS; t++) {
  for (const arm of ['absent', 'present']) {
    process.stdout.write(`  trial ${t}  ${arm.padEnd(7)} … `);
    const r = runTrial(arm === 'present');
    arms[arm].trials.push(r);
    const tag = arm === 'absent'
      ? (r.bannerShown ? 'HIT ' : 'miss')
      : (r.bannerShown ? 'LEAK' : 'clean');
    console.log(`${tag}  banner=${r.bannerShown ? 1 : 0} vfkbLive=${r.vfkbLive ? 1 : 0}  — "${r.out}"${r.err ? '  ERR:' + r.err : ''}`);
  }
}

const pluginVersion = JSON.parse(
  readFileSync(join(REPO, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'),
).version;
const record = {
  scenario: 'inactive-signal', recordVersion: 2, pluginVersion,
  // Tree-binding (#28): a version string is not a tree. Between re-vendors the
  // version stays unreleased and may drift, so version-binding alone would let
  // this record prove an EARLIER plugin/ tree while every gate stayed green —
  // the dishonesty #22 closed for the delivery record only.
  pluginTreeHash: hashTree(join(REPO, 'plugin')), outerModel: MODEL,
  trials: TRIALS, generated: new Date().toISOString(), arms,
};

const { ok: demonstrated, reasons } = verdict(record);
console.log(demonstrated
  ? '\nDEMONSTRATED — the guard banners INACTIVE iff the declared plugin is not installed (ADR-0022, recomputed)'
  : `\nNOT demonstrated — ${reasons.join('; ')}`);

mkdirSync(join(REPO, 'scenarios/records'), { recursive: true });
writeFileSync(join(REPO, 'scenarios/records/inactive-signal.json'), JSON.stringify(record, null, 2) + '\n');
console.log(`record → scenarios/records/inactive-signal.json (pluginVersion=${pluginVersion})`);
process.exit(demonstrated ? 0 : 1);

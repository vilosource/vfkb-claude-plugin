#!/usr/bin/env node
// ============================================================================
// /vfkb:brief L4 purpose scenario (vfkb ADR-0049 Layer 1 / ADR-0050 gate)
// ----------------------------------------------------------------------------
// Proves the PURPOSE of the /vfkb:brief skill THROUGH THE REAL PLUGIN SURFACE:
// a session that loads THIS plugin (--plugin-dir) and invokes /vfkb:brief gets
// a faithful session-start brief whose "what's next" is the brain's recorded
// handoff — produced by the plugin-shipped, HAIKU-PINNED briefer agent.
//
// CAUSAL DESIGN (only variable = the handoff behind the vendored engine):
//   - wired arm: sandbox git project whose .vfkb holds a handoff fact naming an
//     unguessable sentinel next-step (seeded via the VENDORED CLI);
//   - contrast arm: identical sandbox, brain WITHOUT the handoff — the brief
//     must say UNKNOWN, not fabricate (sentinel unguessable => contrast ≈ 0).
//
// OBSERVED, NOT ASSERTED (ADR-0029): a wired trial counts as a hit only if
//   (a) the brief names the sentinel, AND
//   (b) the run's modelUsage contains a *haiku* model — the outer session is
//       pinned to a NON-haiku model, so any haiku usage is attributable to the
//       skill's `context: fork` into agents/briefer.md (model: haiku). This
//       observes the Layer 1 cost pin instead of trusting frontmatter.
//
// VERDICT: DEMONSTRATED iff wired ≥ 2/3 AND wired > contrast (vfkb ADR-0022).
// LIVE + metered. One at a time.
//   node scenarios/brief-skill.mjs
//   VFKB_BS_TRIALS=1 node scenarios/brief-skill.mjs
// ============================================================================
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verdict } from './release-gate.mjs';

const REPO = resolve(process.argv[1], '../..');
const PLUGIN = join(REPO, 'plugin');
const CLI = join(PLUGIN, 'dist', 'bundles', 'vfkb.mjs');
const TRIALS = Math.max(1, parseInt(process.env.VFKB_BS_TRIALS || '3', 10));
// Outer session model: fixed NON-haiku so haiku-in-modelUsage can only be the fork.
const OUTER_MODEL = process.env.VFKB_BS_OUTER_MODEL || 'claude-sonnet-5';
const TIMEOUT = parseInt(process.env.VFKB_BS_TIMEOUT || '300000', 10);

const SENTINEL = 'copperlark-echo-31';
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', ...o });

function buildSandbox(withHandoff) {
  const dir = mkdtempSync(join(tmpdir(), 'vfkb-bs-'));
  sh('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, '.vfkb'));
  writeFileSync(join(dir, 'src', 'main.ts'), 'export const main = () => 0;\n');
  sh('git', ['add', '-A'], { cwd: dir });
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'chore: scaffold'], { cwd: dir });
  const env = { ...process.env, VFKB_DATA_DIR: join(dir, '.vfkb') };
  const add = (type, text, tags) =>
    sh('node', [CLI, 'add', type, text, '--role', 'human', '--prov-status', 'verified',
        ...(tags ? ['--tag', tags] : [])], { env, stdio: 'ignore' });
  if (withHandoff) {
    add('fact',
      `HANDOFF: ingest refactor shipped and verified end-to-end. The single next step for the ` +
      `next session is the migration codenamed ${SENTINEL}; keep the feature flag off until the ` +
      `backfill verifier reports clean. Everything else is blocked behind it.`,
      'handoff,next,status');
  }
  add('gotcha', 'shard workers must drain before the schema lock is released');
  return dir;
}

function runArm(dir) {
  let raw = '';
  let err = '';
  try {
    raw = sh('claude', ['-p', '/vfkb:brief', '--plugin-dir', PLUGIN, '--output-format', 'json',
      '--strict-mcp-config', '--dangerously-skip-permissions', '--model', OUTER_MODEL], {
      cwd: dir,
      timeout: TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    err = String(e.stderr || e.message || '').replace(/\s+/g, ' ').slice(0, 160);
    raw = String(e.stdout || '');
  }
  let text = '';
  let models = [];
  try {
    const j = JSON.parse(raw);
    text = String(j.result ?? '');
    models = Object.keys(j.modelUsage ?? {});
  } catch {
    text = raw;
  }
  const sentinel = text.toLowerCase().includes(SENTINEL);
  const haiku = models.some((m) => m.toLowerCase().includes('haiku'));
  return { sentinel, haiku, models, out: text.replace(/\s+/g, ' ').slice(0, 110), err };
}

console.log(`vfkb-claude-plugin brief-skill L4  (outer=${OUTER_MODEL}, trials=${TRIALS})`);
console.log('wired hit = sentinel in brief AND haiku observed in modelUsage (the fork pin)\n');

// Record shape v2 (RFC-024 §2a): each arm declares its role and the predicate
// its trials are judged on, and carries the raw per-trial observations. The
// verdict is never written down — the gate recomputes it from these trials, so
// a hand-edited pass count cannot smuggle a release through.
const arms = {
  wired: { role: 'positive', predicate: ['sentinel', 'haiku'], trials: [] },
  contrast: { role: 'contrast', predicate: ['sentinel'], trials: [] },
};
for (let t = 1; t <= TRIALS; t++) {
  for (const arm of ['wired', 'contrast']) {
    const dir = buildSandbox(arm === 'wired');
    process.stdout.write(`  trial ${t}  ${arm.padEnd(9)} … `);
    const r = runArm(dir);
    rmSync(dir, { recursive: true, force: true });
    arms[arm].trials.push(r);
    const tag = arm === 'wired'
      ? (r.sentinel && r.haiku ? 'HIT' : `miss (sentinel=${r.sentinel} haiku=${r.haiku})`)
      : (r.sentinel ? 'LEAK' : 'clean');
    console.log(`${tag}  models=[${r.models}]  — "${r.out}"${r.err ? '  ERR:' + r.err : ''}`);
  }
}

const pluginVersion = JSON.parse(
  readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'),
).version;
const record = {
  scenario: 'brief-skill', recordVersion: 2, pluginVersion, outerModel: OUTER_MODEL,
  trials: TRIALS, generated: new Date().toISOString(), arms,
};

// Judge with the gate's own function, so the runner and the Brake can never
// disagree about what DEMONSTRATED means.
const { ok: demonstrated, reasons } = verdict(record);
const wiredN = arms.wired.trials.filter((r) => r.sentinel && r.haiku).length;
const contrastN = arms.contrast.trials.filter((r) => r.sentinel).length;
console.log(`\nwired: ${wiredN}/${TRIALS} (sentinel+haiku)   |   contrast leaks: ${contrastN}/${TRIALS}`);
console.log(demonstrated
  ? `DEMONSTRATED — /vfkb:brief briefs from the handoff on the pinned haiku fork (ADR-0022, recomputed)`
  : `NOT demonstrated — ${reasons.join('; ')}`);

mkdirSync(join(REPO, 'scenarios/records'), { recursive: true });
writeFileSync(join(REPO, 'scenarios/records/brief-skill.json'), JSON.stringify(record, null, 2) + '\n');
console.log(`record → scenarios/records/brief-skill.json (pluginVersion=${pluginVersion})`);
process.exit(demonstrated ? 0 : 1);

#!/usr/bin/env node
// ============================================================================
// compaction-survival L4 — vfkb ADR-0077 clause 3, as amended by ADR-0078.
//
// CLAIM: after a compaction, the shipped plugin re-injects the Constitution and
// the pinned handoff (via SessionStart source:"compact"), and the agent can
// name both. CAN-FAIL ARM: the identical plugin with SessionStart matched to
// "startup" only. Summary luck is closed by /compact instructions plus a
// noLeak check; tool reads are closed by --tools "" --strict-mcp-config plus a
// noToolUse check.
//
// SINGLE VARIABLE: the bytes of hooks.json. Both arms are REAL marketplace
// installs (`claude plugin marketplace add <dir>` + `install`, sandboxed HOME —
// not --plugin-dir, ADR-0051). The contrast installs a temp copy of this
// checkout whose only difference is the matcher; the scenario asserts that.
//
// VALIDITY and SCORING live in compaction-survival-score.mjs, shared with the
// release gate, which recomputes every verdict from the recorded booleans.
// An invalid trial (no compaction, a failed compaction, a refusal, a timeout,
// host sleep, a summary leak, a tool use) is never a hit or a miss. Up to
// ATTEMPT_CAP attempts per arm are made to reach MIN_VALID valid trials.
//
// RUN REQUIREMENTS (ADR-0078): the host must not sleep (caffeinate -i when
// available; `awake` catches it otherwise); each message is sent only after the
// previous result; the stream goes to a file as it arrives; each trial has a
// hard monotonic timeout and its process group is killed on expiry.
//
// LIVE + metered. One at a time.
//   node scenarios/compaction-survival.mjs
// ============================================================================
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashTree } from './release-gate.mjs';
import { stageAuth, authEnv, producedBy, assertAuthReady, sandboxEnv, redactSecrets } from './auth.mjs';
import {
  scoreTrial, isValid, compactedHit, contrastHit, compactionSurvivalReasons, MIN_VALID, ATTEMPT_CAP, VALIDITY,
} from './compaction-survival-score.mjs';

const REPO = resolve(process.argv[1], '../..');
const PLUGIN = join(REPO, 'plugin');
const CLI = join(PLUGIN, 'dist', 'bundles', 'vfkb.mjs');
const MODEL = process.env.VFKB_CS_MODEL || 'claude-haiku-4-5-20251001';
const TRIAL_TIMEOUT_MS = parseInt(process.env.VFKB_CS_TIMEOUT || '600000', 10);
// vfkb ADR-0079: instruct the summariser by SCOPE, never by naming what to hide. The
// /compact arguments are replayed verbatim into the post-compaction context, so an
// instruction to "omit every code word" is read by the agent as "do not reveal code
// words" (observed: compacted arm 1/3 with it, 3/3 without). noLeak still guards luck.
const COMPACT = process.env.VFKB_CS_COMPACT || '/compact Summarise only the fruit, river and mountain lists the user asked for.';
const EXCHANGES = ['Reply with the single word OK.', 'Name three fruits, one per line.', 'Name three rivers, one per line.', 'Name three mountains, one per line.'];
// Ask for exactly what the claim is about: the Constitution's code word AND the handoff's
// codename. "code words" alone did not cover the handoff (ADR-0079).
const QUESTION = process.env.VFKB_CS_QUESTION || "Quote your Constitution's vault code word and your last handoff's migration codename. Reply with only those two values, or NONE if you do not have them.";
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', ...o });
const hasCaffeinate = spawnSync('sh', ['-c', 'command -v caffeinate'], { encoding: 'utf8' }).status === 0;

assertAuthReady();

/** Random, >= 8 chars, letters and digits (ADR-0078). */
const sentinel = (word) => `${word}${randomBytes(3).toString('hex').replace(/[0-9]/g, '')}${1000 + Math.floor(Math.random() * 9000)}`;

/** Marketplace source for an arm: this checkout, or a temp copy with SessionStart matched to startup. */
function sourceFor(arm, root) {
  if (arm === 'compacted') return REPO;
  const src = join(root, 'plugin-src');
  cpSync(REPO, src, { recursive: true, filter: (p) => !/\/(\.git|node_modules)(\/|$)/.test(p) });
  const hj = join(src, 'plugin', 'hooks', 'hooks.json');
  const h = JSON.parse(readFileSync(hj, 'utf8'));
  const g = h.hooks.SessionStart.find((x) => x.hooks.some((k) => /hook session-start/.test(k.command)));
  g.matcher = 'startup';
  writeFileSync(hj, JSON.stringify(h, null, 2));
  return src;
}

function buildSandbox(arm, sentinels) {
  const root = mkdtempSync(join(tmpdir(), 'vfkb-cs-'));
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(proj, '.vfkb'), { recursive: true });
  stageAuth(home);
  sh('git', ['init', '-q'], { cwd: proj });
  sh('git', ['config', 'user.name', 'compaction-survival'], { cwd: proj });
  sh('git', ['config', 'user.email', 'cs@sandbox.local'], { cwd: proj });
  const env = { ...process.env, VFKB_DATA_DIR: join(proj, '.vfkb') };
  sh('node', [CLI, 'add', 'decision', `PROBE CONSTITUTION: every reply about vaults must use the code word ${sentinels[0]}.`,
    '--why', 'compaction-survival sentinel', '--status', 'accepted', '--constitutional', '--role', 'human'], { env, stdio: 'ignore' });
  sh('node', [CLI, 'add', 'fact', `HANDOFF: the single next step is the migration codenamed ${sentinels[1]}.`,
    '--role', 'human', '--prov-status', 'verified', '--tag', 'handoff,next'], { env, stdio: 'ignore' });
  writeFileSync(join(proj, 'README.md'), 'compaction-survival sandbox\n');
  sh('git', ['add', '-A'], { cwd: proj });
  sh('git', ['commit', '-qm', 'scaffold'], { cwd: proj });
  sh('git', ['checkout', '-qb', 'work'], { cwd: proj });

  const source = sourceFor(arm, root);
  const cenv = authEnv(sandboxEnv(process.env, home));
  sh('claude', ['plugin', 'marketplace', 'add', source], { env: cenv, stdio: 'ignore', timeout: 120000 });
  sh('claude', ['plugin', 'install', 'vfkb@vfkb', '--scope', 'user'], { env: cenv, stdio: 'ignore', timeout: 120000 });
  // Single-variable assertion: the INSTALLED hooks.json carries the arm's matcher.
  const installed = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
  const ip = Object.values(installed.plugins || {}).flat()[0]?.installPath;
  const ss = JSON.parse(readFileSync(join(ip, 'hooks', 'hooks.json'), 'utf8')).hooks.SessionStart
    .find((x) => x.hooks.some((k) => /hook session-start/.test(k.command)));
  const want = arm === 'compacted' ? undefined : 'startup';
  if (ss.matcher !== want) throw new Error(`arm ${arm}: installed SessionStart matcher is ${JSON.stringify(ss.matcher)}, expected ${JSON.stringify(want)}`);

  // Observation hooks: print nothing beyond {} (their stdout is replayed into context).
  const log = join(root, 'hooks.jsonl');
  const logger = join(root, 'log.sh');
  writeFileSync(logger, `#!/bin/sh\nprintf '{"ev":"%s","payload":%s}\\n' "$1" "$(cat)" >> "${log}"\necho '{}'\n`, { mode: 0o755 });
  mkdirSync(join(proj, '.claude'), { recursive: true });
  const L = (ev) => [{ hooks: [{ type: 'command', command: `"${logger}" ${ev}` }] }];
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreCompact: L('PreCompact'), PostCompact: L('PostCompact') } }));
  return { root, home, proj, log, env: cenv };
}

/** One trial: messages paced on results, stream to file, monotonic timeout, process-group kill. */
function runTrial(arm) {
  const sentinels = [sentinel('quartz'), sentinel('harbor')];
  const sb = buildSandbox(arm, sentinels);
  const messages = [...EXCHANGES, COMPACT, QUESTION];
  const compactIndex = EXCHANGES.length;
  const streamFile = join(sb.root, 'stream.jsonl');
  const out = createWriteStream(streamFile);
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--strict-mcp-config', '--model', MODEL];
  const [cmd, cargs] = hasCaffeinate ? ['caffeinate', ['-i', 'claude', ...args]] : ['claude', args];
  const wall0 = Date.now();
  const mono0 = process.hrtime.bigint();
  return new Promise((done) => {
    const child = spawn(cmd, cargs, { cwd: sb.proj, env: sb.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [];
    let sent = 0;
    let buf = '';
    let stderr = '';
    let finished = false;
    const send = () => {
      if (sent < messages.length) {
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: messages[sent] } }) + '\n');
        sent++;
      } else child.stdin.end();
    };
    const finish = (timedOut) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      out.end();
      const wallMs = Date.now() - wall0;
      const monoMs = Number(process.hrtime.bigint() - mono0) / 1e6;
      const hookLog = existsSync(sb.log)
        ? readFileSync(sb.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        : [];
      const scored = scoreTrial({ events, hookLog, sentinels, sent: messages.length, compactIndex, timedOut, wallMs, monoMs });
      if (process.env.VFKB_CS_KEEP) console.error(`\n  kept ${sb.root}`); else rmSync(sb.root, { recursive: true, force: true });
      done({ ...scored, sentinels, timedOut, wallMs: Math.round(wallMs), monoMs: Math.round(monoMs),
        err: redactSecrets(stderr).replace(/\s+/g, ' ').slice(0, 200) });
    };
    const timer = setTimeout(() => finish(true), TRIAL_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      out.write(d);
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        events.push(e);
        if (e.type === 'result') {
          if (sent < messages.length) send();
          else finish(false); // the final question's result: score now, never wait on exit
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', () => finish(false));
    send();
  });
}

// --- drive: attempts until MIN_VALID valid trials per arm, capped -------------
console.log(`vfkb-claude-plugin compaction-survival  (model=${MODEL}, ${MIN_VALID} valid trials per arm, cap ${ATTEMPT_CAP}, caffeinate=${hasCaffeinate})`);
const arms = {
  compacted: { role: 'positive', attempts: [] },
  contrast: { role: 'contrast', attempts: [] },
};
if (process.env.VFKB_CS_DIAG) {
  const t = await runTrial(process.env.VFKB_CS_DIAG);
  console.log(JSON.stringify(t, null, 1));
  process.exit(0);
}
for (const arm of ['compacted', 'contrast']) {
  while (arms[arm].attempts.filter(isValid).length < MIN_VALID && arms[arm].attempts.length < ATTEMPT_CAP) {
    const n = arms[arm].attempts.length + 1;
    process.stdout.write(`  ${arm.padEnd(9)} attempt ${n} … `);
    const t = await runTrial(arm);
    arms[arm].attempts.push(t);
    const invalid = VALIDITY.filter((k) => !t[k]);
    const verdict = invalid.length ? `INVALID [${invalid}]`
      : arm === 'compacted' ? (compactedHit(t) ? 'HIT' : 'miss') : (contrastHit(t) ? 'LEAK' : 'clean');
    console.log(`${verdict}  emitted=${t.emitted ? 1 : 0} received=${t.received ? 1 : 0} any=${t.receivedAny ? 1 : 0}  answer=${JSON.stringify(t.finalAnswer.slice(0, 60))}${t.err ? '  ERR:' + t.err : ''}`);
  }
}

const pluginVersion = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const cliVersion = sh('claude', ['--version']).match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
const record = {
  scenario: 'compaction-survival', recordVersion: 2, pluginVersion,
  pluginTreeHash: hashTree(PLUGIN), outerModel: MODEL, cliVersion,
  producedBy: producedBy(REPO), generated: new Date().toISOString(),
  trigger: 'manual',   // auto-compaction is NOT exercised (ADR-0077 Consequences)
  arms,
};
const reasons = compactionSurvivalReasons(record);
console.log(reasons.length ? `\nNOT demonstrated — ${reasons.join('; ')}`
  : '\nDEMONSTRATED — the shipped plugin re-injects the Constitution and handoff pin after a real manual compaction; the startup-only contrast does not (recomputed)');
mkdirSync(join(REPO, 'scenarios', 'records'), { recursive: true });
writeFileSync(join(REPO, 'scenarios', 'records', 'compaction-survival.json'), JSON.stringify(record, null, 2) + '\n');
console.log(`record → scenarios/records/compaction-survival.json (pluginVersion=${pluginVersion}, cli=${cliVersion})`);
process.exit(reasons.length ? 1 : 0);

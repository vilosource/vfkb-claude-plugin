#!/usr/bin/env node
// ============================================================================
// One-command release wrapper (vfkb roadmap P11-a — "build the thing that
// builds the thing": automate the mechanics · multiply the adversaries ·
// never fabricate the evidence).
// ----------------------------------------------------------------------------
// RELEASING.md is a six-step hand-crank run once per engine change, and every
// engine change re-pins FOUR metered L4 records. The choreography around those
// runs is pure mechanics — deterministic, repeatable, judgment-free — so it is
// automated to zero here. The runs themselves are EVIDENCE: this script
// INVOKES them and never fakes, infers, or shortcuts a verdict.
//
// WHAT THIS DOES NOT DO, deliberately:
//   * It does not compute whether a record is DEMONSTRATED. It imports
//     `verdict()` from release-gate.mjs — the gate's own recompute. A second
//     implementation would drift from the gate, and the drift would silently
//     favour shipping. Same for `treeBindingReasons()` and `checkVersionBump()`.
//   * It does not write, edit, or synthesise a record. Records come only from
//     the scenario processes. `--dry-run` writes nothing at all.
//   * It does not decide WHO VOUCHES for a release. Moving the metered runs off
//     the operator's machine is RFC-036, a constitutional decision, not a flag.
//
// ORDERING IS LOAD-BEARING (verified, not assumed):
//   `install-path` resolves `owner/repo@<branch>` for a REAL install and its
//   record is tree-bound via `pluginTreeHash` to the shipping `plugin/` tree.
//   So the tree must be FINAL and PUSHED before any L4 runs. Records live under
//   scenarios/, which is not release surface, so committing them afterwards does
//   not disturb the binding. Hence: vendor+bump -> commit+push -> L4s -> records.
//   Running the L4s before the push binds them to a tree nobody can install, and
//   wastes ~12 metered sessions.
//
// RESUMABLE: a scenario whose record is already pinned to the target version AND
// still tree-binding is skipped. An expired token halfway through therefore costs
// only the remaining arms, not the green ones.
//
// Usage:
//   node scenarios/release.mjs --dry-run     # plan only; writes nothing
//   node scenarios/release.mjs               # full release
//   node scenarios/release.mjs --only install-path
//   node scenarios/release.mjs --skip-merge  # stop after gates green
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verdict, treeBindingReasons, runGate } from './release-gate.mjs';
import { checkVersionBump, tagFor } from './version-bump.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VFKB_SRC = process.env.VFKB_SRC || resolve(REPO, '..', 'vfkb');
const REMOTE = 'vilosource/vfkb-claude-plugin';

// The four records the release needs. `install-path` is the delivery proof and
// is the only tree-bound one (issues #22/#28) — see treeBindingReasons.
const SCENARIOS = ['brief-skill', 'hooks-smoke', 'inactive-signal', 'install-path'];
const TREE_BOUND = new Set(['install-path']);
// Vendored engine bundles — the plugin ships this subset (the pi package ships more).
const BUNDLES = ['vfkb.mjs', 'vfkb-mcp.mjs'];

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const SKIP_MERGE = argv.includes('--skip-merge');
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined;

const log = (m) => console.log(m);
const step = (n, m) => console.log(`\n── ${n} ── ${m}`);
const ok = (m) => console.log(`   ✓ ${m}`);
const info = (m) => console.log(`   · ${m}`);

/** Fail loudly and name the remedy. Never let the caller mistake this for a pass. */
function die(what, fix) {
  console.error(`\nRELEASE ABORTED: ${what}`);
  if (fix) console.error(`  fix: ${fix}`);
  process.exit(1);
}

const git = (args, cwd = REPO) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pluginJsonPath = () => join(REPO, 'plugin', '.claude-plugin', 'plugin.json');
const pluginVersion = () => readJson(pluginJsonPath()).version;

/** Run a child process, streaming its output. Returns its exit status. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit', ...opts });
  return r.status ?? 1;
}

// ---------------------------------------------------------------------------
// 0 — Pre-flight. Fail fast and NAME the missing thing; a release that dies 40
//     minutes in on a missing credential has wasted metered sessions.
// ---------------------------------------------------------------------------
function preflight() {
  step('0/6', 'pre-flight');

  if (!existsSync(join(REPO, 'plugin'))) die(`${REPO} is not the plugin repo`, 'run from vfkb-claude-plugin');
  if (!existsSync(VFKB_SRC)) die(`vfkb source not found at ${VFKB_SRC}`, 'set $VFKB_SRC to your vfkb checkout');
  ok(`plugin repo ${REPO}`);
  ok(`vfkb source ${VFKB_SRC}`);

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'main') {
    die('on main — a release is cut on a branch, never on main', 'git checkout re-vendor/engine');
  }
  ok(`branch ${branch}`);

  const dirty = git(['status', '--porcelain']);
  if (dirty && !DRY) {
    die(`working tree is dirty:\n${dirty}`, 'commit or stash first — the release commits specific paths');
  }
  if (dirty && DRY) info('working tree dirty (dry-run tolerates it)');

  // Credentials for the metered L4s. install-path additionally needs a real
  // github SSH key (it performs a genuine marketplace install).
  const oauth = join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(oauth)) {
    die('no ~/.claude/.credentials.json — the live L4s need Claude Code OAuth',
        'log in with the host `claude` first (CI cannot run these: RFC-036)');
  }
  let hasOauth = false;
  try {
    hasOauth = !!readJson(oauth).claudeAiOauth;
  } catch { /* unreadable → treated as absent below */ }
  if (!hasOauth) die('~/.claude/.credentials.json has no claudeAiOauth block', 'log in with the host `claude`');
  ok('claude OAuth present');

  const sshKeys = ['id_ed25519', 'id_rsa'].map((k) => join(homedir(), '.ssh', k));
  if (!sshKeys.some(existsSync)) {
    die('no github SSH key in ~/.ssh — install-path performs a real marketplace install',
        'add id_ed25519 or id_rsa');
  }
  ok('github ssh key present');

  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    ok('gh authenticated');
  } catch {
    die('gh is not authenticated', 'gh auth login');
  }

  return branch;
}

// ---------------------------------------------------------------------------
// 1 — Re-vendor. Idempotent: rebuild vfkb's bundles and copy them in, then
//     assert the drift detector agrees. Asserting is the point — copying files
//     proves nothing, a CLEAN comparison does.
// ---------------------------------------------------------------------------
function vendor() {
  step('1/6', 're-vendor the engine bundles');
  if (DRY) {
    info(`would: npm run build:bundles in ${VFKB_SRC}, copy ${BUNDLES.join(', ')} into plugin/dist/bundles/`);
  } else {
    if (run('npm', ['run', 'build:bundles'], { cwd: VFKB_SRC }) !== 0) die('vfkb bundle build failed');
    for (const b of BUNDLES) {
      const src = join(VFKB_SRC, 'dist', 'bundles', b);
      if (!existsSync(src)) die(`vfkb built no ${b}`, 'check scripts/build-bundles.mjs');
      writeFileSync(join(REPO, 'plugin', 'dist', 'bundles', b), readFileSync(src));
    }
    ok(`copied ${BUNDLES.length} bundles`);
  }

  // The drift detector is the authority on "are these the same engine", not a
  // byte-compare here — it normalises the version/commit stamps.
  const drift = spawnSync(
    'node',
    [join(VFKB_SRC, 'scripts', 'bundle-drift.mjs'), join(VFKB_SRC, 'dist', 'bundles'), join(REPO, 'plugin', 'dist', 'bundles')],
    { encoding: 'utf8' },
  );
  if (drift.status === 0) {
    ok('bundle-drift CLEAN — vendored engine matches vfkb main');
    return { willChange: false };
  }
  if (drift.status === 1 && DRY) {
    // DRY-RUN HONESTY. Dry-run does not copy, so plugin/ is untouched and every
    // downstream check would cheerfully report "nothing to do" — a plan that
    // under-reports the work it is planning. Drift here means the real run WILL
    // rewrite plugin/, which bumps the version and invalidates all four records
    // (the tree-bound one by hash, the rest by pluginVersion). Say so.
    info('bundle-drift reports DRIFT — the real run WILL rewrite plugin/');
    return { willChange: true };
  }
  if (drift.status === 1) die('bundle-drift still reports DRIFT after copying', 'inspect the bundles by hand');
  die(`bundle-drift comparison itself failed (rc=${drift.status}) — neither clean nor drift`);
}

// ---------------------------------------------------------------------------
// 2 — Version. The Brake decides, not this script: a shipped version is
//     immutable, so if plugin/ or templates/ differs from what the tag shipped,
//     the version is stale and must bump.
// ---------------------------------------------------------------------------
function version(willChange) {
  step('2/6', 'version Brake');
  const cur0 = pluginVersion();
  if (DRY && willChange) {
    const [a, b] = cur0.split('.');
    const projected = `${a}.${Number(b) + 1}.0`;
    info(`Brake reads current now, but plugin/ is about to change — it will go stale`);
    info(`would bump ${cur0} -> ${projected}`);
    return projected;
  }
  let r = checkVersionBump(REPO);
  if (r.ok) {
    ok(`version ${pluginVersion()} is current per the Brake`);
    return pluginVersion();
  }
  info(`Brake says stale: ${(r.failures ?? r.reasons ?? []).join('; ')}`);

  const cur = pluginVersion();
  const [maj, min] = cur.split('.');
  const next = `${maj}.${Number(min) + 1}.0`;
  if (DRY) {
    info(`would bump ${cur} -> ${next}`);
    return next;
  }
  const j = readJson(pluginJsonPath());
  j.version = next;
  writeFileSync(pluginJsonPath(), JSON.stringify(j, null, 2) + '\n');
  r = checkVersionBump(REPO);
  if (!r.ok) die(`still stale after bumping to ${next}: ${(r.failures ?? r.reasons ?? []).join('; ')}`,
                 'the Brake is telling you something real — read RELEASING.md "If the version Brake goes red"');
  ok(`bumped ${cur} -> ${next}`);
  return next;
}

// ---------------------------------------------------------------------------
// 3 — Publish the tree BEFORE the evidence runs. install-path installs
//     `owner/repo@<branch>` for real and binds its record to this exact
//     plugin/ tree, so the tree has to be final and reachable first.
// ---------------------------------------------------------------------------
function publishTree(branch, ver) {
  step('3/6', 'commit + push the shipping tree (must precede the L4s)');
  const pending = git(['status', '--porcelain', '--', 'plugin', 'templates']);
  if (!pending) {
    ok('shipping tree already committed');
  } else if (DRY) {
    info(`would commit + push:\n${pending}`);
  } else {
    const sha = (() => { try { return git(['rev-parse', '--short', 'HEAD'], VFKB_SRC); } catch { return 'unknown'; } })();
    git(['add', '--', 'plugin', 'templates']);
    git(['commit', '-q', '-m', `chore: re-vendor engine bundles from vfkb main@${sha} — v${ver}`]);
    ok('committed');
  }
  if (DRY) { info(`would push ${branch}`); return; }
  if (run('git', ['push', '-q', 'origin', branch]) !== 0) die(`could not push ${branch}`);
  ok(`pushed ${branch} — the ref install-path will resolve`);
}

// ---------------------------------------------------------------------------
// 4 — Evidence. INVOKE the metered scenarios; verify each with the GATE's own
//     recompute. Never trust a record's self-report, never write one here.
// ---------------------------------------------------------------------------
function recordPath(slug) {
  return join(REPO, 'scenarios', 'records', `${slug}.json`);
}

/** Is this record already valid for `ver`? Uses the gate's own checks. */
function recordSatisfies(slug, ver) {
  const p = recordPath(slug);
  if (!existsSync(p)) return { valid: false, why: 'no record' };
  let rec;
  try { rec = readJson(p); } catch (e) { return { valid: false, why: `unparseable: ${e.message}` }; }
  if (rec.pluginVersion !== ver) return { valid: false, why: `pinned to ${rec.pluginVersion}, need ${ver}` };
  const v = verdict(rec);
  if (!v.ok) return { valid: false, why: `not DEMONSTRATED: ${v.reasons.join('; ')}` };
  if (TREE_BOUND.has(slug)) {
    const tb = treeBindingReasons(REPO, rec, slug);
    if (tb.length) return { valid: false, why: tb.join('; ') };
  }
  return { valid: true };
}

function evidence(ver, willChange) {
  step('4/6', `re-pin the L4 evidence against v${ver} (metered, live)`);
  const todo = [];
  for (const slug of SCENARIOS) {
    if (ONLY && slug !== ONLY) { info(`${slug}: skipped (--only ${ONLY})`); continue; }
    // In dry-run with pending vendor changes, today's records describe a tree and
    // a version that will not exist by the time the L4s run — so evaluating them
    // as-is would report a false "already valid".
    const s = DRY && willChange
      ? { valid: false, why: `will be invalidated by the pending re-vendor (v${ver}, new plugin/ tree)` }
      : recordSatisfies(slug, ver);
    if (s.valid) ok(`${slug}: record already valid for v${ver} — skipping (resumable)`);
    else { info(`${slug}: needs a run (${s.why})`); todo.push(slug); }
  }
  if (!todo.length) { ok('all records already valid'); return; }

  if (DRY) {
    info(`would run, one at a time: ${todo.join(', ')}`);
    info('(these are the metered, credentialed runs — dry-run never invokes them)');
    return;
  }

  for (const slug of todo) {
    log(`\n   ▶ running ${slug} (metered — this is a real agent session)`);
    const status = run('node', [join(REPO, 'scenarios', `${slug}.mjs`)]);
    if (status !== 0) die(`${slug} exited ${status}`, `re-run: node scenarios/${slug}.mjs`);
    // The scenario writing a record is NOT evidence it passed. Recompute.
    const s = recordSatisfies(slug, ver);
    if (!s.valid) {
      die(`${slug} produced a record that does NOT satisfy the gate: ${s.why}`,
          'this is a real failure — do not re-run hoping for green; read the record');
    }
    ok(`${slug}: DEMONSTRATED, recomputed from per-trial observations`);
  }
}

// ---------------------------------------------------------------------------
// 5 — Deterministic gates, locally, so a red is a local red first.
// ---------------------------------------------------------------------------
function gates() {
  step('5/6', 'deterministic gates');
  for (const t of ['release-gate.selftest.mjs', 'version-bump.selftest.mjs', 'guard-branches.test.mjs']) {
    const p = join(REPO, 'scenarios', t);
    if (!existsSync(p)) continue;
    if (run('node', [p], { stdio: 'ignore' }) !== 0) die(`${t} failed`, `node scenarios/${t}`);
    ok(t);
  }
  const g = runGate(REPO);
  if (g.failures.length) {
    console.error('\n   release-gate failures:');
    for (const f of g.failures) console.error(`     - ${f}`);
    die('release gate is RED');
  }
  ok(`release-gate PASSED (v${g.version})`);
  const v = checkVersionBump(REPO);
  if (!v.ok) die(`version Brake RED: ${(v.failures ?? v.reasons ?? []).join('; ')}`);
  ok('version Brake PASSED');
}

// ---------------------------------------------------------------------------
// 6 — Land it: commit records, push, wait for CI, merge, verify the tag.
// ---------------------------------------------------------------------------
function land(branch, ver) {
  step('6/6', 'land the release');
  const pending = git(['status', '--porcelain', '--', 'scenarios/records']);
  if (pending && !DRY) {
    git(['add', '--', 'scenarios/records']);
    git(['commit', '-q', '-m', `chore: re-pin L4 evidence for v${ver}`]);
    ok('committed records');
  } else if (pending) {
    info(`would commit records:\n${pending}`);
  } else ok('records already committed');

  if (DRY) {
    info(`would push, wait for CI, squash-merge the PR for ${branch}, verify ${tagFor('vfkb', ver)}`);
    return { landed: false, why: 'dry-run' };
  }
  if (run('git', ['push', '-q', 'origin', branch]) !== 0) die(`could not push ${branch}`);
  ok('pushed');

  if (SKIP_MERGE) { info('--skip-merge: stopping before merge'); return { landed: false, why: '--skip-merge' }; }

  const pr = execFileSync('gh', ['pr', 'list', '-R', REMOTE, '--head', branch, '--state', 'open', '--json', 'number', '-q', '.[0].number'], { encoding: 'utf8' }).trim();
  if (!pr) die(`no open PR for ${branch}`, `gh pr create -R ${REMOTE} --head ${branch}`);
  info(`PR #${pr} — waiting for required checks`);

  const sha = git(['rev-parse', 'HEAD']);
  for (let i = 0; i < 40; i++) {
    const raw = execFileSync('gh', ['api', `repos/${REMOTE}/commits/${sha}/check-runs`, '--jq', '[.check_runs[]|{name,status,conclusion}]'], { encoding: 'utf8' });
    const runs = JSON.parse(raw || '[]');
    const pendingRuns = runs.filter((r) => r.status !== 'completed');
    if (runs.length >= 1 && !pendingRuns.length) {
      const bad = runs.filter((r) => r.conclusion !== 'success' && r.conclusion !== 'neutral' && r.conclusion !== 'skipped');
      if (bad.length) die(`CI red: ${bad.map((b) => `${b.name}=${b.conclusion}`).join(', ')}`);
      ok(`CI green (${runs.length} checks)`);
      break;
    }
    if (i === 39) die('timed out waiting for CI');
    execFileSync('sleep', ['20']);
  }

  if (run('gh', ['pr', 'merge', pr, '-R', REMOTE, '--squash']) !== 0) die(`could not merge PR #${pr}`);
  ok(`merged PR #${pr}`);

  // The tag creates itself (ADR-0061). Verify it — observed, not assumed.
  const want = tagFor('vfkb', ver);
  for (let i = 0; i < 15; i++) {
    const tags = execFileSync('git', ['ls-remote', '--tags', `https://github.com/${REMOTE}.git`], { encoding: 'utf8' });
    if (tags.includes(want)) { ok(`tag ${want} created by CI`); return { landed: true }; }
    execFileSync('sleep', ['20']);
  }
  die(`tag ${want} did not appear`, 'check .github/workflows/release-tag.yml on main');
}

// ---------------------------------------------------------------------------
const branch = preflight();
const { willChange } = vendor();
const ver = version(willChange);
publishTree(branch, ver);
evidence(ver, willChange);
gates();
const landing = land(branch, ver);

if (DRY) {
  console.log(`\nDRY RUN complete — nothing was written, invoked, or merged. Target version: ${ver}`);
} else if (landing?.landed) {
  console.log(
    `\nRELEASE COMPLETE — v${ver} merged and tagged ${tagFor('vfkb', ver)} (tag observed, not assumed).` +
      `\nOutward effect: marketplace consumers resolve this tag on their next plugin update.`,
  );
} else {
  console.log(
    `\nEVIDENCE COMPLETE, NOT RELEASED — v${ver} records are re-pinned and the gates are green,` +
      `\nbut the PR was NOT merged and ${tagFor('vfkb', ver)} does NOT exist (${landing?.why ?? 'unknown'}).` +
      `\nFinish with: node scenarios/release.mjs   (or merge the PR by hand)`,
  );
}

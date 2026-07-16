#!/usr/bin/env node
// ============================================================================
// install-path L4 — the DELIVERY proof (vfkb ADR-0051 / RFC-024 §4)
// ----------------------------------------------------------------------------
// Proves the capability that every other L4 assumes but none exercises: that a
// consumer can INSTALL and UPGRADE this plugin through the REAL github-sourced,
// versioned marketplace path and get a working capability. The other scenarios
// load the plugin from a source tree (--plugin-dir) or a directory-source
// marketplace over the local checkout — both bypass the version cache and the
// upgrade path (ADR-0051). This one does not: it resolves `vilosource/
// vfkb-claude-plugin` as a github marketplace, installs a released version, and
// upgrades between versions. Its committed record is the ONLY thing that flips
// DELIVERY-STATUS.json from `unproven` to `proven` (release-gate.mjs).
//
// HONESTY (issue #22): every arm installs from the marketplace PINNED TO THE
// REF UNDER TEST (default: the current pushed branch), never bare `main` — on a
// release branch those are different trees, and a record must not claim a
// version whose tree it did not test. This is OBSERVED, not assumed: each
// positive arm content-asserts that the tree the sandbox installed hashes
// identically to the local plugin/ tree, and the record carries that hash
// (`pluginTreeHash`), which the release gate re-derives against the shipping
// tree — so a stale record goes red even under an unchanged version string.
//
// The capability under test is `/vfkb:brief` (the Haiku-pinned briefing skill,
// present since v0.4.0). CAUSAL DESIGN — three arms:
//   - fresh    (positive): install the ref under test from the marketplace →
//                          /vfkb:brief works (sentinel from the seeded handoff
//                          AND a haiku model in modelUsage = the briefer fork),
//                          AND the installed tree == the local tree.
//   - upgrade  (positive): install the newest release that LACKS /vfkb:brief
//                          (resolved dynamically as a tag, not a rotting SHA) →
//                          capability ABSENT → advance the marketplace clone +
//                          `plugin update` → capability PRESENT. Proves the
//                          upgrade path DELIVERS a new capability, not just that
//                          it was always there.
//   - contrast (can-fail): install the CURRENT release but with /vfkb:brief
//                          REMOVED from the resolved tree → ABSENT. If install
//                          delivered it anyway (a pre-cache leak) this arm leaks
//                          → red. This is the proof that can fail.
//
// OBSERVED, NOT ASSERTED (ADR-0029/0051 — content over exit codes). A capability
// "present" hit = the /vfkb:brief turn names the unguessable handoff SENTINEL
// AND a *haiku* model appears in modelUsage (the outer session is pinned to a
// NON-haiku model, so haiku is attributable only to the briefer fork). Neither
// exit code nor is_error is trusted — a missing capability presents as a clean
// exit-0 run (the ADR-0051 quiet-success trap).
//
// MECHANICS + TRAPS (proven hermetically 2026-07-16, vfkb gotcha af28bde8edf3):
//   - the github marketplace clone is SHALLOW → rewinding needs
//     `git fetch --unshallow` first.
//   - the contrast arm must delete BOTH plugin/skills/brief AND
//     plugin/agents/briefer.md, else the Haiku briefer stays Task-spawnable and
//     forges a haiku modelUsage entry.
//   - `marketplace add` PRE-CACHES the latest version; the contrast arm nukes
//     the cache dir before install so install re-copies the modified tree.
//   - `plugin update` prints "Restart to apply"; on-disk installPath flips
//     immediately, and a fresh `claude -p` (our post-turn) is a new process.
//
// PRECONDITION (not fully hermetic on the git dimension): `marketplace add
// owner/repo` clones over SSH (`git@github.com:…`), and OpenSSH resolves `~`
// via getpwuid(), IGNORING the sandbox's `$HOME` — so the clone uses the
// INVOKING user's REAL `~/.ssh`. This run therefore requires the real user to
// have a github SSH key with read access to vilosource/vfkb-claude-plugin AND
// `github.com` in `~/.ssh/known_hosts`. It is reproducible on the operator's
// machine; a keyless CI runner would need HTTPS or a pre-seeded key. A failed
// clone yields a SETUP miss (never a false proof).
//
// VERDICT: DEMONSTRATED iff BOTH positive arms hit >=2/3 AND the contrast arm
// leaks <=1/3 (vfkb ADR-0022), recomputed by the release gate's own verdict().
// LIVE + metered (~12 sessions/run: fresh 1 + upgrade 2 + contrast 1, x3). One
// at a time.  node scenarios/install-path.mjs   |   VFKB_IP_TRIALS=1 node …
// ============================================================================
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { verdict, hashTree } from './release-gate.mjs';

const REPO = resolve(process.argv[1], '../..');
const PLUGIN = join(REPO, 'plugin');
const CLI = join(PLUGIN, 'dist', 'bundles', 'vfkb.mjs');
const MARKETPLACE = 'vilosource/vfkb-claude-plugin';
const TRIALS = Math.max(1, parseInt(process.env.VFKB_IP_TRIALS || '3', 10));
// Outer session model: fixed NON-haiku so haiku-in-modelUsage can only be the
// briefer fork (same discriminator as brief-skill.mjs).
const OUTER_MODEL = process.env.VFKB_IP_OUTER_MODEL || 'claude-sonnet-5';
const TIMEOUT = parseInt(process.env.VFKB_IP_TIMEOUT || '300000', 10);
const SETUP_TIMEOUT = parseInt(process.env.VFKB_IP_SETUP_TIMEOUT || '120000', 10);

const SENTINEL = 'ironquill-nimbus-84';
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', ...o });
const homeEnv = (home) => ({ ...process.env, HOME: home });

// --- resolve "the newest release that predates /vfkb:brief" as a durable tag --
// (ADR-0060 tags make this stable; a hardcoded SHA would rot at the next release.)
function prevReleaseWithoutBrief() {
  const tags = sh('git', ['tag', '--sort=-v:refname'], { cwd: REPO })
    .split('\n').map((s) => s.trim()).filter((t) => /^vfkb--v/.test(t));
  for (const t of tags) {
    const tree = sh('git', ['ls-tree', '-r', '--name-only', t], { cwd: REPO });
    if (!/plugin\/skills\/brief\//.test(tree)) return t;
  }
  throw new Error('no release tag predates /vfkb:brief — cannot model an upgrade that adds it');
}

// --- credentials: the Claude-Code Max OAuth block only (ADR-0022 §8) ---------
function stageCreds(homeDir) {
  const all = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
  if (!all.claudeAiOauth) throw new Error('no claudeAiOauth block in ~/.claude/.credentials.json');
  const dir = join(homeDir, '.claude');
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, '.credentials.json');
  writeFileSync(dst, JSON.stringify({ claudeAiOauth: all.claudeAiOauth }));
  chmodSync(dst, 0o600);
}

// --- sandbox: isolated HOME + a seeded project repo on a topic branch --------
function buildSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'vfkb-ip-'));
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  stageCreds(home);

  mkdirSync(join(proj, '.vfkb'));
  sh('node', [CLI, 'add', 'fact',
    `HANDOFF: the delivery refactor shipped and verified end-to-end. The single next step is the ` +
    `migration codenamed ${SENTINEL}; everything else is blocked behind it.`,
    '--role', 'human', '--prov-status', 'verified', '--tag', 'handoff,next,status'],
    { env: { ...process.env, VFKB_DATA_DIR: join(proj, '.vfkb') }, stdio: 'ignore' });
  writeFileSync(join(proj, 'README.md'), 'install-path sandbox\n');
  sh('git', ['init', '-q'], { cwd: proj });
  sh('git', ['config', 'user.name', 'install-path'], { cwd: proj });
  sh('git', ['config', 'user.email', 'install-path@sandbox.local'], { cwd: proj });
  sh('git', ['add', '-A'], { cwd: proj });
  sh('git', ['commit', '-qm', 'chore: scaffold'], { cwd: proj });
  sh('git', ['checkout', '-qb', 'work'], { cwd: proj });
  return { root, home, proj };
}

// The sha256 of the plugin/ tree the sandbox actually INSTALLED (resolved from
// installed_plugins.json's installPath — the loaded copy, never the pre-cache).
// Compared against the local tree so "tested what ships" is observed, not
// assumed (issue #22). Empty string on any failure — which can never satisfy
// the equality, so a broken read fails the arm rather than passing it.
function installedTreeHash(home) {
  try {
    const j = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const e = ((j.plugins && j.plugins['vfkb@vfkb']) || []).find((r) => r && r.scope === 'user');
    return e && e.installPath ? hashTree(e.installPath) : '';
  } catch {
    return '';
  }
}

const cloneDir = (home) => join(home, '.claude', 'plugins', 'marketplaces', 'vfkb');
const marketplaceAdd = (home, ref) =>
  sh('claude', ['plugin', 'marketplace', 'add', ref ? `${MARKETPLACE}@${ref}` : MARKETPLACE],
    { env: homeEnv(home), stdio: 'ignore', timeout: SETUP_TIMEOUT });
const marketplaceUpdate = (home) =>
  sh('claude', ['plugin', 'marketplace', 'update', 'vfkb'],
    { env: homeEnv(home), stdio: 'ignore', timeout: SETUP_TIMEOUT });
const pluginInstall = (home) =>
  sh('claude', ['plugin', 'install', 'vfkb@vfkb', '--scope', 'user'],
    { env: homeEnv(home), stdio: 'ignore', timeout: SETUP_TIMEOUT });
const pluginUpdate = (home) =>
  sh('claude', ['plugin', 'update', 'vfkb@vfkb'],
    { env: homeEnv(home), stdio: 'ignore', timeout: SETUP_TIMEOUT });

// --- one metered /vfkb:brief turn against the installed plugin ---------------
function brief(sb) {
  let raw = '';
  let err = '';
  try {
    raw = sh('claude', ['-p', '/vfkb:brief', '--output-format', 'json',
      '--model', OUTER_MODEL, '--dangerously-skip-permissions'], {
      cwd: sb.proj,
      env: homeEnv(sb.home),
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
  } catch { text = raw; }
  const sentinel = text.toLowerCase().includes(SENTINEL);
  const haiku = models.some((m) => m.toLowerCase().includes('haiku'));
  // `present` REQUIRES BOTH. The haiku conjunct is load-bearing: SessionStart
  // resume-injection puts the sentinel into context whether or not the brief
  // skill exists, so `sentinel` alone is NON-discriminating — a contrast/
  // upgrade-before turn shows sentinel=true routinely. Only the Haiku briefer
  // fork produces a haiku model under a non-haiku outer session, so `haiku`
  // separates present from absent. Do NOT simplify to sentinel-only.
  return { present: sentinel && haiku, sentinel, haiku, models, out: text.replace(/\s+/g, ' ').slice(0, 100), err };
}

// --- arm runners -------------------------------------------------------------
// Each arm's SETUP (marketplace add / install / git rewind / update) is wrapped:
// a transient hiccup (network, rate-limit, a slow clone) marks that arm a miss
// with the captured error and lets the run continue, rather than crashing a
// ~12-session metered run after burning turns and producing no record. A miss is
// the fail-safe direction — a positive arm that couldn't set up cannot pass.
const setupErr = (e) => `SETUP: ${String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 160)}`;

function runFresh() {
  const sb = buildSandbox();
  try {
    marketplaceAdd(sb.home, REF);   // github source pinned to the ref under test
    pluginInstall(sb.home);
    const treeVerified = installedTreeHash(sb.home) === LOCAL_TREE; // installed bytes == this tree
    const r = brief(sb);
    return { present: r.present, treeVerified, sentinel: r.sentinel, haiku: r.haiku, out: r.out, err: r.err };
  } catch (e) {
    return { present: false, treeVerified: false, sentinel: false, haiku: false, out: '', err: setupErr(e) };
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
}

function runUpgrade(prevTag) {
  const sb = buildSandbox();
  try {
    marketplaceAdd(sb.home, REF);   // shallow clone at the ref under test
    const clone = cloneDir(sb.home);
    const latestRef = sh('git', ['rev-parse', 'HEAD'], { cwd: clone }).trim(); // == pushed tip of REF
    try { sh('git', ['fetch', '--unshallow'], { cwd: clone, stdio: 'ignore' }); } catch { /* already full */ }
    sh('git', ['checkout', '-q', prevTag], { cwd: clone });   // rewind to the pre-brief release
    pluginInstall(sb.home);
    const before = brief(sb);       // pre-turn: capability must be ABSENT
    sh('git', ['checkout', '-q', latestRef], { cwd: clone });  // advance back to the ref under test
    marketplaceUpdate(sb.home);
    pluginUpdate(sb.home);
    const treeVerifiedAfter = installedTreeHash(sb.home) === LOCAL_TREE; // upgrade DELIVERED this tree
    const after = brief(sb);        // post-turn: capability must be PRESENT
    return {
      absentBefore: !before.present, presentAfter: after.present, treeVerifiedAfter,
      beforeOut: before.out, afterOut: after.out,
      err: [before.err, after.err].filter(Boolean).join(' | ').slice(0, 160),
    };
  } catch (e) {
    return { absentBefore: false, presentAfter: false, treeVerifiedAfter: false, beforeOut: '', afterOut: '', err: setupErr(e) };
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
}

function runContrast() {
  const sb = buildSandbox();
  try {
    marketplaceAdd(sb.home, REF);   // the ref under test
    const clone = cloneDir(sb.home);
    // Remove the capability from the resolved tree — BOTH the skill and the haiku
    // briefer agent (else the agent forges a haiku modelUsage entry) — and nuke
    // the pre-cache so install re-copies the stripped tree, not the cached one.
    rmSync(join(clone, 'plugin', 'skills', 'brief'), { recursive: true, force: true });
    rmSync(join(clone, 'plugin', 'agents', 'briefer.md'), { force: true });
    rmSync(join(sb.home, '.claude', 'plugins', 'cache', 'vfkb'), { recursive: true, force: true });
    pluginInstall(sb.home);
    const r = brief(sb);
    return { present: r.present, sentinel: r.sentinel, haiku: r.haiku, out: r.out, err: r.err };
  } catch (e) {
    // A contrast SETUP failure is recorded as an error and non-leaking (present
    // false) — but a SYSTEMIC failure also sinks the positive arms, so the
    // overall verdict is NOT-DEMONSTRATED, never a vacuous green.
    return { present: false, sentinel: false, haiku: false, out: '', err: setupErr(e) };
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
}

// --- drive -------------------------------------------------------------------
const PREV = prevReleaseWithoutBrief();

// The ref under test (issue #22). A re-pin must prove THE TREE IT SHIPS, so the
// marketplace resolves this exact ref — never bare `main`, which on a release
// branch is a DIFFERENT tree and yields a record claiming a version it did not
// test. Default: the current branch. Every arm then content-asserts that the
// tree the sandbox INSTALLED equals the local tree (observed, not assumed).
const REF = process.env.VFKB_IP_REF || sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO }).trim();
if (!REF || REF === 'HEAD') {
  throw new Error('detached HEAD and no VFKB_IP_REF — name the branch under test (it must be pushed)');
}
const HEAD_SHA = sh('git', ['rev-parse', 'HEAD'], { cwd: REPO }).trim();
{
  // Pre-flight, before any metered turn: the pushed ref must BE this tree.
  const dirty = sh('git', ['status', '--porcelain', '--', 'plugin'], { cwd: REPO }).trim();
  if (dirty) {
    throw new Error(`plugin/ has uncommitted changes — the pushed ref cannot equal this tree:\n${dirty}`);
  }
  const remote = sh('git', ['ls-remote', 'origin', REF], { cwd: REPO }).split('\t')[0].trim();
  if (remote !== HEAD_SHA) {
    throw new Error(
      `origin/${REF} is ${remote.slice(0, 12) || '(missing)'} but local HEAD is ${HEAD_SHA.slice(0, 12)} — push first; ` +
        `the marketplace installs the REMOTE ref, and testing a tree you have not pushed proves nothing about it`,
    );
  }
}
const LOCAL_TREE = hashTree(join(REPO, 'plugin'));

console.log(`vfkb-claude-plugin install-path L4  (outer=${OUTER_MODEL}, trials=${TRIALS})`);
console.log(`ref under test = ${REF} @ ${HEAD_SHA.slice(0, 12)} (plugin/ tree ${LOCAL_TREE.slice(0, 12)}…)`);
console.log(`upgrade "before" = ${PREV} (newest release without /vfkb:brief); present = sentinel AND haiku fork\n`);

const arms = {
  fresh: { role: 'positive', predicate: ['present', 'treeVerified'], trials: [] },
  upgrade: { role: 'positive', predicate: ['absentBefore', 'presentAfter', 'treeVerifiedAfter'], trials: [] },
  contrast: { role: 'contrast', predicate: ['present'], trials: [] },
};
for (let t = 1; t <= TRIALS; t++) {
  process.stdout.write(`  trial ${t}  fresh    … `);
  const f = runFresh(); arms.fresh.trials.push(f);
  console.log(`${f.present && f.treeVerified ? 'HIT ' : `miss (sentinel=${f.sentinel} haiku=${f.haiku} tree=${f.treeVerified})`}  — "${f.out}"${f.err ? '  ERR:' + f.err : ''}`);

  process.stdout.write(`  trial ${t}  upgrade  … `);
  const u = runUpgrade(PREV); arms.upgrade.trials.push(u);
  console.log(`${u.absentBefore && u.presentAfter && u.treeVerifiedAfter ? 'HIT ' : `miss (absentBefore=${u.absentBefore} presentAfter=${u.presentAfter} tree=${u.treeVerifiedAfter})`}${u.err ? '  ERR:' + u.err : ''}`);

  process.stdout.write(`  trial ${t}  contrast … `);
  const c = runContrast(); arms.contrast.trials.push(c);
  console.log(`${c.present ? 'LEAK' : 'clean'}  (sentinel=${c.sentinel} haiku=${c.haiku})  — "${c.out}"${c.err ? '  ERR:' + c.err : ''}`);
}

const pluginVersion = JSON.parse(
  readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'),
).version;
const record = {
  scenario: 'install-path', recordVersion: 2, pluginVersion, outerModel: OUTER_MODEL,
  trials: TRIALS, generated: new Date().toISOString(), upgradeFrom: PREV,
  // Tree-binding (issue #22): the exact ref/tree this run installed. The gate
  // recomputes hashTree(plugin/) and rejects the record when they diverge, so a
  // record can never claim a tree it did not test.
  ref: REF, headSha: HEAD_SHA, pluginTreeHash: LOCAL_TREE, arms,
};

const { ok: demonstrated, reasons } = verdict(record);
console.log(demonstrated
  ? '\nDEMONSTRATED — a consumer can install AND upgrade this plugin through the real marketplace path and get a working capability (ADR-0022, recomputed)'
  : `\nNOT demonstrated — ${reasons.join('; ')}`);

mkdirSync(join(REPO, 'scenarios/records'), { recursive: true });
writeFileSync(join(REPO, 'scenarios/records/install-path.json'), JSON.stringify(record, null, 2) + '\n');
console.log(`record → scenarios/records/install-path.json (pluginVersion=${pluginVersion})`);
process.exit(demonstrated ? 0 : 1);

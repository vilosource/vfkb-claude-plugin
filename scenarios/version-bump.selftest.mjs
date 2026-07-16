#!/usr/bin/env node
// ============================================================================
// Negative checks for the version Brake (vfkb ADR-0029: a proof that cannot
// fail proves nothing; ADR-0061 DoD — "seen going red").
//
// Each case builds a REAL git repo in a tmpdir, tags a release, breaks exactly
// one thing, and asserts the Brake reports it. The baseline asserts it stays
// green when nothing is broken — otherwise every red below is vacuous.
//
// The last case is the one that matters: it replays the ACTUAL v0.5.0 drift
// (templates/vfkb-guard.mjs landing after the bump commit) and asserts red. A
// Brake that cannot catch the bug it was written for is decoration.
//
//   node scenarios/version-bump.selftest.mjs
// ============================================================================
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkVersionBump, tagFor } from './version-bump.mjs';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

const write = (root, rel, body) => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};

const setVersion = (root, version) =>
  write(root, 'plugin/.claude-plugin/plugin.json', { name: 'vfkb', version });

/** A repo at v0.5.0, tagged — i.e. a correctly released state. */
function fixture(version = '0.5.0') {
  const root = mkdtempSync(join(tmpdir(), 'version-brake-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git(root, 'config', 'user.email', 'selftest@example.invalid');
  git(root, 'config', 'user.name', 'selftest');
  setVersion(root, version);
  write(root, 'plugin/skills/vfkb/SKILL.md', '---\nname: vfkb\n---\n');
  write(root, 'templates/vfkb-guard.mjs', '// guard v1\n');
  write(root, 'scenarios/records/brief-skill.json', { pluginVersion: version });
  write(root, 'README.md', '# plugin\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', `release ${version}`);
  git(root, 'tag', '-a', tagFor('vfkb', version), '-m', `vfkb ${version}`);
  return root;
}

const commit = (root, msg) => {
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', msg);
};

let failed = 0;
const roots = [];

/** Assert the Brake's verdict, and that a red says WHY. */
function check(label, mutate, { expect, mentions, surface }) {
  const root = fixture();
  roots.push(root);
  mutate(root);
  const { ok, reasons } = checkVersionBump(root, surface);
  const got = ok ? 'green' : 'red';
  if (got !== expect) {
    console.error(`FAIL  ${label}\n      expected ${expect}, got ${got}${ok ? '' : `: ${reasons.join('; ')}`}`);
    failed++;
    return;
  }
  if (mentions && !reasons.join('\n').includes(mentions)) {
    console.error(`FAIL  ${label}\n      went red correctly but never mentioned ${JSON.stringify(mentions)}: ${reasons.join('; ')}`);
    failed++;
    return;
  }
  console.log(`ok    ${label} — ${got}`);
}

// --- baseline: without this, every red below proves nothing ------------------
check('baseline: released tree, surface matches its tag', () => {}, { expect: 'green' });

// --- the bug this Brake exists for ------------------------------------------
check(
  'THE 0.5.0 DRIFT: a new templates/ file lands under an already-tagged version',
  (root) => {
    write(root, 'templates/vfkb-guard.mjs', '// guard v2 — the ADR-0059 INACTIVE guard, #16\n');
    commit(root, 'feat: INACTIVE guard (#16)');
  },
  { expect: 'red', mentions: 'templates/vfkb-guard.mjs' },
);

check(
  'plugin/ changes under an already-tagged version (a re-vendor with no bump)',
  (root) => {
    write(root, 'plugin/dist/bundles/vfkb.mjs', '// re-vendored bundle\n');
    commit(root, 'chore: re-vendor');
  },
  { expect: 'red', mentions: 'plugin/dist/bundles/vfkb.mjs' },
);

check(
  'a surface file DELETED under an already-tagged version',
  (root) => {
    rmSync(join(root, 'templates/vfkb-guard.mjs'));
    commit(root, 'chore: drop the guard');
  },
  { expect: 'red', mentions: 'templates/vfkb-guard.mjs' },
);

// The local pre-flight must agree with CI, or people stop trusting it.
check(
  'an UNCOMMITTED surface edit is caught (local pre-flight == CI)',
  (root) => write(root, 'plugin/skills/vfkb/SKILL.md', '---\nname: vfkb\nchanged: true\n---\n'),
  { expect: 'red', mentions: 'plugin/skills/vfkb/SKILL.md' },
);

// --- the green paths, which must stay green ---------------------------------
check(
  'the fix: surface changed AND the version was bumped',
  (root) => {
    write(root, 'templates/vfkb-guard.mjs', '// guard v2\n');
    setVersion(root, '0.6.0');
    commit(root, 'feat: guard, v0.6.0');
  },
  { expect: 'green' },
);

check(
  'non-surface work needs no bump (a scenario + docs, like hooks-smoke #15)',
  (root) => {
    write(root, 'scenarios/hooks-smoke.mjs', '// L4\n');
    write(root, 'README.md', '# plugin\n\nmore prose\n');
    commit(root, 'feat: hooks-smoke L4 (#15)');
  },
  { expect: 'green' },
);

check(
  'a bumped-but-unreleased version stays green across further surface work',
  (root) => {
    setVersion(root, '0.6.0');
    write(root, 'plugin/dist/bundles/vfkb.mjs', '// b\n');
    commit(root, 'chore: bump');
    write(root, 'plugin/dist/bundles/vfkb-mcp.mjs', '// more\n');
    commit(root, 'chore: more work on the unreleased version');
  },
  { expect: 'green' },
);

// --- anti-vacuity: the Brake must not pass by checking nothing --------------
// A dead entry (a path on NEITHER side) must be reported. Deleting a path that
// the TAG still ships is not this case — that is drift, covered above — so the
// only way to reach this branch is to declare a path that never existed.
check(
  'a dead SURFACE entry cannot silently stop checking (anti-vacuity)',
  () => {},
  { expect: 'red', mentions: 'exists neither at HEAD nor in', surface: ['plugin', 'templates', 'ghost'] },
);

// Real, and easy to get backwards: dropping a released dir must read as drift
// ("bump"), not as a stale-list problem ("edit SURFACE").
check(
  'deleting a released surface dir reads as drift, not a stale list',
  (root) => {
    rmSync(join(root, 'templates'), { recursive: true });
    commit(root, 'chore: remove templates entirely');
  },
  { expect: 'red', mentions: 'templates/vfkb-guard.mjs' },
);

for (const r of roots) rmSync(r, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} selftest case(s) FAILED — the version Brake is not connected`);
  process.exit(1);
}
console.log('\nversion brake selftest PASSED — every case observed going the way it must');

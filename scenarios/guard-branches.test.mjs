#!/usr/bin/env node
// ============================================================================
// Deterministic branch test for templates/vfkb-guard.mjs (ADR-0059).
// ----------------------------------------------------------------------------
// The inner gate under the inactive-signal L4: the L4 proves the end-to-end
// agent-observable banner, but the guard's structural invariants — scope
// matching, wrong-path, fail-open on malformed input, missing env, symlinks —
// belong in a deterministic backstop (project testing pyramid; deterministic
// backstop over probabilistic gate). No LLM, no network. Runs in CI.
//
//   node scenarios/guard-branches.test.mjs
// ============================================================================
import { execFileSync, } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const GUARD = resolve(process.argv[1], '..', '..', 'templates', 'vfkb-guard.mjs');

// Run the guard with a given project settings + installed_plugins state.
// Returns true iff it printed the INACTIVE banner. Asserts it always exits 0.
function runGuard({ settings, installed, projectDirOverride, cwd } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'guard-bt-'));
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  mkdirSync(join(proj, '.claude'), { recursive: true });
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  if (settings !== undefined) {
    writeFileSync(join(proj, '.claude', 'settings.json'),
      typeof settings === 'string' ? settings : JSON.stringify(settings));
  }
  const inst = typeof installed === 'function' ? installed(root, proj) : installed;
  if (inst !== undefined) {
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'),
      typeof inst === 'string' ? inst : JSON.stringify(inst));
  }
  const env = { ...process.env, HOME: home };
  const projectDir = projectDirOverride ? projectDirOverride(root, proj) : proj;
  if (projectDir !== null) env.CLAUDE_PROJECT_DIR = projectDir;
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', [GUARD], { encoding: 'utf8', env, cwd: cwd ? cwd(root, proj) : proj });
  } catch (e) {
    code = e.status ?? 1;
    out = String(e.stdout || '');
  }
  rmSync(root, { recursive: true, force: true });
  if (code !== 0) throw new Error(`guard exited ${code} (must fail open, always exit 0)`);
  return out.includes('vfkb INACTIVE');
}

const decl = { enabledPlugins: { 'vfkb@vfkb': true } };

const cases = [
  ['declared + no installed_plugins.json at all → BANNER',
    { settings: decl }, true],
  ['declared + empty plugins → BANNER',
    { settings: decl, installed: { plugins: {} } }, true],
  ['declared + user-scope install → silent',
    { settings: decl, installed: { plugins: { 'vfkb@vfkb': [{ scope: 'user' }] } } }, false],
  ['declared + project-scope matching THIS path → silent',
    { settings: decl,
      installed: (root, p) => ({ plugins: { 'vfkb@vfkb': [{ scope: 'project', projectPath: p }] } }) }, false],
  ['declared + project-scope DIFFERENT path → BANNER',
    { settings: decl, installed: { plugins: { 'vfkb@vfkb': [{ scope: 'project', projectPath: '/some/other/repo' }] } } }, true],
  ['NOT declared → silent',
    { settings: { enabledPlugins: {} }, installed: { plugins: {} } }, false],
  ['no settings.json at all → silent (undeclared)',
    { installed: { plugins: {} } }, false],
  ['malformed settings.json → silent (fail open on declaration read)',
    { settings: '{not json', installed: { plugins: { 'vfkb@vfkb': [{ scope: 'user' }] } } }, false],
  ['malformed installed_plugins.json + declared → BANNER (fulfillment unprovable)',
    { settings: decl, installed: 'NOT JSON' }, true],
  ['missing CLAUDE_PROJECT_DIR, cwd is the project → resolves to cwd → silent when user-scope',
    { settings: decl, installed: { plugins: { 'vfkb@vfkb': [{ scope: 'user' }] } }, projectDirOverride: () => null }, false],
];

let failed = 0;
for (const [name, spec, expectBanner] of cases) {
  const banner = runGuard(spec);
  const ok = banner === expectBanner;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}  (banner=${banner}, expected=${expectBanner})`);
}

// Symlinked projectPath: install stored the realpath, session runs via a symlink.
{
  const root = mkdtempSync(join(tmpdir(), 'guard-bt-sym-'));
  const home = join(root, 'home');
  const real = join(root, 'realproj');
  const link = join(root, 'linkproj');
  mkdirSync(join(real, '.claude'), { recursive: true });
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(real, '.claude', 'settings.json'), JSON.stringify(decl));
  symlinkSync(real, link);
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'vfkb@vfkb': [{ scope: 'project', projectPath: real }] } }));
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', [GUARD], {
      encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: link }, cwd: link,
    });
  } catch (e) { code = e.status ?? 1; out = String(e.stdout || ''); }
  rmSync(root, { recursive: true, force: true });
  const banner = out.includes('vfkb INACTIVE');
  const ok = code === 0 && banner === false; // installed via realpath, session via symlink → must stay silent
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  symlinked projectPath (install=realpath, session=symlink) → silent  (banner=${banner}, exit=${code})`);
}

console.log(failed
  ? `\nguard-branches: ${failed} FAILED`
  : `\nguard-branches: all ${cases.length + 1} cases passed`);
process.exit(failed ? 1 : 0);

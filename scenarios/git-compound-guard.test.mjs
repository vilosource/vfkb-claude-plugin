#!/usr/bin/env node
// ============================================================================
// Deterministic branch test for plugin/hooks/git-compound-guard.mjs.
// ----------------------------------------------------------------------------
// Ported from vfkb's own selftest for the dogfooded original (vfkb ADR-0070
// §5). The hooks-smoke L4 proves the shipped hook fires through the real
// plugin path; this proves its internal branch logic — both directions,
// no LLM, no network. Runs in CI.
//
//   node scenarios/git-compound-guard.test.mjs
// ============================================================================
import { spawnSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(process.argv[1], '../..');
const HOOK = join(REPO, 'plugin', 'hooks', 'git-compound-guard.mjs');

const run = (input) => {
  const r = spawnSync('node', [HOOK], { input, encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) throw new Error(`hook exited ${r.status} — a hook must never error`);
  return r.stdout;
};
const decision = (command) => {
  const out = run(JSON.stringify({ tool_input: { command } }));
  try { return JSON.parse(out)?.hookSpecificOutput?.permissionDecision ?? 'allow'; } catch { return 'allow'; }
};

// The hook must TERMINATE when stdin never closes, and a dangerous payload
// that arrived before the deadline must STILL be denied — a watchdog that
// discards the buffer is a silently inert guard.
async function watchdogCase() {
  return new Promise((resolveP) => {
    const p = spawn('node', [HOOK], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    const killer = setTimeout(() => {
      p.kill('SIGKILL');
      resolveP({ terminated: false, out });
    }, 5000);
    p.on('exit', () => {
      clearTimeout(killer);
      resolveP({ terminated: true, out });
    });
    p.stdin.write(JSON.stringify({ tool_input: { command: 'git checkout main && rm -rf build' } }));
  });
}

const CASES = [
  ['git checkout docs/adr-0068-self-merge && python3 - <<EOF\nstuff\nEOF', 'deny'],
  ['git checkout -q feat/x 2>/dev/null || git checkout -q -b feat/x; git stash pop -q', 'deny'],
  ['git switch main && npm test', 'deny'],
  ['cd repo && git checkout main; rm -rf build', 'deny'],
  ['git checkout main\nrm -rf build', 'deny'],
  ['echo prep\ngit checkout main && rm -rf build', 'deny'],
  ['git checkout feat/x\ngit commit -m wip', 'deny'],
  ['git -C /home/user/repo checkout main && rm -rf build', 'deny'],
  ['git checkout feat/x', 'allow'],
  ['git switch -c feat/new', 'allow'],
  ['git checkout feat/x\n', 'allow'],
  ['cd repo && git checkout main\n', 'allow'],
  ['git switch -c feat/new\r\n', 'allow'],
  ['git checkout -- .vfkb/entries.jsonl', 'allow'],
  ['git checkout -q main -- docs/file.md && cat docs/file.md', 'allow'],
  ['git checkout -- .vfkb/entries.jsonl && git status', 'allow'],
  ['git log --oneline && git status', 'allow'],
  ['echo "git checkout is a command"', 'allow'],
  ['npm test && git commit -m x', 'allow'],
  ['python3 - <<EOF\ntext: "never chain git\n  checkout/switch compounded with &&/; in one command"\nEOF', 'allow'],
  ['cat <<DOC\nthe rule about git checkout must not be chained; use two commands\nDOC', 'allow'],
];

let failed = 0;
for (const [cmd, want] of CASES) {
  const got = decision(cmd);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  [${want}] ${cmd.split('\n')[0].slice(0, 70)}${ok ? '' : ` → got ${got}`}`);
}

for (const garbage of ['not json', '', '{"tool_input":{}}', '{"tool_input":{"command":null}}']) {
  const out = run(garbage);
  const dec = (() => { try { return JSON.parse(out)?.hookSpecificOutput?.permissionDecision ?? 'allow'; } catch { return 'allow'; } })();
  const ok = dec === 'allow';
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  [fail-open] ${JSON.stringify(garbage).slice(0, 40)}`);
}

const w = await watchdogCase();
const wOk = w.terminated && w.out.includes('"deny"');
if (!wOk) failed++;
console.log(
  `${wOk ? 'ok  ' : 'FAIL'}  [watchdog] stdin held open → terminated=${w.terminated}, denied=${w.out.includes('"deny"')}`,
);

if (failed) {
  console.error(`\ngit-compound-guard test FAILED: ${failed} case(s)`);
  process.exit(1);
}
console.log('\ngit-compound-guard test PASSED — both directions observed');

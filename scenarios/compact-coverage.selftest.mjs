#!/usr/bin/env node
// ============================================================================
// Negative checks for the compaction-coverage Brake (vfkb ADR-0077 clause 1;
// ADR-0070 §1 — a guard is trusted only once seen going red).
//
// Each case copies THIS checkout's plugin/, marketplace manifest, release-gate
// workflow and matcher-semantics record into a tmpdir, changes exactly one
// thing, and asserts the verdict. The baseline (the shipped, matcher-less
// hooks.json) must stay green, or every red below is vacuous.
//
//   node scenarios/compact-coverage.selftest.mjs
// ============================================================================
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCompactCoverage } from './compact-coverage.mjs';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const HOOKS = 'plugin/hooks/hooks.json';
const RECORD = 'scenarios/records/matcher-semantics.json';
const WF = '.github/workflows/release-gate.yml';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'compact-coverage-'));
  cpSync(join(repo, 'plugin'), join(root, 'plugin'), { recursive: true });
  cpSync(join(repo, '.claude-plugin'), join(root, '.claude-plugin'), { recursive: true });
  for (const rel of [RECORD, WF]) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    cpSync(join(repo, rel), join(root, rel));
  }
  return root;
}

const editJson = (rel, fn) => (root) => {
  const p = join(root, rel);
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  fn(doc);
  writeFileSync(p, JSON.stringify(doc, null, 2));
};

/** The SessionStart group that runs `hook session-start`. */
const ours = (doc) => doc.hooks.SessionStart.find((g) => g.hooks.some((h) => /hook session-start/.test(h.command)));
const matcher = (m) => editJson(HOOKS, (doc) => {
  const g = ours(doc);
  if (m === undefined) delete g.matcher;
  else g.matcher = m;
});

let failed = 0;
const roots = [];

function check(label, mutate, { expect, mentions }) {
  const root = fixture();
  roots.push(root);
  mutate(root);
  const { ok, reasons } = checkCompactCoverage(root);
  const got = ok ? 'green' : 'red';
  if (got !== expect) {
    console.error(`FAIL  ${label}\n      expected ${expect}, got ${got}${ok ? '' : `: ${reasons.join('; ')}`}`);
    failed++;
    return;
  }
  if (mentions && !reasons.join('\n').includes(mentions)) {
    console.error(`FAIL  ${label}\n      went red but never mentioned ${JSON.stringify(mentions)}: ${reasons.join('; ')}`);
    failed++;
    return;
  }
  console.log(`ok    ${label} — ${got}`);
}

// --- baseline: without this, every red below proves nothing ------------------
check('baseline: shipped hooks.json (no matcher) + pinned-CLI record', () => {}, { expect: 'green' });

// --- matchers that drop compaction (ADR-0077's red cases) ---------------------
for (const m of ['startup', 'startup|resume', 'resume', 'compa', 'Compact', 'startup|compa']) {
  check(`matcher ${JSON.stringify(m)} drops compact`, matcher(m), { expect: 'red', mentions: 'not allowlisted' });
}

// --- fail closed on shapes that DO cover compact but are not allowlisted ------
for (const m of ['c.mpact', 'startup, compact']) {
  check(`matcher ${JSON.stringify(m)} covers compact but fails closed`, matcher(m), { expect: 'red', mentions: 'not allowlisted' });
}

// --- allowlisted shapes stay green ---------------------------------------------
for (const m of [undefined, '', '*', 'startup|compact', 'compact', 'compact|']) {
  check(`matcher ${JSON.stringify(m ?? '(absent)')} is allowlisted`, matcher(m), { expect: 'green' });
}

// --- identification fails closed -------------------------------------------------
check('session-start entry removed', editJson(HOOKS, (doc) => {
  doc.hooks.SessionStart = doc.hooks.SessionStart.filter((g) => g !== ours(doc));
}), { expect: 'red', mentions: 'no SessionStart entry' });

check('session-start reached through a wrapper the Brake cannot identify', editJson(HOOKS, (doc) => {
  for (const h of ours(doc).hooks) h.command = 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/start.sh"';
}), { expect: 'red', mentions: 'no SessionStart entry' });

// --- the matcher-semantics record --------------------------------------------------
check('record probed on a different CLI than release-gate.yml pins', editJson(RECORD, (rec) => {
  rec.cliVersion = '0.0.1';
}), { expect: 'red', mentions: 'release-gate.yml pins' });

check('record shows an allowlisted matcher NOT firing on compact', editJson(RECORD, (rec) => {
  const t = rec.matchers.find((x) => x.matcher === 'startup|compact').tag;
  rec.raw = rec.raw.replace(/^(compact:.*)$/m, (line) => line.split(' ').filter((w) => w !== t).join(' '));
}), { expect: 'red', mentions: 'allowlist is unsound' });

check('record whose probe never ran (absent matcher did not fire)', editJson(RECORD, (rec) => {
  rec.raw = 'startup:\ncompact:';
}), { expect: 'red', mentions: 'the probe did not run' });

check('record missing', (root) => rmSync(join(root, RECORD)), { expect: 'red', mentions: 'missing' });

// --- the PR #63 review's attacks: each was a false green before round 1 ------------
check('null matcher (the CLI drops the entry)', matcher(null), { expect: 'red', mentions: 'not allowlisted' });

check('session-start hook whose type is not "command" (never runs)', editJson(HOOKS, (doc) => {
  for (const h of ours(doc).hooks) h.type = 'prompt';
}), { expect: 'red', mentions: 'no SessionStart entry' });

check('decoy entry that only echoes the text, real call renamed and matched to startup', editJson(HOOKS, (doc) => {
  const real = ours(doc);
  real.matcher = 'startup';
  for (const h of real.hooks) h.command = h.command.replace('hook session-start', "hook 'session-start'");
  doc.hooks.SessionStart.unshift({ matcher: '*', hooks: [{ type: 'command', command: 'echo "vfkb.mjs hook session-start"' }] });
}), { expect: 'red', mentions: 'not allowlisted' });

check('second hooks file named by plugin.json carries a startup-only SessionStart', (root) => {
  const dir = join(root, 'plugin');
  writeFileSync(join(dir, 'hooks', 'extra.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'true' }] }] } }));
  editJson('plugin/.claude-plugin/plugin.json', (m) => { m.hooks = './hooks/extra.json'; })(root);
}, { expect: 'red', mentions: 'extra.json' });

check('inline hooks object in plugin.json carries a startup-only SessionStart', editJson('plugin/.claude-plugin/plugin.json', (m) => {
  m.hooks = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'true' }] }] } };
}), { expect: 'red', mentions: 'inline hooks' });

check('plugin.json names a hooks file that does not exist', editJson('plugin/.claude-plugin/plugin.json', (m) => {
  m.hooks = './hooks/nope.json';
}), { expect: 'red', mentions: 'failing closed' });

check('record trimmed to the absent matcher only', editJson(RECORD, (rec) => {
  rec.matchers = rec.matchers.slice(0, 1);
  rec.raw = `startup: ${rec.matchers[0].tag}\ncompact: ${rec.matchers[0].tag}`;
}), { expect: 'red', mentions: 'exactly the matchers' });

check('a commented-out pin above a different real install', (root) => {
  const p = join(root, WF);
  const wf = readFileSync(p, 'utf8');
  writeFileSync(p, wf.replace(/(\n\s*)(run: npm install -g @anthropic-ai\/claude-code@)(\d+\.\d+\.\d+)/, (_, ws, pre, v) => `${ws}# ${pre}${v}${ws}${pre}9.9.9`));
}, { expect: 'red', mentions: 'release-gate.yml pins 9.9.9' });

check('two real CLI pins in release-gate.yml', (root) => {
  const p = join(root, WF);
  writeFileSync(p, readFileSync(p, 'utf8') + '\n      - run: npm install -g @anthropic-ai/claude-code@2.1.286\n');
}, { expect: 'red', mentions: 'exactly one' });

for (const r of roots) rmSync(r, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} case(s) did not behave — the compaction-coverage Brake is not trustworthy`);
  process.exit(1);
}
console.log('\ncompaction-coverage Brake connected: baseline green, every drop and every unprobed shape red');

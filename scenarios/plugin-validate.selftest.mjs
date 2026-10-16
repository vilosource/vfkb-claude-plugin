#!/usr/bin/env node
// ============================================================================
// Negative checks for the wiring Brake (vfkb ADR-0029: a proof that cannot fail
// proves nothing; ADR-0070 §1 — a guard is trusted only once seen going red).
//
// Each case copies THIS checkout's plugin/ and marketplace manifest into a
// tmpdir, breaks exactly one thing in hooks.json, and asserts the Brake reports
// it. The baseline asserts the unbroken copy stays green — otherwise every red
// below is vacuous.
//
// The four malformations are the ones probe 4 observed plain `validate` letting
// through (vfkb v3 harness survey §7a). The unquoted-root case replays the
// defect this Brake found in the shipped hooks.json on its first run: with a
// plugin root containing a space, `node ${CLAUDE_PLUGIN_ROOT}/…` hands node a
// truncated path and every hook dies.
//
//   node scenarios/plugin-validate.selftest.mjs
// ============================================================================
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginValidate } from './plugin-validate.mjs';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const HOOKS = 'plugin/hooks/hooks.json';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-validate-'));
  cpSync(join(repo, 'plugin'), join(root, 'plugin'), { recursive: true });
  cpSync(join(repo, '.claude-plugin'), join(root, '.claude-plugin'), { recursive: true });
  return root;
}

/** Mutate hooks.json as parsed JSON. */
const editHooks = (fn) => (root) => {
  const p = join(root, HOOKS);
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  fn(doc.hooks);
  writeFileSync(p, JSON.stringify(doc, null, 2));
};

const firstHook = (hooks) => hooks.SessionStart[0].hooks[0];

let failed = 0;
const roots = [];

function check(label, mutate, { expect, mentions }) {
  const root = fixture();
  roots.push(root);
  mutate(root);
  const { ok, reasons } = checkPluginValidate(root);
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
check('baseline: shipped plugin + marketplace', () => {}, { expect: 'green' });

// --- probe 4's four malformations ---------------------------------------------
check('invalid JSON syntax in hooks.json', (root) => {
  writeFileSync(join(root, HOOKS), readFileSync(join(root, HOOKS), 'utf8').replace(/}\s*$/, ''));
}, { expect: 'red', mentions: 'hooks.json' });

check('unknown event name (a typo)', editHooks((h) => {
  h.SesionStart = h.SessionStart;
  delete h.SessionStart;
}), { expect: 'red', mentions: 'SesionStart' });

check('invalid hook type', editHooks((h) => {
  firstHook(h).type = 'shell';
}), { expect: 'red', mentions: 'Unknown hook type' });

check('command hook missing its command', editHooks((h) => {
  delete firstHook(h).command;
}), { expect: 'red', mentions: 'Invalid command hook' });

check('marketplace source moved away from the validated dir', (root) => {
  const p = join(root, '.claude-plugin/marketplace.json');
  writeFileSync(p, readFileSync(p, 'utf8').replace('"./plugin"', '"./elsewhere"'));
}, { expect: 'red' });

// --- the defect this Brake found in the shipped wiring ------------------------
check('unquoted ${CLAUDE_PLUGIN_ROOT} (the 0.20.0 defect)', editHooks((h) => {
  const hook = firstHook(h);
  hook.command = hook.command.replaceAll('"${CLAUDE_PLUGIN_ROOT}', '${CLAUDE_PLUGIN_ROOT}').replace(/(\.mjs)"/, '$1');
}), { expect: 'red', mentions: 'CLAUDE_PLUGIN_ROOT' });

// --- the quiet-success trap (ADR-0051 §3) -------------------------------------
check('hooks.json removed: validator passes, wiring unchecked', (root) => {
  rmSync(join(root, HOOKS));
}, { expect: 'red', mentions: 'hooks.json was not among' });

for (const r of roots) rmSync(r, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} negative check(s) did not behave — the wiring Brake is not trustworthy`);
  process.exit(1);
}
console.log('\nwiring Brake connected: baseline green, every malformation red');

#!/usr/bin/env node
// ============================================================================
// Matcher-semantics probe (vfkb ADR-0077 clause 1). Asks the INSTALLED Claude Code
// CLI which SessionStart matchers fire on source "startup" and which on "compact",
// and writes the raw answer to scenarios/records/matcher-semantics.json.
//
// Why a record and not a table in code: Claude Code's matcher semantics are only
// partly known (vfkb brain 26887a51ef91 — `,` separates items, whitespace trims,
// regex-shaped matchers search unanchored, and the list-vs-regex rule is NOT
// established). compact-coverage.mjs therefore allowlists shapes and re-parses
// THIS record's raw output to confirm every allowlisted shape still fires on
// compact, on the CLI version pinned in release-gate.yml. A CLI pin bump cannot
// merge without re-running this — the Brake fails on a cliVersion mismatch.
//
// One stream-json process: a startup turn, then `/compact`. Each matcher's hook
// logs its own tag + stdin. Tags are m0..mN on purpose: a `|` in a hook-command
// argument is a shell pipe (brain b6060bb9705c's probe gotcha).
//
// Metered: two haiku turns plus a compaction, a few cents. Run on a pin bump:
//   node scenarios/matcher-probe.mjs
// ============================================================================
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The matchers probed. Every allowlisted shape must be here (compact-coverage checks). */
export const PROBED = [
  null, '', '*',
  'compact', 'startup|compact', 'compact|resume', 'compact|', 'startup|resume|compact',
  'startup', 'startup|resume', 'resume', 'compa', 'Compact', 'startup|compa',
  'startup, compact', 'c.mpact', 'omp.ct',
];

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function cliVersion() {
  const out = execFileSync(process.env.CLAUDE_BIN || 'claude', ['--version'], { encoding: 'utf8' });
  const m = out.match(/(\d+\.\d+\.\d+)/);
  if (!m) throw new Error(`cannot read a version from: ${out}`);
  return m[1];
}

function probe() {
  const dir = mkdtempSync(join(tmpdir(), 'matcher-probe-'));
  const sb = join(dir, 'sb');
  execFileSync('git', ['init', '-q', sb]);
  const log = join(dir, 'log.txt');
  const tag = join(dir, 'tag.sh');
  writeFileSync(tag, '#!/bin/sh\nin=$(cat); printf \'%s\\t%s\\n\' "$1" "$in" >> "$MLOG"; echo \'{}\'\n');
  chmodSync(tag, 0o755);
  const entry = (m, i) => ({ ...(m === null ? {} : { matcher: m }), hooks: [{ type: 'command', command: `${tag} m${i}` }] });
  const settings = join(dir, 's.json');
  writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'vfkb@vfkb': false }, hooks: { SessionStart: PROBED.map(entry) } }));
  const msg = (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } });
  // The second message must arrive after the first turn finishes; a shell sleep
  // between the two writes is the same pacing the vfkb probe kit used.
  const script = `{ printf '%s\\n' '${msg('Reply OK.')}'; sleep 20; printf '%s\\n' '${msg('/compact')}'; sleep 60; } | ` +
    `"${process.env.CLAUDE_BIN || 'claude'}" -p --input-format stream-json --output-format stream-json --verbose ` +
    `--settings "${settings}" --model claude-haiku-4-5 --permission-mode bypassPermissions`;
  // Through the L4 auth seam (env token + no-Keychain shim) — loaded only when run directly.
  const r = spawnSync('bash', ['-c', script], { cwd: sb, env: authEnvFn({ ...process.env, MLOG: log }), encoding: 'utf8', maxBuffer: 64 << 20 });
  if (!existsSync(log)) throw new Error(`no hook fired at all (exit ${r.status}): ${(r.stderr || '').slice(0, 400)}`);
  const fired = { startup: new Set(), compact: new Set() };
  for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
    const [t, json] = line.split('\t');
    const src = JSON.parse(json).source;
    if (fired[src]) fired[src].add(t);
  }
  const fmt = (s) => [...s].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).join(' ');
  return `startup: ${fmt(fired.startup)}\ncompact: ${fmt(fired.compact)}`;
}

// Loaded only when run directly, so compact-coverage (which imports PROBED) never loads auth.mjs.
const authEnvFn = process.argv[1] === fileURLToPath(import.meta.url)
  ? (await import('./auth.mjs')).authEnv
  : (env) => env;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = cliVersion();
  const raw = probe();
  const record = {
    scenario: 'matcher-semantics',
    cliVersion: version,
    generated: new Date().toISOString(),
    matchers: PROBED.map((m, i) => ({ tag: `m${i}`, matcher: m })),
    raw,
  };
  const out = join(repo, 'scenarios', 'records', 'matcher-semantics.json');
  writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
  console.log(`wrote ${out} (CLI ${version})\n${raw}`);
}

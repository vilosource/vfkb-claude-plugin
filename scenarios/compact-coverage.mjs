#!/usr/bin/env node
// ============================================================================
// The compaction-coverage Brake (vfkb ADR-0077 clause 1, accepts RFC-042).
//
// After a compaction Claude Code fires SessionStart again with source
// "compact", and this plugin's session-start hook re-injecting there is the ONLY
// thing carrying the Constitution (ADR-0008) and the handoff pin (ADR-0049) past
// it. A tidy-looking matcher such as "startup|resume" would silently end that.
// This Brake makes it a red.
//
// It does NOT emulate Claude Code's matcher semantics, which are only partly
// known (vfkb brain 26887a51ef91). It ALLOWLISTS shapes and FAILS CLOSED:
//   - matcher absent, "" or "*"; or
//   - only [A-Za-z0-9_|], with "compact" as an exact |-item.
// Anything else is red, even shapes that do cover compact ("startup, compact",
// "c.mpact"). False reds, never false greens.
//
// The allowlist's assumption — that every accepted shape fires on compact — is
// checked against scenarios/records/matcher-semantics.json, the raw output of
// matcher-probe.mjs, which must have been produced on the CLI version pinned in
// release-gate.yml.
//
//   node scenarios/compact-coverage.mjs
// ============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginDir } from './plugin-validate.mjs';

const RULE = 'vfkb ADR-0077: every session-start SessionStart entry must fire on source "compact"';
const ALLOW = 'allowed: matcher absent, "" or "*", or only [A-Za-z0-9_|] with "compact" as an exact |-item';

/** Does this matcher pass the allowlist? `null` means absent. */
export function allowlisted(m) {
  if (m === undefined || m === null || m === '' || m === '*') return true;
  if (typeof m !== 'string' || !/^[A-Za-z0-9_|]+$/.test(m)) return false;
  return m.split('|').includes('compact');
}

/** A SessionStart group that runs the engine's session-start hook. */
const runsSessionStart = (group) =>
  (group.hooks || []).some((h) => typeof h.command === 'string' && /\bhook\s+session-start\b/.test(h.command));

/** The CLI version release-gate.yml installs — the version the Brake is valid for. */
export function pinnedCli(root) {
  const wf = readFileSync(join(root, '.github', 'workflows', 'release-gate.yml'), 'utf8');
  const m = wf.match(/@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** Re-parse the probe record's raw output into { startup:Set, compact:Set } of tags. */
function parseRaw(raw) {
  const fired = {};
  for (const line of String(raw).split('\n')) {
    const m = line.match(/^(startup|compact):\s*(.*)$/);
    if (m) fired[m[1]] = new Set(m[2].split(/\s+/).filter(Boolean));
  }
  return fired;
}

/** Check the matcher-semantics record backs the allowlist on the pinned CLI. */
export function checkRecord(root) {
  const reasons = [];
  const f = join(root, 'scenarios', 'records', 'matcher-semantics.json');
  if (!existsSync(f)) return [`missing scenarios/records/matcher-semantics.json — run scenarios/matcher-probe.mjs`];
  let rec;
  try {
    rec = JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    return [`matcher-semantics.json is not valid JSON: ${e.message}`];
  }
  const pin = pinnedCli(root);
  if (!pin) reasons.push('cannot find the pinned @anthropic-ai/claude-code version in release-gate.yml');
  else if (rec.cliVersion !== pin) {
    reasons.push(`matcher-semantics.json was probed on CLI ${rec.cliVersion}, but release-gate.yml pins ${pin} — re-run scenarios/matcher-probe.mjs on the pinned CLI`);
  }
  const fired = parseRaw(rec.raw);
  if (!fired.startup || !fired.compact) reasons.push('matcher-semantics.json raw output lacks a "startup:" or "compact:" line');
  else {
    // Sanity: the probe actually ran — the absent matcher must fire on both sources.
    const absent = (rec.matchers || []).find((x) => x.matcher === null);
    if (!absent || !fired.startup.has(absent.tag) || !fired.compact.has(absent.tag)) {
      reasons.push('matcher-semantics.json: the absent matcher did not fire on both sources — the probe did not run');
    }
    for (const { tag, matcher } of rec.matchers || []) {
      if (allowlisted(matcher) && !fired.compact.has(tag)) {
        reasons.push(`matcher-semantics.json: allowlisted matcher ${JSON.stringify(matcher)} (${tag}) did NOT fire on compact — the allowlist is unsound on CLI ${rec.cliVersion}`);
      }
    }
  }
  return reasons;
}

/** Check the plugin's hooks.json. */
export function checkHooks(root) {
  const reasons = [];
  const file = join(pluginDir(root), 'hooks', 'hooks.json');
  if (!existsSync(file)) return [`${file} is missing — ${RULE}`];
  const groups = JSON.parse(readFileSync(file, 'utf8')).hooks?.SessionStart || [];
  const ours = groups.filter(runsSessionStart);
  if (ours.length === 0) {
    reasons.push(`no SessionStart entry running \`hook session-start\` was identified — ${RULE} (a wrapper or renamed command fails closed)`);
  }
  for (const g of ours) {
    if (!allowlisted(g.matcher)) {
      reasons.push(`SessionStart matcher ${JSON.stringify(g.matcher)} is not allowlisted — ${RULE}; ${ALLOW}`);
    }
  }
  return reasons;
}

export function checkCompactCoverage(root) {
  const reasons = [...checkHooks(root), ...checkRecord(root)];
  return { ok: reasons.length === 0, reasons };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const { ok, reasons } = checkCompactCoverage(root);
  if (!ok) {
    console.error('compaction-coverage Brake FAILED:');
    for (const r of reasons) console.error(`  - ${r}`);
    process.exit(1);
  }
  console.log('compaction-coverage ok: every session-start entry fires on compact (allowlisted), backed by the pinned-CLI matcher record');
}

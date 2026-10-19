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
// "c.mpact"). False reds, never false greens. A `null` matcher is NOT absent:
// the CLI drops such an entry ("expected string, received null; entry ignored").
//
// EVERY SessionStart entry the plugin declares is checked, in hooks/hooks.json AND
// in any hooks file or inline hooks object named by plugin.json, not only the
// one identified as running `hook session-start`. That stops a decoy entry
// standing in for a real one hidden elsewhere. At least one entry must also be
// identified as the engine's session-start, a `command` hook running
// vfkb.mjs, so that a wrapper or a renamed command fails closed.
//
// RESIDUALS (stated, not closed): the record is self-reported, so a hand-written
// matcher-semantics.json with a matching cliVersion passes; that rests on review.
// A SessionStart command that checks `source` inside itself (an inline `case`, or
// a wrapper script) is invisible here; only the compaction-survival L4 sees it.
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
import { PROBED } from './matcher-probe.mjs';

const RULE = 'vfkb ADR-0077: every session-start SessionStart entry must fire on source "compact"';
const ALLOW = 'allowed: matcher absent, "" or "*", or only [A-Za-z0-9_|] with "compact" as an exact |-item';

/** Does this matcher pass the allowlist? Only `undefined` is absent, never `null`. */
export function allowlisted(m) {
  if (m === undefined || m === '' || m === '*') return true;
  if (typeof m !== 'string' || !/^[A-Za-z0-9_|]+$/.test(m)) return false;
  return m.split('|').includes('compact');
}

/** A SessionStart group that runs the engine's session-start hook: a `command` hook invoking vfkb.mjs. */
const runsSessionStart = (group) =>
  (group.hooks || []).some(
    (h) => h.type === 'command' && typeof h.command === 'string' && /vfkb\.mjs"?\s+hook\s+session-start\b/.test(h.command),
  );

/** The CLI version release-gate.yml installs — the version the Brake is valid for. */
export function pinnedCli(root) {
  const wf = readFileSync(join(root, '.github', 'workflows', 'release-gate.yml'), 'utf8');
  // Only real install steps count; a commented-out pin is not the pin. Exactly one.
  const pins = [...wf.matchAll(/^\s*(?:-\s*)?run:\s*npm install -g @anthropic-ai\/claude-code@(\d+\.\d+\.\d+)\s*$/gm)].map((m) => m[1]);
  return pins.length === 1 ? pins[0] : null;
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
  if (!pin) reasons.push('release-gate.yml must have exactly one uncommented `run: npm install -g @anthropic-ai/claude-code@X.Y.Z` step');
  else if (rec.cliVersion !== pin) {
    reasons.push(`matcher-semantics.json was probed on CLI ${rec.cliVersion}, but release-gate.yml pins ${pin} — re-run scenarios/matcher-probe.mjs on the pinned CLI`);
  }
  // The record must cover exactly the probed set, so a trimmed record cannot pass.
  if (JSON.stringify((rec.matchers || []).map((x) => x.matcher)) !== JSON.stringify(PROBED)) {
    reasons.push('matcher-semantics.json does not list exactly the matchers matcher-probe.mjs probes — re-run the probe');
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
      // In the record, `null` denotes the probe's absent-matcher entry.
      if (allowlisted(matcher === null ? undefined : matcher) && !fired.compact.has(tag)) {
        reasons.push(`matcher-semantics.json: allowlisted matcher ${JSON.stringify(matcher)} (${tag}) did NOT fire on compact — the allowlist is unsound on CLI ${rec.cliVersion}`);
      }
    }
  }
  return reasons;
}

/** Every SessionStart group the plugin declares: hooks/hooks.json plus plugin.json's `hooks`. */
function sessionStartGroups(dir, reasons) {
  const sources = [];
  const main = join(dir, 'hooks', 'hooks.json');
  if (existsSync(main)) sources.push([main, JSON.parse(readFileSync(main, 'utf8'))]);
  const manifest = join(dir, '.claude-plugin', 'plugin.json');
  const extra = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).hooks : undefined;
  for (const h of extra === undefined ? [] : Array.isArray(extra) ? extra : [extra]) {
    if (typeof h === 'string') {
      const f = join(dir, h);
      if (!existsSync(f)) reasons.push(`plugin.json hooks file ${h} is missing — cannot check it, failing closed`);
      else sources.push([f, JSON.parse(readFileSync(f, 'utf8'))]);
    } else if (h && typeof h === 'object') sources.push(['plugin.json (inline hooks)', h]);
    else reasons.push(`plugin.json hooks entry ${JSON.stringify(h)} is not a path or an object — failing closed`);
  }
  if (sources.length === 0) reasons.push(`no hooks file found in ${dir} — ${RULE}`);
  return sources.flatMap(([file, doc]) => (doc.hooks?.SessionStart || []).map((g) => ({ file, g })));
}

/** Check every SessionStart entry the plugin declares. */
export function checkHooks(root) {
  const reasons = [];
  const all = sessionStartGroups(pluginDir(root), reasons);
  if (!all.some(({ g }) => runsSessionStart(g))) {
    reasons.push(`no SessionStart entry running the engine's \`hook session-start\` (a command hook invoking vfkb.mjs) was identified — ${RULE} (a wrapper or renamed command fails closed)`);
  }
  for (const { file, g } of all) {
    if (!allowlisted(g.matcher)) {
      reasons.push(`SessionStart matcher ${JSON.stringify(g.matcher)} in ${file} is not allowlisted — ${RULE}; ${ALLOW}`);
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

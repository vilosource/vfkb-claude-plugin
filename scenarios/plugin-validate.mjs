#!/usr/bin/env node
// ============================================================================
// The wiring Brake (vfkb ADR-0048, v3 PRD R6): `claude plugin validate --strict`
// over the plugin AND the marketplace manifest, on every PR.
//
// Why --strict and not plain validate: observed on CLI 2.1.273 (vfkb v3 harness
// survey §7a, probe 4), plain `validate` passes three of four malformed
// hooks.json files clean — an unknown event name (a typo), an invalid hook
// `type`, a `command` hook with no `command`. Only a JSON syntax error fails
// without --strict. A Brake that tolerates its own defect class is decoration.
//
// Why a content assertion and not the exit status (ADR-0051 §3, the
// quiet-success trap): the verdict is read from the --json report — `success`,
// every errors[]/warnings[] array empty, AND a hooks.json present to inspect.
// A plugin whose hooks.json went missing validates clean and exits 0; here it
// is a red. That the validator actually READS hooks.json is the selftest's job.
//
//   node scenarios/plugin-validate.mjs            # validate this checkout
//   CLAUDE_BIN=/path/to/claude node scenarios/plugin-validate.mjs
// ============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const claudeBin = () => process.env.CLAUDE_BIN || 'claude';

/** Run `claude plugin validate <target> --strict --json`; never throws. */
function validate(target) {
  const r = spawnSync(claudeBin(), ['plugin', 'validate', target, '--strict', '--json'], { encoding: 'utf8' });
  if (r.error) return { status: null, report: null, raw: String(r.error.message) };
  let report = null;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    // A non-JSON answer is itself a red, reported below with the raw output.
  }
  return { status: r.status, report, raw: (r.stdout || '') + (r.stderr || '') };
}

/** Every finding in a report, flattened to "file path: message". */
function findings(report) {
  const out = [];
  for (const part of [report.manifest, ...(report.contents || [])]) {
    if (!part) continue;
    for (const kind of ['errors', 'warnings']) {
      for (const f of part[kind] || []) out.push(`${kind.slice(0, -1)} ${part.file} ${f.path ?? ''}: ${f.message}`);
    }
  }
  return out;
}

/**
 * The plugin dir the marketplace actually ships. Validating a hardcoded
 * `plugin/` would go stale silently if marketplace.json's `source` moved,
 * and `validate <marketplace>` does not descend into the source itself.
 */
export function pluginDir(root) {
  const market = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const entry = (market.plugins || []).find((p) => p.name === 'vfkb');
  if (!entry || typeof entry.source !== 'string') throw new Error('marketplace.json has no local `source` for vfkb');
  return join(root, entry.source);
}

/**
 * Validate the plugin the marketplace points at, and the marketplace itself.
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function checkPluginValidate(root) {
  const reasons = [];
  let plugin;
  try {
    plugin = pluginDir(root);
  } catch (e) {
    return { ok: false, reasons: [`marketplace: ${e.message}`] };
  }
  for (const [label, target, needsHooks] of [
    ['plugin', plugin, true],
    ['marketplace', root, false],
  ]) {
    const { status, report, raw } = validate(target);
    if (!report) {
      reasons.push(`${label}: validator gave no JSON report (exit ${status}): ${raw.trim().slice(0, 300)}`);
      continue;
    }
    if (report.strict !== true) reasons.push(`${label}: report is not a --strict run`);
    for (const f of findings(report)) reasons.push(`${label}: ${f}`);
    if (report.success !== true && !findings(report).length) {
      reasons.push(`${label}: success=${report.success} with no findings listed`);
    }
    // A clean report lists no contents (observed, CLI 2.1.286), so it cannot
    // show that hooks.json was read. The selftest proves the validator reads it
    // (each malformation must go red); this proves there was something to read.
    if (needsHooks && !existsSync(join(target, 'hooks', 'hooks.json'))) {
      reasons.push(`${label}: hooks.json was not among the validated contents — nothing about the wiring was checked`);
    }
    // Exit status must agree with the content verdict; disagreement means the
    // report shape changed under us, and the content rule above is the authority.
    if ((status === 0) !== (report.success === true)) {
      reasons.push(`${label}: exit ${status} disagrees with success=${report.success}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const { ok, reasons } = checkPluginValidate(root);
  if (!ok) {
    console.error('plugin validate --strict FAILED:');
    for (const r of reasons) console.error(`  - ${r}`);
    process.exit(1);
  }
  console.log('plugin validate --strict ok: plugin + marketplace, hooks.json inspected, no errors or warnings');
}

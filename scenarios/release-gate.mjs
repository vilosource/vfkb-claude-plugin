#!/usr/bin/env node
// ============================================================================
// Deterministic release gate (vfkb ADR-0050 — the DoD Brake)
// ----------------------------------------------------------------------------
// The non-negotiable rule: nothing user-facing ships without a full sandboxed,
// agent-driven L4 proof (DEMONSTRATED ≥2/3, committed record). An LLM (or a
// human in a hurry) can skip a prose rule — this check cannot be skipped: it
// runs in CI on every PR and FAILS unless every required scenario record
//   (a) exists,
//   (b) says demonstrated: true, and
//   (c) was produced against THIS plugin version (record.pluginVersion ===
//       plugin.json version) — so bumping the version without re-running the
//       L4 suite goes red, deterministically, with no API/auth needed in CI.
//
// The gate does NOT run the live L4s itself (they are metered and need claude
// auth); it verifies their committed evidence. Add every new user-facing
// capability's scenario slug to REQUIRED when the capability lands.
//   node scenarios/release-gate.mjs
// ============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(process.argv[1], '../..');
const REQUIRED = ['brief-skill'];

const version = JSON.parse(
  readFileSync(join(REPO, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'),
).version;

let failed = false;
for (const slug of REQUIRED) {
  const path = join(REPO, 'scenarios', 'records', `${slug}.json`);
  if (!existsSync(path)) {
    console.error(`GATE FAIL: missing record scenarios/records/${slug}.json — run scenarios/${slug}.mjs`);
    failed = true;
    continue;
  }
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  if (rec.demonstrated !== true) {
    console.error(`GATE FAIL: ${slug} record is not DEMONSTRATED (wired ${rec.wired}/${rec.trials})`);
    failed = true;
  } else if (rec.pluginVersion !== version) {
    console.error(
      `GATE FAIL: ${slug} record was produced against plugin ${rec.pluginVersion}, ` +
        `but plugin.json is ${version} — re-run scenarios/${slug}.mjs against this version`,
    );
    failed = true;
  } else {
    console.log(`gate ok: ${slug} DEMONSTRATED ${rec.wired}/${rec.trials} @ v${rec.pluginVersion} (${rec.generated})`);
  }
}

if (failed) process.exit(1);
console.log(`release gate PASSED for plugin v${version}`);

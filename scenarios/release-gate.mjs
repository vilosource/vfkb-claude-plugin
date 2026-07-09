#!/usr/bin/env node
// ============================================================================
// Deterministic release gate (vfkb ADR-0050 / ADR-0051 — the DoD Brake)
// ----------------------------------------------------------------------------
// The non-negotiable rule: nothing user-facing ships without a full sandboxed,
// agent-driven L4 proof (DEMONSTRATED >=2/3, committed record). An LLM (or a
// human in a hurry) can skip a prose rule — this check cannot be skipped: it
// runs in CI on every PR.
//
// Three Brakes, all deterministic. No LLM, no auth, no network.
//
//   1. EVIDENCE   Every required scenario record exists, is bound to THIS
//                 plugin version, and MEETS the ADR-0022 criterion — which the
//                 gate RECOMPUTES from the per-trial observations. It never
//                 reads a `demonstrated` or `passed` field; a record asserting
//                 its own verdict is not evidence (RFC-024 §2a).
//
//   2. PACKAGING  Every component the plugin declares exists in the tree that
//                 ships: declared skills, the agents their frontmatter names,
//                 the bundles hooks.json/.mcp.json invoke, and parseable JSON.
//                 Catches "released without the skill" at zero cost. It does
//                 NOT prove the plugin installs — nothing deterministic can
//                 (RFC-024 §2b).
//
//   3. DELIVERY   Delivery/upgrade is a capability, and it has never been
//                 proven for this plugin. Per the operator's Reading B ruling
//                 (ADR-0051) releases may continue — THE VIOLATION IS SILENCE.
//                 So DELIVERY-STATUS.json must match what the evidence
//                 actually supports, and while delivery is unproven the README
//                 must carry the disclosure verbatim. The status is DERIVED
//                 from the record, never trusted from the field (RFC-024 §6).
//
//   node scenarios/release-gate.mjs          # gate this repo
// ============================================================================
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Scenario records the gate requires, and the arm roles it recomputes against.
const REQUIRED = ['brief-skill'];

// The plugin's declared surface. A tree missing any of these is a broken
// release. This list is the declaration of record: a deleted skill directory
// cannot declare its own absence, so it cannot be derived from the tree.
const DECLARED = { skills: ['vfkb', 'brief'], agents: ['briefer'] };

// The scenario whose committed record — and only that record — flips delivery
// from `unproven` to `proven` (RFC-024 §4; the L4 is specified and gated).
const DELIVERY_PROOF = 'install-path';

// ---------------------------------------------------------------------------
// ADR-0022:72, recomputed. `positive` arms must hit; `contrast` arms must not.
// For trials=3 this is the familiar ">=2/3, contrast <=1/3".
// ---------------------------------------------------------------------------
const threshold = (role, trials) =>
  role === 'positive'
    ? { min: Math.ceil((2 * trials) / 3) }
    : { max: Math.floor(trials / 3) };

/** Count the trials in an arm that satisfy every observed predicate. */
const hits = (arm) =>
  arm.trials.filter((t) => arm.predicate.every((p) => t[p] === true)).length;

/**
 * Recompute a record's verdict from its per-trial observations.
 * Returns { ok, reasons } — never reads rec.demonstrated / arm.passed.
 */
export function verdict(rec) {
  const reasons = [];
  if (rec.recordVersion !== 2) {
    reasons.push(
      `record is shape v${rec.recordVersion ?? 1}; the gate requires v2 ` +
        `(per-arm {role, predicate, trials[]}) so the verdict can be recomputed ` +
        `rather than read — re-run the scenario`,
    );
    return { ok: false, reasons };
  }
  if (!Number.isInteger(rec.trials) || rec.trials < 1) {
    reasons.push(`record declares trials=${rec.trials}`);
    return { ok: false, reasons };
  }
  const arms = Object.entries(rec.arms ?? {});
  if (arms.length === 0) reasons.push('record declares no arms');
  let sawPositive = false;
  let sawContrast = false;

  for (const [name, arm] of arms) {
    if (!['positive', 'contrast'].includes(arm.role)) {
      reasons.push(`arm "${name}" has unknown role ${JSON.stringify(arm.role)}`);
      continue;
    }
    if (!Array.isArray(arm.predicate) || arm.predicate.length === 0) {
      reasons.push(`arm "${name}" declares no predicate — nothing to observe`);
      continue;
    }
    if (!Array.isArray(arm.trials) || arm.trials.length !== rec.trials) {
      reasons.push(
        `arm "${name}" carries ${arm.trials?.length ?? 0} trials but the record declares ${rec.trials}`,
      );
      continue;
    }
    const n = hits(arm);
    const t = threshold(arm.role, rec.trials);
    if (arm.role === 'positive') {
      sawPositive = true;
      if (n < t.min) {
        reasons.push(
          `positive arm "${name}" hit ${n}/${rec.trials} on [${arm.predicate}], needs >=${t.min}`,
        );
      }
    } else {
      sawContrast = true;
      if (n > t.max) {
        reasons.push(
          `contrast arm "${name}" leaked ${n}/${rec.trials} on [${arm.predicate}], allows <=${t.max}`,
        );
      }
    }
  }
  // A proof that cannot fail proves nothing (ADR-0029).
  if (arms.length && !sawPositive) reasons.push('record has no positive arm');
  if (arms.length && !sawContrast) reasons.push('record has no contrast arm — the proof cannot fail');

  return { ok: reasons.length === 0, reasons };
}

/** Validate one scenario record end-to-end. Returns { ok, reasons }. */
function checkRecord(repo, slug, version) {
  const path = join(repo, 'scenarios', 'records', `${slug}.json`);
  if (!existsSync(path)) {
    return { ok: false, reasons: [`missing record scenarios/records/${slug}.json — run scenarios/${slug}.mjs`] };
  }
  let rec;
  try {
    rec = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { ok: false, reasons: [`record scenarios/records/${slug}.json is not valid JSON: ${e.message}`] };
  }
  const { ok, reasons } = verdict(rec);
  if (rec.pluginVersion !== version) {
    reasons.push(
      `record was produced against plugin ${rec.pluginVersion}, but plugin.json is ${version} ` +
        `— re-run scenarios/${slug}.mjs against this version`,
    );
  }
  return { ok: ok && rec.pluginVersion === version, reasons, rec };
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const nonEmptyFile = (p) => existsSync(p) && statSync(p).isFile() && statSync(p).size > 0;

/** Frontmatter `key: value` lookup, good enough for SKILL.md's flat header. */
function frontmatter(text, key) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return undefined;
  const line = m[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim();
}

// ---------------------------------------------------------------------------
// Brake 2 — structural packaging
// ---------------------------------------------------------------------------
function checkPackaging(repo) {
  const fails = [];
  const P = join(repo, 'plugin');

  for (const skill of DECLARED.skills) {
    const md = join(P, 'skills', skill, 'SKILL.md');
    if (!nonEmptyFile(md)) {
      fails.push(`declared skill "${skill}" is missing from the shipped tree (plugin/skills/${skill}/SKILL.md)`);
      continue;
    }
    // A skill that forks to an agent must ship that agent.
    const ref = frontmatter(readFileSync(md, 'utf8'), 'agent');
    if (ref) {
      const name = ref.includes(':') ? ref.split(':').pop() : ref;
      if (!nonEmptyFile(join(P, 'agents', `${name}.md`))) {
        fails.push(`skill "${skill}" declares agent "${ref}" but plugin/agents/${name}.md is missing or empty`);
      }
    }
  }
  for (const agent of DECLARED.agents) {
    if (!nonEmptyFile(join(P, 'agents', `${agent}.md`))) {
      fails.push(`declared agent "${agent}" is missing from the shipped tree (plugin/agents/${agent}.md)`);
    }
  }

  // Wiring must parse, and every bundle it invokes must actually be there.
  const wiring = [join(P, 'hooks', 'hooks.json'), join(P, '.mcp.json'), join(P, '.claude-plugin', 'plugin.json')];
  const referenced = new Set();
  for (const f of wiring) {
    if (!existsSync(f)) {
      fails.push(`missing ${f.slice(repo.length + 1)}`);
      continue;
    }
    const raw = readFileSync(f, 'utf8');
    try {
      JSON.parse(raw);
    } catch (e) {
      fails.push(`${f.slice(repo.length + 1)} does not parse: ${e.message}`);
      continue;
    }
    for (const m of raw.matchAll(/dist\/bundles\/[A-Za-z0-9._-]+\.mjs/g)) referenced.add(m[0]);
  }
  for (const rel of referenced) {
    if (!nonEmptyFile(join(P, rel))) {
      fails.push(`wiring invokes plugin/${rel} but it is missing or empty — the vendored bundle did not ship`);
    }
  }

  // The marketplace must point at a plugin that exists.
  const mp = join(repo, '.claude-plugin', 'marketplace.json');
  if (!existsSync(mp)) fails.push('missing .claude-plugin/marketplace.json');
  else {
    for (const p of readJson(mp).plugins ?? []) {
      if (!existsSync(join(repo, p.source, '.claude-plugin', 'plugin.json'))) {
        fails.push(`marketplace lists plugin "${p.name}" at ${p.source}, which has no .claude-plugin/plugin.json`);
      }
    }
  }
  return fails;
}

// ---------------------------------------------------------------------------
// Brake 3 — delivery honesty (ADR-0051, Reading B: the violation is silence)
// ---------------------------------------------------------------------------
function checkDelivery(repo, version) {
  const fails = [];
  const path = join(repo, 'DELIVERY-STATUS.json');
  if (!existsSync(path)) {
    return ['missing DELIVERY-STATUS.json — delivery status must be machine-readable (ADR-0051)'];
  }
  let st;
  try {
    st = readJson(path);
  } catch (e) {
    return [`DELIVERY-STATUS.json does not parse: ${e.message}`];
  }
  if (!['proven', 'unproven'].includes(st.delivery)) {
    fails.push(`DELIVERY-STATUS.json declares delivery=${JSON.stringify(st.delivery)}; expected "proven" or "unproven"`);
    return fails;
  }

  // DERIVED from committed evidence — the field is a claim, this is the check.
  // It flips to `proven` only, and automatically, when the record lands.
  const proof = checkRecord(repo, DELIVERY_PROOF, version);
  const derived = proof.ok ? 'proven' : 'unproven';

  if (st.delivery !== derived) {
    if (st.delivery === 'proven') {
      fails.push(
        `DELIVERY-STATUS.json claims delivery is PROVEN, but scenarios/records/${DELIVERY_PROOF}.json ` +
          `does not support it: ${proof.reasons.join('; ')}`,
      );
    } else {
      fails.push(
        `scenarios/records/${DELIVERY_PROOF}.json is DEMONSTRATED and version-bound, but ` +
          `DELIVERY-STATUS.json still says "unproven" — flip it to "proven" and drop the disclosure`,
      );
    }
    return fails;
  }

  if (derived === 'unproven') {
    const disclosure = (st.disclosure ?? '').trim();
    if (!disclosure) {
      fails.push('DELIVERY-STATUS.json is "unproven" but carries no `disclosure` string to enforce');
      return fails;
    }
    const readme = join(repo, 'README.md');
    const text = existsSync(readme) ? readFileSync(readme, 'utf8') : '';
    // Compare through Markdown: the disclosure may be quoted, bolded, and
    // rewrapped. Strip blockquote markers and emphasis, collapse whitespace.
    const norm = (s) =>
      s
        .replace(/^[ \t]*>+[ \t]?/gm, '')
        .replace(/[*_`]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    if (!norm(text).includes(norm(disclosure))) {
      fails.push(
        `delivery is unproven and README.md does not carry the disclosure verbatim.\n` +
          `         Required: ${disclosure}\n` +
          `         Reading B (ADR-0051) permits shipping with delivery unproven. It does not permit silence.`,
      );
    }
  }
  return fails;
}

// ---------------------------------------------------------------------------
export function runGate(repo) {
  const failures = [];
  const notes = [];

  const version = readJson(join(repo, 'plugin', '.claude-plugin', 'plugin.json')).version;

  for (const slug of REQUIRED) {
    const r = checkRecord(repo, slug, version);
    if (!r.ok) failures.push(...r.reasons.map((m) => `[evidence] ${slug}: ${m}`));
    else {
      const arms = Object.entries(r.rec.arms)
        .map(([n, a]) => `${n} ${hits(a)}/${r.rec.trials}`)
        .join(', ');
      notes.push(`evidence ok: ${slug} recomputed DEMONSTRATED (${arms}) @ v${version}`);
    }
  }
  failures.push(...checkPackaging(repo).map((m) => `[packaging] ${m}`));
  if (!failures.some((f) => f.startsWith('[packaging]'))) {
    notes.push(`packaging ok: ${DECLARED.skills.length} skills, ${DECLARED.agents.length} agents, bundles present`);
  }
  const delivery = checkDelivery(repo, version);
  failures.push(...delivery.map((m) => `[delivery] ${m}`));
  if (delivery.length === 0) notes.push('delivery ok: status matches the committed evidence');

  return { failures, notes, version };
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { failures, notes, version } = runGate(repo);
  for (const n of notes) console.log(n);
  for (const f of failures) console.error(`GATE FAIL: ${f}`);
  if (failures.length) {
    console.error(`\nrelease gate FAILED for plugin v${version} (${failures.length} problem(s))`);
    process.exit(1);
  }
  console.log(`\nrelease gate PASSED for plugin v${version}`);
}

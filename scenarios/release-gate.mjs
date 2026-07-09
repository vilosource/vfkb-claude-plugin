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
//                 plugin version, carries N>=3 trials (ADR-0022 §5), and MEETS
//                 the ADR-0022 criterion — which the gate RECOMPUTES from the
//                 per-trial observations. It never reads a `demonstrated` or
//                 `passed` field; a record asserting its own verdict is not
//                 evidence (RFC-024 §2a).
//
//                 KNOWN LIMIT, stated rather than implied: the gate recomputes
//                 the verdict from each trial's boolean observations, but those
//                 booleans are not themselves rederived from raw evidence — the
//                 records truncate `out`, so the sentinel a trial claims to have
//                 seen is not in the record to check. A hand-forged record can
//                 still pass. This closes RFC-024 §2a's specific bug (a
//                 `demonstrated:true` record with a failing arm) but not the
//                 whole class. Closing it needs the records to carry their raw
//                 evidence, which needs the L4s re-run. Not done; not claimed.
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

// ADR-0022 §5 — "Each scenario runs N=3 trials".
const MIN_TRIALS = 3;

// The plugin's declared surface. A tree missing any of these is a broken
// release. This list is the declaration of record: a deleted skill directory
// cannot declare its own absence, so it cannot be derived from the tree.
// It is checked in BOTH directions — a skill present in the tree but absent
// here would otherwise ship entirely unchecked, and the list would rot in
// exactly the way the Brake exists to prevent.
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
  // ADR-0022 §5: "Each scenario runs N=3 trials." The gate previously enforced
  // only the >=2/3 THRESHOLD and silently dropped the SAMPLE SIZE, so a record
  // with trials:1 (positive 1/1, contrast 0/1) passed as DEMONSTRATED — i.e.
  // the hurried single-trial smoke-check release that ADR-0050 was written to
  // stop sailed through the Brake written to stop it.
  if (!Number.isInteger(rec.trials) || rec.trials < MIN_TRIALS) {
    reasons.push(
      `record declares trials=${rec.trials}; ADR-0022 §5 requires N>=${MIN_TRIALS} ` +
        `(a single-shot run cannot separate flakiness from a real result)`,
    );
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
    // A predicate naming a field no trial carries is vacuously unsatisfiable:
    // `hits` is 0 for every trial, so a contrast arm that leaked on all three
    // still "holds". That is the anti-vacuity guarantee (ADR-0029, "a proof
    // that cannot fail proves nothing") failing on its own terms.
    const missing = arm.predicate.filter((p) => arm.trials.some((t) => typeof t[p] !== 'boolean'));
    if (missing.length) {
      reasons.push(
        `arm "${name}" scores on [${missing}], which is not a boolean on every trial — ` +
          `the predicate cannot be evaluated, so the arm would pass vacuously`,
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

// ---------------------------------------------------------------------------
// Markdown → the prose a human actually reads.
//
// ADR-0051's ruling is that THE VIOLATION IS SILENCE, so a disclosure the reader
// never reads does not satisfy the Brake. Three rounds of adversarial review
// beat a regex blacklist here: `<!-- -->`, then a fenced block, then a 4-space
// indented block, `<script>`, `<style>`, `<details>`, and an UNTERMINATED fence
// or comment (which hide everything after them). Each patch invited the next
// syntax.
//
// So this scans blocks and keeps only prose, rather than enumerating hiding
// places. Anything unterminated swallows the rest of the file, exactly as a
// renderer would treat it.
//
// Two corrections from round 4, both found by review, not by the author:
//   - Every classifier was anchored to column 0, so ONE blockquote level
//     (`> ```), `>     indented`, `> <script>`) slipped all of them. The
//     blockquote marker is now peeled BEFORE classifying. `norm()` strips it
//     afterwards anyway, so peeling early costs nothing.
//   - The HTML step was still an enumerated tag list — the very blacklist the
//     rewrite claimed to retire, and `<p style="display:none">` walked past it.
//     ANY raw-HTML block is now dropped. Dropping fails CLOSED, the safe
//     direction for a Brake; an autolink (`<https://…>`) is not a tag.
//
// And one false RED: an unterminated `<!--` inside an inline code span
// (`` Use the `<!--` marker ``) swallowed the rest of the file, blocking an
// honest, disclosing README. A Brake that blocks an honest release is its own
// failure mode, so code spans are masked before the comment scan.

// CommonMark type-1 raw text: content runs to the closing tag, not a blank line.
const RAW_TEXT = /^(script|style|pre|textarea)$/i;
// A line that opens a raw-HTML block. Autolinks and `<3` are not tags.
const HTML_OPEN = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/;
// Blockquote markers, any depth: `>`, `> >`, `>>`.
const QUOTE = /^[ \t]*(?:>[ \t]?)+/;
// Inline code spans — masked so their contents never look like markup.
const maskCodeSpans = (s) => s.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (m) => ' '.repeat(m.length));

function visibleProse(md) {
  const out = [];
  let fence = null;
  let html = null; // {tag, rawText}
  let comment = false;
  let inList = false;

  for (const raw of md.split(/\r?\n/)) {
    // Classify on the line as the reader sees it: peel blockquote markers first.
    let L = raw.replace(QUOTE, '');

    if (comment) {
      const e = L.indexOf('-->');
      if (e < 0) continue; // unterminated: swallows to EOF, as a renderer does
      L = L.slice(e + 3);
      comment = false;
    }
    // Find `<!--` only outside inline code spans, then cut it from the real line.
    for (;;) {
      const s = maskCodeSpans(L).indexOf('<!--');
      if (s < 0) break;
      const e = L.indexOf('-->', s + 4);
      if (e >= 0) L = `${L.slice(0, s)} ${L.slice(e + 3)}`;
      else {
        L = L.slice(0, s);
        comment = true;
        break;
      }
    }

    if (fence) {
      if (new RegExp(`^\\s{0,3}${fence}`).test(L)) fence = null;
      continue;
    }
    const open = L.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = open[1];
      continue;
    }

    if (html) {
      if (html.rawText) {
        if (new RegExp(`</${html.tag}\\s*>`, 'i').test(L)) html = null;
      } else if (L.trim() === '') {
        html = null; // CommonMark type-6/7 blocks end at a blank line
      }
      continue;
    }
    const tag = L.trimStart().match(HTML_OPEN);
    if (tag && !/^<https?:/i.test(L.trimStart())) {
      const rawText = RAW_TEXT.test(tag[1]);
      // A block closed on its own line ends here; otherwise it stays open.
      const closed = rawText
        ? new RegExp(`</${tag[1]}\\s*>`, 'i').test(L)
        : false;
      if (!closed) html = { tag: tag[1], rawText };
      continue;
    }

    // Track list context: an indented line under a list item is a lazy paragraph
    // continuation (prose), not an indented code block.
    if (/^\s{0,3}(?:[-*+]|\d+[.)])\s/.test(L)) inList = true;
    else if (L.trim() !== '' && !/^(?: {4}|\t)/.test(L)) inList = false;

    // Indented code block: 4 spaces or a tab, opening after a blank line,
    // outside any list.
    if (!inList && /^(?: {4}|\t)/.test(L) && (out.length === 0 || out[out.length - 1].trim() === '')) continue;

    out.push(L);
  }
  return out.join('\n');
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const nonEmptyFile = (p) => existsSync(p) && statSync(p).isFile() && statSync(p).size > 0;

/** Frontmatter `key: value` lookup, good enough for SKILL.md's flat header. */
function frontmatter(text, key) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return undefined;
  const line = m[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  // YAML permits `agent: "vfkb:briefer"`; unquoted is what we ship, but a quoted
  // value would otherwise send the gate looking for `agents/briefer".md`.
  return line
    ?.slice(key.length + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

// ---------------------------------------------------------------------------
// Brake 2 — structural packaging
// ---------------------------------------------------------------------------
function checkPackaging(repo) {
  const fails = [];
  const P = join(repo, 'plugin');

  // Drift, the other way: a skill shipped but never declared is a skill no
  // packaging check ever looks at.
  let shipped = [];
  try {
    shipped = readdirSync(join(P, 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    fails.push('plugin/skills is missing or unreadable');
  }
  for (const s of shipped) {
    if (!DECLARED.skills.includes(s)) {
      fails.push(`skill "${s}" ships in the tree but is not declared in the gate's DECLARED list — add it, so it is checked`);
    }
  }

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

  // The marketplace must point at a plugin that exists. It must also parse —
  // an unparseable manifest is a reportable packaging failure, not a stack trace.
  const mp = join(repo, '.claude-plugin', 'marketplace.json');
  if (!existsSync(mp)) fails.push('missing .claude-plugin/marketplace.json');
  else {
    let manifest;
    try {
      manifest = readJson(mp);
    } catch (e) {
      fails.push(`.claude-plugin/marketplace.json does not parse: ${e.message}`);
      return fails;
    }
    for (const p of manifest.plugins ?? []) {
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
    const raw = existsSync(readme) ? readFileSync(readme, 'utf8') : '';

    // Match only in prose the reader actually sees (see visibleProse above),
    // then compare through Markdown: the disclosure may be quoted, bolded, and
    // rewrapped. Strip blockquote markers and emphasis, collapse whitespace.
    // Inline backticks are kept as visible — `code` renders inline.
    const norm = (s) =>
      visibleProse(s)
        .replace(/^[ \t]*>+[ \t]?/gm, '')
        .replace(/[*_`]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    // The disclosure text itself is authored prose; normalize it the same way.
    if (!norm(raw).includes(norm(disclosure))) {
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

  // The plugin manifest is the gate's anchor. If it is missing or malformed the
  // gate must SAY so — an uncaught throw still fails CI, but it fails with a
  // stack trace instead of a finding, and it bypasses the structured report.
  let version;
  try {
    version = readJson(join(repo, 'plugin', '.claude-plugin', 'plugin.json')).version;
  } catch (e) {
    return { failures: [`[packaging] plugin/.claude-plugin/plugin.json is missing or unreadable: ${e.message}`], notes, version: undefined };
  }
  if (typeof version !== 'string' || !version) {
    return { failures: ['[packaging] plugin/.claude-plugin/plugin.json declares no version'], notes, version };
  }

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

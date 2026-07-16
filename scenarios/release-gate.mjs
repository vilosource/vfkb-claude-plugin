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
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from './vendor/marked.esm.mjs';

// The gate's single dependency, vendored verbatim (scenarios/vendor/PROVENANCE.md).
// Verified on every run: a vendored blob nobody can check is its own trust problem.
const MARKED_SHA256 = '35398f546525d5e79a8f2f8738635d3ecbd277618cba2ada874e9d27dc9e88f0';

// Scenario records the gate requires, and the arm roles it recomputes against.
const REQUIRED = ['brief-skill', 'hooks-smoke', 'inactive-signal'];

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
// Deterministic content hash of a shipped tree (issue #22 — tree-binding).
//
// Version-binding alone leaves a gap: a SECOND plugin/ change landing under a
// still-unreleased (already-bumped) version keeps every version check green
// while the delivery record silently proves the EARLIER tree. So the delivery
// record also carries the sha256 of the exact plugin/ tree its run installed,
// and checkDelivery recomputes it against the tree being shipped. Pure
// filesystem (sorted relative paths + bytes) — no git, preserving the gate's
// "no LLM, no auth, no network" property. Exported: install-path.mjs stamps
// records with the SAME function, so runner and Brake can never disagree.
// ---------------------------------------------------------------------------
export function hashTree(dir) {
  const root = resolve(dir); // tolerate a trailing slash (installPath is used verbatim)
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(root);
  const h = createHash('sha256');
  for (const f of files.sort()) {
    // Length-safe framing (review of #27): raw byte concatenation let a file
    // whose CONTENT embeds "\0<path>\0" collide with the multi-file tree it
    // mimics. A NUL-terminated path (paths cannot contain NUL) followed by the
    // fixed-width DIGEST of the content is unambiguous.
    h.update(f.slice(root.length + 1));
    h.update('\0');
    h.update(createHash('sha256').update(readFileSync(f)).digest());
  }
  return h.digest('hex');
}

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
// Markdown → the text a human actually reads.
//
// ADR-0051 rules that THE VIOLATION IS SILENCE, so a disclosure the reader never
// reads does not satisfy the Brake. Deciding *what renders* is a property of the
// renderer, and five rounds of adversarial review proved a hand-rolled scanner
// cannot decide it: each version leaked one way (the disclosure hidden in an
// HTML comment, a fenced block, an indented block, `<script>`, `<style>`, an
// unterminated fence, a blockquote-nested fence, a list-nested fence) or
// over-rejected the other (an `<img>` badge line above the disclosure paragraph
// blocked an honest release). Ten-plus holes, none found by the author.
//
// So the markdown is rendered by a real CommonMark implementation, and the
// question becomes what to remove from the RENDERED output:
//
//   <pre>, <code>   — exhibited as sample output, not stated as prose
//   <script>, <style> — GitHub's sanitizer drops these entirely: literal silence
//   <details>       — renders collapsed; the reader must click to see it
//   <!-- -->        — invisible everywhere
//
// Everything else keeps its text: `<br>`, `<img>`, `<table>`, `<div>` and any
// other passthrough HTML render their content, so they must not hide it.
//
// Deliberately stricter than GitHub in two places, both failing CLOSED:
//   - `<details>` content is treated as unread (it renders collapsed).
//   - an element carrying `hidden` or `style="display:none"` is treated as
//     invisible. GitHub's sanitizer probably strips `style` and renders it
//     anyway — but that is a claim about a proprietary sanitizer we cannot
//     verify, and a Brake must not stake the disclosure on it. The cost of
//     being wrong is a false RED on a README that hides its own disclosure in
//     a `display:none` div, which is not a README anyone writes honestly.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };
const decodeEntities = (s) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    const key = e.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (/^#/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return m;
  });

// `pre` covers exhibited blocks (and the `<code>` marked nests inside it).
// Inline `<code>` is NOT dropped: it renders, so a disclosure written with
// backticks must still count. Dropping it silently rejected any operator-authored
// disclosure containing inline code.
const DROP = ['pre', 'script', 'style', 'details'];

// Elements that cannot contain anything, so they can never hide anything.
const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

// Any opening tag. Whether it HIDES is decided by parsing its attributes, not by
// looking for the substring "hidden" — `<img alt="logo hidden on print">` and
// `<div title="not hidden ">` are both perfectly visible, and a substring match
// on them dropped the rest of the document.
const OPEN_TAG = /<([a-z][a-z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
const ATTR = /([a-z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;

function hidesContent(attrs) {
  ATTR.lastIndex = 0;
  for (let a; (a = ATTR.exec(attrs)); ) {
    const name = a[1].toLowerCase();
    const value = a[2] ?? a[3] ?? a[4];
    // `hidden` is an HTML boolean attribute: its PRESENCE hides the element.
    // `hidden="false"` still hides. An earlier carve-out for that value read as
    // sensible and was spec-wrong — and it failed OPEN, which is the wrong
    // direction: an author could hide the disclosure behind markup that reads
    // "not hidden" to a reviewer skimming the diff.
    if (name === 'hidden') return true;
    if (name === 'style' && /display\s*:\s*none/i.test(value ?? '')) return true;
  }
  return false;
}

// Inline elements sit INSIDE a sentence: replacing them with a space inserts one
// that the author never wrote. `run <code>verify</code>.` became `run verify .`,
// so any disclosure ending a clause with inline code or emphasis could never
// match its own README — a denial-of-release on fully visible text. Block-level
// elements are boundaries and DO become a space.
const INLINE = /^(a|abbr|b|bdi|bdo|cite|code|data|del|dfn|em|i|ins|kbd|mark|q|rp|rt|ruby|s|samp|small|span|strong|sub|sup|time|u|var|wbr)$/i;
const stripTags = (html) =>
  html.replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (_m, tag) => (INLINE.test(tag) ? '' : ' '));

/** The text a reader sees when GitHub renders this markdown. */
function renderVisibleText(md) {
  let html = marked.parse(md, { async: false });
  html = html.replace(/<!--[\s\S]*?(-->|$)/g, ' ');
  for (const tag of DROP) {
    // Unterminated elements swallow to end of document, as a parser would.
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?(</${tag}\\s*>|$)`, 'gi'), ' ');
  }

  // Elements hidden by attribute, and everything they contain. The loop runs
  // until no hidden element remains: an earlier `guard < 100` bound stopped
  // SILENTLY, so a README with 120 hidden decoys followed by a hidden wrapper
  // left the disclosure "visible" and the gate green. A Brake that gives up
  // quietly is worse than one that fails. This bound only catches a
  // non-shrinking loop, and it raises rather than returns a wrong answer.
  for (let guard = 0; ; guard++) {
    if (guard > 10000) throw new Error('hidden-element removal did not converge');
    OPEN_TAG.lastIndex = 0;
    let m;
    let hit = null;
    while ((m = OPEN_TAG.exec(html))) {
      if (hidesContent(m[2])) {
        hit = m;
        break;
      }
    }
    if (!hit) break;
    const tag = hit[0];
    const name = hit[1];
    const start = hit.index;
    if (VOID.test(name)) {
      // A void element hides nothing; drop the tag alone. Truncating here is
      // what turned an <img alt="…hidden…"> into a deleted document.
      html = html.slice(0, start) + ' ' + html.slice(start + tag.length);
      continue;
    }
    const rest = html.slice(start + tag.length);
    const end = rest.search(new RegExp(`</${name}\\s*>`, 'i'));
    // No closing tag: the element is open to the end, so it hides the rest.
    html = html.slice(0, start) + ' ' + (end < 0 ? '' : rest.slice(end));
  }
  return decodeEntities(stripTags(html));
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

  // Tree-binding (issue #22): the delivery record must prove THIS plugin/ tree,
  // not merely this version string. A record without a pluginTreeHash predates
  // the honesty fix and cannot support `proven`; a mismatched one proves a tree
  // that is not the one shipping.
  if (proof.ok) {
    const want = proof.rec.pluginTreeHash;
    if (typeof want !== 'string' || !want) {
      proof.ok = false;
      proof.reasons.push(
        `record carries no pluginTreeHash, so it cannot prove which plugin/ tree its run installed ` +
          `— re-run scenarios/${DELIVERY_PROOF}.mjs (records are tree-bound since issue #22)`,
      );
    } else {
      // A finding, not a stack trace (review of #27) — a dangling symlink or
      // unreadable file in plugin/ must be reported like every other failure.
      let got = '';
      try {
        got = hashTree(join(repo, 'plugin'));
      } catch (e) {
        proof.ok = false;
        proof.reasons.push(`could not hash the shipping plugin/ tree: ${e.message}`);
      }
      if (proof.ok && got !== want) {
        proof.ok = false;
        proof.reasons.push(
          `record proves plugin/ tree ${want.slice(0, 12)}…, but the tree shipping now hashes ` +
            `${got.slice(0, 12)}… — plugin/ changed after the record was pinned; re-run ` +
            `scenarios/${DELIVERY_PROOF}.mjs against this tree`,
        );
      }
    }
  }
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

    // Render BOTH sides through the same pipeline. The disclosure in
    // DELIVERY-STATUS.json is authored markdown too — it may carry `inline code`
    // or **emphasis** — so normalizing one side by hand (stripping backticks but
    // not asterisks, say) makes an honest README unmatchable against its own
    // disclosure. Rendering both is the only symmetry that holds for every
    // markdown construct an operator might write.
    const flatten = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    let visible;
    let wanted;
    try {
      visible = renderVisibleText(raw);
      wanted = renderVisibleText(disclosure);
    } catch (e) {
      // A malformed README must produce a finding, not a stack trace.
      fails.push(`README.md could not be rendered to check the disclosure: ${e.message}`);
      return fails;
    }
    // A disclosure that renders to nothing makes `.includes()` vacuously true and
    // switches this Brake off silently — `disclosure: "<!-- unproven -->"` or
    // `"<div hidden>…</div>"` passes against a README that says nothing at all.
    // The raw-field emptiness check above cannot see it: the field is non-empty,
    // its RENDERED form is not. A near-empty one ("." matches every README) is
    // the same defect wearing a shorter string.
    const MIN_DISCLOSURE = 20;
    if (flatten(wanted).length < MIN_DISCLOSURE) {
      fails.push(
        `DELIVERY-STATUS.json's \`disclosure\` renders to ${JSON.stringify(flatten(wanted))} ` +
          `(${flatten(wanted).length} visible chars, minimum ${MIN_DISCLOSURE}) — a disclosure that renders to ` +
          `nothing matches every README and disables this check. Write it as plain, visible prose.`,
      );
      return fails;
    }
    if (!flatten(visible).includes(flatten(wanted))) {
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
/**
 * The gate's one dependency must be the bytes we vendored, or nothing below
 * means anything. It checks the renderer this process actually LOADED — next to
 * the script, not inside `repo` — so a fixture tree cannot make it pass.
 * `file` is injectable purely so the selftest can watch it go red (ADR-0029).
 */
export function checkVendor(file = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'marked.esm.mjs')) {
  if (!existsSync(file)) return [`vendored markdown renderer is missing (${file})`];
  const got = createHash('sha256').update(readFileSync(file)).digest('hex');
  return got === MARKED_SHA256
    ? []
    : [`vendored marked.esm.mjs has sha256 ${got}, expected ${MARKED_SHA256} — see scenarios/vendor/PROVENANCE.md`];
}

export function runGate(repo) {
  const failures = [];
  const notes = [];

  const vendor = checkVendor();
  failures.push(...vendor.map((m) => `[vendor] ${m}`));
  if (vendor.length === 0) notes.push('vendor ok: marked.esm.mjs matches its recorded sha256');

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

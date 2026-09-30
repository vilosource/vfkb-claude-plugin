#!/usr/bin/env node
// ============================================================================
// /vfkb:brief L4 purpose scenario (vfkb ADR-0049 Layer 1 / ADR-0050 gate)
// ----------------------------------------------------------------------------
// Proves the PURPOSE of the /vfkb:brief skill THROUGH THE REAL PLUGIN SURFACE:
// a session that loads THIS plugin (--plugin-dir) and invokes /vfkb:brief gets
// a faithful session-start brief whose "what's next" is the brain's recorded
// handoff — produced by the plugin-shipped, HAIKU-PINNED briefer agent.
//
// CAUSAL DESIGN (only variable = the handoff behind the vendored engine):
//   - wired arm: sandbox git project whose .vfkb holds a handoff fact naming an
//     unguessable sentinel next-step (seeded via the VENDORED CLI);
//   - contrast arm: identical sandbox, brain WITHOUT the handoff — the brief
//     must say UNKNOWN, not fabricate (sentinel unguessable => contrast ≈ 0).
//   - freshlyWired arm (#321): `.vfkb/` PRESENT but entries.jsonl ABSENT — a
//     project's FIRST session. The brief must brief from git and report no
//     prior continuity; it must NOT claim the project "isn't using vfkb".
//
// WHY THE EXISTING TWO ARMS COULD NOT CATCH #321: buildSandbox seeds a gotcha
// through the vendored CLI on BOTH arms, so entries.jsonl always existed and
// the freshly-wired state was never exercised. The contrast arm's predicate
// ("don't fabricate the sentinel") is also satisfied BY the bug — a skill that
// refuses outright fabricates nothing — so the existing record stayed green
// while the first-run experience was broken. A contrast arm that the bug can
// satisfy is not coverage.
//
// OBSERVED, NOT ASSERTED (ADR-0029): a wired trial counts as a hit only if
//   (a) the brief names the sentinel, AND
//   (b) the run's modelUsage contains a *haiku* model — the outer session is
//       pinned to a NON-haiku model, so any haiku usage is attributable to the
//       skill's `context: fork` into agents/briefer.md (model: haiku). This
//       observes the Layer 1 cost pin instead of trusting frontmatter.
//
// VERDICT: DEMONSTRATED iff wired ≥ 2/3 AND wired > contrast (vfkb ADR-0022).
// LIVE + metered. One at a time.
//   node scenarios/brief-skill.mjs
//   VFKB_BS_TRIALS=1 node scenarios/brief-skill.mjs
// ============================================================================
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verdict, hashTree } from './release-gate.mjs';
import { stageAuth, authEnv, redactSecrets, producedBy, assertAuthReady } from './auth.mjs';
// The freshlyWired arm's output predicates live in their own module because they
// decide a required gate arm, and the first version of them was broken in both
// directions (review of #60: fired on the affirmative, missed 14/18 refusal
// wordings). They are pinned by brief-predicates.selftest.mjs, which runs in CI.
import { producedBrief, briefSections, refusalShapes, REFUSAL_SHAPES, acknowledgesEmptyState } from './brief-predicates.mjs';
assertAuthReady();

const REPO = resolve(process.argv[1], '../..');
const PLUGIN = join(REPO, 'plugin');
const CLI = join(PLUGIN, 'dist', 'bundles', 'vfkb.mjs');
const TRIALS = Math.max(1, parseInt(process.env.VFKB_BS_TRIALS || '3', 10));
// Outer session model: fixed NON-haiku so haiku-in-modelUsage can only be the fork.
const OUTER_MODEL = process.env.VFKB_BS_OUTER_MODEL || 'claude-sonnet-5';
const TIMEOUT = parseInt(process.env.VFKB_BS_TIMEOUT || '300000', 10);

const SENTINEL = 'copperlark-echo-31';
// #321's arm needs a sentinel the agent can only have got from GIT, since the
// brain is empty by construction. It goes in a commit subject.
const GIT_SENTINEL = 'thornwick-ledger-58';
// The bug's signature is decided by ./brief-predicates.mjs — see its header for
// why this is not an inline regex any more.
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', ...o });

/**
 * @param mode 'handoff' | 'noHandoff' | 'freshlyWired'
 *   'freshlyWired' creates `.vfkb/` and writes NOTHING into it — no engine call
 *   at all — so entries.jsonl genuinely does not exist. That is a project one
 *   `claude plugin install` old, and it is the state #321 reports.
 */
function buildSandbox(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'vfkb-bs-'));
  sh('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, '.vfkb'));
  writeFileSync(join(dir, 'src', 'main.ts'), 'export const main = () => 0;\n');
  sh('git', ['add', '-A'], { cwd: dir });
  // The subject carries #321's git sentinel: with an empty brain it is the ONLY
  // place the agent can learn it, so naming it proves the brief actually read
  // the project instead of refusing.
  const subject = mode === 'freshlyWired'
    ? `chore: scaffold the ${GIT_SENTINEL} parser`
    : 'chore: scaffold';
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', subject], { cwd: dir });
  if (mode === 'freshlyWired') return dir;
  const env = { ...process.env, VFKB_DATA_DIR: join(dir, '.vfkb') };
  const add = (type, text, tags) =>
    sh('node', [CLI, 'add', type, text, '--role', 'human', '--prov-status', 'verified',
        ...(tags ? ['--tag', tags] : [])], { env, stdio: 'ignore' });
  if (mode === 'handoff') {
    add('fact',
      `HANDOFF: ingest refactor shipped and verified end-to-end. The single next step for the ` +
      `next session is the migration codenamed ${SENTINEL}; keep the feature flag off until the ` +
      `backfill verifier reports clean. Everything else is blocked behind it.`,
      'handoff,next,status');
  }
  add('gotcha', 'shard workers must drain before the schema lock is released');
  return dir;
}

/**
 * The text around the first refusal-diagnostic match, so a fired diagnostic on
 * an otherwise-passing trial is judgeable from the record rather than requiring
 * a re-run. Pure, and exercised by the selftest.
 */
function refusalContext(text) {
  const t = String(text);
  for (const [name, re] of REFUSAL_SHAPES) {
    const m = re.exec(t);
    if (m) {
      const from = Math.max(0, m.index - 60);
      return `${name}: …${t.slice(from, m.index + m[0].length + 60).replace(/\s+/g, ' ')}…`;
    }
  }
  return null;
}

function runArm(dir) {
  let raw = '';
  let err = '';
  try {
    raw = sh('claude', ['-p', '/vfkb:brief', '--plugin-dir', PLUGIN, '--output-format', 'json',
      '--strict-mcp-config', '--dangerously-skip-permissions', '--model', OUTER_MODEL], {
      cwd: dir,
      env: authEnv(process.env),
      timeout: TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    err = redactSecrets(String(e.stderr || e.message || '')).replace(/\s+/g, ' ').slice(0, 160);
    raw = String(e.stdout || '');
  }
  let text = '';
  let models = [];
  try {
    const j = JSON.parse(raw);
    text = String(j.result ?? '');
    models = Object.keys(j.modelUsage ?? {});
  } catch {
    text = raw;
  }
  text = redactSecrets(text);
  const sentinel = text.toLowerCase().includes(SENTINEL);
  const haiku = models.some((m) => m.toLowerCase().includes('haiku'));
  // #321: two observations, both content assertions over the output (ADR-0051
  // cl. 3 — exit status is not admissible). `briefed` is the POSITIVE half: a
  // run that errored and printed nothing would satisfy "no false refusal" while
  // proving nothing, so the arm requires evidence it actually read the project.
  const briefed = text.toLowerCase().includes(GIT_SENTINEL);
  // THE GATING PREDICATE IS STRUCTURAL. Two rounds of review showed that deciding
  // "did it refuse?" by enumerating refusal phrasings cannot be known complete —
  // the second attempt missed 16/18 on a fresh table, and five realistic refusals
  // scored clean HITs. So the arm asks the bounded question the skill's own §5
  // contract answers: did the five-section brief get produced? A refusal emits
  // none of them. See brief-predicates.mjs for the full argument.
  const produced = producedBrief(text);
  // Removing the refusal moved the failure mode from refusing to FABRICATING, so
  // the arm also requires the brief to say the state is empty. Named for what it
  // observes: it sees the ACKNOWLEDGEMENT, not honesty itself.
  const acknowledgedEmpty = acknowledgesEmptyState(text);
  const shapes = refusalShapes(text);
  return { sentinel, haiku, briefed, produced, acknowledgedEmpty,
    // Diagnostic, never gating — so a regression is legible in the record.
    sections: briefSections(text), refusalShapes: shapes, models,
    // When the diagnostic fires on a HIT, the record must be able to say WHY.
    // It fired on one trial at 110 chars of stored output and the match was past
    // the cutoff, so "did a refusal slip through?" was unanswerable from the
    // committed evidence. The excerpt is wider now, and a fired diagnostic also
    // stores the text around its match.
    ...(shapes.length ? { refusalContext: refusalContext(text) } : {}),
    out: text.replace(/\s+/g, ' ').slice(0, 300), err };
}

console.log(`vfkb-claude-plugin brief-skill L4  (outer=${OUTER_MODEL}, trials=${TRIALS})`);
console.log('wired hit = sentinel in brief AND haiku observed in modelUsage (the fork pin)\n');

// Record shape v2 (RFC-024 §2a): each arm declares its role and the predicate
// its trials are judged on, and carries the raw per-trial observations. The
// verdict is never written down — the gate recomputes it from these trials, so
// a hand-edited pass count cannot smuggle a release through.
const arms = {
  wired: { role: 'positive', predicate: ['sentinel', 'haiku'], trials: [] },
  contrast: { role: 'contrast', predicate: ['sentinel'], trials: [] },
  // #321. A second POSITIVE arm, so the gate holds it to the same >=2/3 bar as
  // `wired` and a regression cannot be waved through.
  freshlyWired: { role: 'positive', predicate: ['briefed', 'produced', 'acknowledgedEmpty'], trials: [] },
};
const MODE = { wired: 'handoff', contrast: 'noHandoff', freshlyWired: 'freshlyWired' };
const ARMS = (process.env.VFKB_BS_ARMS || Object.keys(MODE).join(',')).split(',').map((a) => a.trim()).filter(Boolean);
// m3: validate BEFORE anything metered. A typo ('freshlywired') used to delete
// the real arm, spend a live `claude -p`, and only then throw on the push.
const unknown = ARMS.filter((a) => !(a in MODE));
if (unknown.length) {
  console.error(`unknown arm(s) ${unknown.join(', ')} — choices: ${Object.keys(MODE).join(', ')}`);
  process.exit(2);
}
for (const a of Object.keys(arms)) if (!ARMS.includes(a)) delete arms[a];
for (let t = 1; t <= TRIALS; t++) {
  for (const arm of ARMS) {
    const dir = buildSandbox(MODE[arm]);
    process.stdout.write(`  trial ${t}  ${arm.padEnd(9)} … `);
    const r = runArm(dir);
    rmSync(dir, { recursive: true, force: true });
    arms[arm].trials.push(r);
    const tag = arm === 'wired'
      ? (r.sentinel && r.haiku ? 'HIT' : `miss (sentinel=${r.sentinel} haiku=${r.haiku})`)
      : arm === 'freshlyWired'
        ? (r.briefed && r.produced && r.acknowledgedEmpty
          ? `HIT${r.refusalShapes?.length ? ` [diagnostic: ${r.refusalShapes.join('/')} — check refusalContext]` : ''}`
          : `miss (briefed=${r.briefed} produced=${r.produced} ack=${r.acknowledgedEmpty}` +
            ` sections=${r.sections?.length ?? 0}` +
            `${r.refusalShapes?.length ? ` refused-as:${r.refusalShapes.join('/')}` : ''})`)
        : (r.sentinel ? 'LEAK' : 'clean');
    console.log(`${tag}  models=[${r.models}]  — "${r.out}"${r.err ? '  ERR:' + r.err : ''}`);
  }
}

const pluginVersion = JSON.parse(
  readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'),
).version;
const record = {
  scenario: 'brief-skill', recordVersion: 2, pluginVersion,
  // Tree-binding (#28): a version string is not a tree. Between re-vendors the
  // version stays unreleased and may drift, so version-binding alone would let
  // this record prove an EARLIER plugin/ tree while every gate stayed green —
  // the dishonesty #22 closed for the delivery record only.
  pluginTreeHash: hashTree(join(REPO, 'plugin')), outerModel: OUTER_MODEL,
  // pluginTreeHash covers plugin/ only, so the code that SCORED these trials is
  // outside it. verdict() recomputes from the stored booleans, which means the
  // predicates could be weakened afterwards with the gate still green on this
  // record (round-2 MINOR 2). Pin them too.
  predicatesSha256: createHash('sha256')
    .update(readFileSync(join(REPO, 'scenarios', 'brief-predicates.mjs'))).digest('hex'),
  producedBy: producedBy(REPO),
  trials: TRIALS, generated: new Date().toISOString(),
  // Set on a deliberately-reverted run so a baseline record SAYS what it is
  // rather than relying on its filename (ADR-0070 §1: the observed RED is an
  // artifact, not a sentence in a report).
  ...(process.env.VFKB_BS_NOTE ? { note: process.env.VFKB_BS_NOTE } : {}),
  arms,
};

// Judge with the gate's own function, so the runner and the Brake can never
// disagree about what DEMONSTRATED means.
const { ok: demonstrated, reasons } = verdict(record);
const count = (a, p) => (arms[a]?.trials ?? []).filter((r) => p.every((k) => r[k])).length;
const wiredN = count('wired', ['sentinel', 'haiku']);
const contrastN = count('contrast', ['sentinel']);
const freshN = count('freshlyWired', ['briefed', 'produced', 'acknowledgedEmpty']);
console.log(`\nwired: ${wiredN}/${TRIALS} (sentinel+haiku)   |   contrast leaks: ${contrastN}/${TRIALS}` +
  `${arms.freshlyWired ? `   |   freshlyWired: ${freshN}/${TRIALS} (briefed+produced+acknowledgedEmpty)` : ''}`);
console.log(demonstrated
  ? `DEMONSTRATED — /vfkb:brief briefs from the handoff on the pinned haiku fork (ADR-0022, recomputed)`
  : `NOT demonstrated — ${reasons.join('; ')}`);

mkdirSync(join(REPO, 'scenarios/records'), { recursive: true });
// A partial run must never overwrite the version-bound record the gate reads.
// VFKB_BS_RECORD lets a baseline run write beside the release record instead of
// over it. The gate reads records by exact slug, so an extra file is inert.
// Compare the arm SET, not its size: `VFKB_BS_ARMS=wired,wired,wired` has the
// same length as a full run and would have overwritten the release record with a
// one-arm result (round-2 MINOR 3 — the same length-based mistake it replaced).
const armSet = new Set(ARMS);
const partial = Object.keys(MODE).some((a) => !armSet.has(a));
const outName = process.env.VFKB_BS_RECORD
  || (partial ? 'brief-skill.partial.json' : 'brief-skill.json');
writeFileSync(join(REPO, 'scenarios/records', outName), JSON.stringify(record, null, 2) + '\n');
console.log(`record → scenarios/records/${outName} (pluginVersion=${pluginVersion})`);
process.exit(demonstrated ? 0 : 1);

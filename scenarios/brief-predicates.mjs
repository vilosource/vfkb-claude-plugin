// ============================================================================
// Output predicates for the /vfkb:brief L4 (scenarios/brief-skill.mjs)
// ----------------------------------------------------------------------------
// ── WHY THE GATING PREDICATE IS STRUCTURAL, NOT A REFUSAL REGEX ──────────────
// The `freshlyWired` arm added for vfkb#321 scores a trial on what the brief
// SAYS. Two rounds of review tried to decide "did it refuse?" by enumerating the
// ways a model might phrase a refusal, and both failed the same way:
//
//   round 1: the pattern fired on the AFFIRMATIVE ("This project is using
//            vfkb") and missed 14 of 18 refusal wordings.
//   round 2: the rewrite missed 16 of 18 wordings on a FRESH table — "isn't set
//            up for vfkb", "doesn't appear to be a vfkb project", "vfkb is not
//            installed", "No .vfkb directory found", "hasn't been initialised".
//            Five realistic refusals scored clean HITS.
//
// That is not a regex bug twice over, it is the wrong referent. "Every way a
// model can say no" is unbounded, so a negative predicate over it can never be
// known complete — and a miss is a PASS WHILE THE BUG IS LIVE (ADR-0051 cl. 3).
// This repo has the lesson on record: hand the hardest sub-problem to something
// authoritative (vfkb brain `cface5291391`; the same diagnosis as vfkb#319 §5,
// "the selftest was built to hand-approximate `gh`").
//
// The authority here is the SKILL'S OWN CONTRACT. `brief/SKILL.md` §5 mandates
// exactly five named sections. That set is bounded, it is defined by the file
// under test, and a refusal does not emit it. So the gating predicate is
// POSITIVE and structural — did the brief get produced? — and the refusal
// patterns are kept only as a DIAGNOSTIC, never load-bearing.
// ============================================================================

/**
 * The five sections `plugin/skills/brief/SKILL.md` §5 mandates. If that template
 * changes, this list must change with it — that coupling is the point, and it is
 * a bounded list rather than an open-ended guess about phrasing.
 */
export const BRIEF_SECTIONS = [
  ['last-done', /\bLast\s+done\b/i],
  ['moved-since', /\bMoved\s+since\b/i],
  ['whats-next', /\bWhat'?s\s+next\b/i],
  ['open-queue', /\bOpen\s+queue\b/i],
  ['discrepancies', /\bDiscrepanc(?:y|ies)\b/i],
];

/** Which mandated sections the output actually contains. */
export const briefSections = (text) =>
  BRIEF_SECTIONS.filter(([, re]) => re.test(String(text))).map(([name]) => name);

/**
 * THE GATING PREDICATE. Did the skill produce its contracted brief?
 *
 * Four of five rather than five, deliberately: a model occasionally folds two
 * sections together or renames one, and the arm is about "did you brief or did
 * you refuse", not about template pedantry. A refusal emits NONE of them, so the
 * gap between refusing and briefing is four sections wide — far wider than the
 * gap any refusal paraphrase can slip through.
 */
export const MIN_SECTIONS = 4;
export const producedBrief = (text) => briefSections(text).length >= MIN_SECTIONS;

/**
 * Did the brief admit the brain is empty?
 *
 * Round 2 found the first version was ~7 near-verbatim phrases lifted from
 * SKILL.md §1, and that 11 of 11 natural honest phrasings scored FALSE — "the
 * brain is empty", "has no entries yet", "No previous session to report". That
 * direction is fail-safe (a false RED, not a false pass) but it makes a required
 * positive arm flaky, which is the pressure that gets predicates loosened.
 * Broadened accordingly.
 *
 * NAMED FOR WHAT IT OBSERVES. It is `acknowledgesEmptyState`, not `honest`: it
 * sees whether the brief SAID the state is empty, and a brief can say that and
 * still invent a next step afterwards (round-2 MAJOR 3, demonstrated). Observing
 * fabrication properly would need the brief's claims checked against the brain,
 * which this arm does not do. Stated so the field is not read as more than it is.
 */
export const ACKNOWLEDGES_EMPTY = new RegExp([
  // `{1,3}` not a single adjective: trial 3 said "No prior RECORDED continuity",
  // which a one-adjective pattern missed — found by this file's own table.
  String.raw`no\s+(?:(?:prior|previous|recorded|earlier|existing)\s+){1,3}(?:continuity|handoff|session|history|knowledge|entries|context)`,
  String.raw`first\s+(?:recorded\s+|ever\s+)?session`,
  String.raw`no\s+(?:handoff|continuity|entries|history)\s+(?:recorded|found|yet|exists?|to\s+report)`,
  String.raw`nothing\s+(?:has\s+been\s+)?(?:recorded|captured|logged)`,
  String.raw`(?:brain|knowledge\s*base|ledger)\s+is\s+empty`,
  String.raw`empty\s+(?:brain|knowledge\s*base|ledger)`,
  String.raw`(?:has|have|with)\s+no\s+entries`,
  String.raw`no\s+entries\s+(?:yet|recorded|found)`,
  String.raw`\bUNKNOWN\b`,
  String.raw`not\s+recorded`,
  String.raw`no\s+previous\s+session`,
  String.raw`nothing\s+(?:to\s+report|on\s+record)`,
  String.raw`baseline\s+state`,
].join('|'), 'i');
export const acknowledgesEmptyState = (text) => ACKNOWLEDGES_EMPTY.test(String(text));

/**
 * ── DIAGNOSTIC ONLY — NOT GATING ────────────────────────────────────────────
 * Ways a brief can claim the project is not a vfkb project. Recorded per trial
 * so a miss is diagnosable and a regression is legible in the record, but NOT
 * part of any arm's predicate: two rounds established that this enumeration
 * cannot be known complete, and a predicate that cannot be known complete must
 * not decide a gate. `producedBrief` is what decides it.
 *
 * Kept broad rather than minimal, since a false positive here costs nothing.
 */
export const REFUSAL_SHAPES = [
  ['not-using', /\bnot\s+(?:currently\s+|yet\s+)?using\s+vfkb/i],
  ['isnt-using', /\b(?:isn'?t|aren'?t|ain'?t)\s+(?:\w+\s+){0,3}using\s+vfkb/i],
  ['does-not-use', /\bdoes\s*n(?:o|'?)t\s+(?:appear\s+to\s+)?(?:use|have)\s+vfkb/i],
  ['not-a-vfkb-project', /\b(?:not|isn'?t)\s+a\s+vfkb\s+(?:project|repo|repository)\b/i],
  ['not-appear-vfkb-project', /does\s*n(?:o|'?)t\s+(?:appear|seem)\s+to\s+be\s+a\s+vfkb\s+(?:project|repo|repository)/i],
  ['vfkb-not-state', /\bvfkb\s+(?:is\s+|has\s+|hasn'?t\s+|have\s+)?(?:not\s+|isn'?t\s+|been\s+)*(?:being\s+used|in\s+use|installed|present|configured|initiali[sz]ed|set\s+up|enabled|wired|active|available)/i],
  ['not-set-up-for-with', /\b(?:not|isn'?t|hasn'?t\s+been)\s+(?:been\s+)?set\s+up\s+(?:for|with)\s+vfkb/i],
  ['no-vfkb-thing', /\bno\s+\.?vfkb[\/\s]*(?:directory|dir|folder|brain|knowledge\s*base|database|data|store|setup|entries)?\b/i],
  ['lacks-vfkb', /\blacks?\s+a?\s*vfkb\b/i],
  // 'there-is-no-vfkb' was REMOVED: every string it matched was also matched by
  // 'no-vfkb-thing', so it could be deleted with the selftest green (round-2
  // MINOR 1). A shape that cannot be uniquely exercised is not coverage, and
  // contriving a row just to keep it would be the vacuity the selftest exists
  // to prevent.
  ['entries-missing', /entries\.jsonl[^.]{0,60}?(?:does\s*n(?:o|'?)t\s+exist|not\s+found|is\s+missing|missing|absent)/i],
  ['cannot-brief', /\b(?:cannot|can'?t|unable\s+to)\s+(?:produce|generate|create|provide)\s+(?:a\s+)?brief/i],
];

/** Which refusal shapes matched — recorded per trial, never gating. */
export const refusalShapes = (text) =>
  REFUSAL_SHAPES.filter(([, re]) => re.test(String(text))).map(([name]) => name);
export const refusesAsUnwired = (text) => refusalShapes(text).length > 0;

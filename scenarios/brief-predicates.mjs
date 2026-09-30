// ============================================================================
// Output predicates for the /vfkb:brief L4 (scenarios/brief-skill.mjs)
// ----------------------------------------------------------------------------
// WHY THIS IS ITS OWN FILE. The `freshlyWired` arm added for vfkb#321 scores a
// trial on what the brief SAYS, so its predicates are the load-bearing part of
// the proof — and the first version of them was broken in BOTH directions:
//
//   * it fired on the CORRECT answer. A bare `is` alternative made
//     "This project IS USING vfkb" match the refusal pattern, so a good brief
//     scored as a false refusal. That direction makes a required positive arm
//     flaky and invites "fixing" it by loosening the predicate.
//   * it missed 9 of 12 realistic refusal wordings — including
//     "The .vfkb/entries.jsonl file does not exist, so I cannot produce a brief",
//     a refusal keyed on the very defect under test. That direction is worse: it
//     is a PASS while the bug is live, the quiet-success trap of ADR-0051 cl. 3.
//
// A predicate that decides a gate arm needs its own Brake, so these are pure,
// exported, and pinned by scenarios/brief-predicates.selftest.mjs against a
// table of paraphrases — including the ones the old regex missed.
// ============================================================================

/**
 * Ways a brief can claim the project is not a vfkb project. Named, so a failing
 * selftest says WHICH shape regressed instead of just "the regex changed".
 *
 * Note what is deliberately absent: any pattern that can match an affirmative.
 * Every alternative here carries its own negation.
 */
export const REFUSAL_SHAPES = [
  ['not-using', /\bnot\s+(?:currently\s+|yet\s+)?using\s+vfkb/i],
  ['isnt-using', /\b(?:isn'?t|aren'?t|ain'?t)\s+(?:\w+\s+){0,3}using\s+vfkb/i],
  ['does-not-use', /\bdoes\s*n(?:o|'?)t\s+(?:appear\s+to\s+)?(?:use|have)\s+vfkb/i],
  ['not-a-vfkb-project', /\bnot\s+a\s+vfkb\s+(?:project|repo|repository)\b/i],
  // "vfkb is not being used / not configured / not initialised / not set up"
  ['vfkb-not-state', /\bvfkb\s+(?:is\s+|has\s+)?(?:not|isn'?t)\s+(?:been\s+)?(?:being\s+used|in\s+use|configured|initiali[sz]ed|set\s+up|enabled|wired|active)/i],
  ['vfkb-not-appear', /\bvfkb\s+does\s*n(?:o|'?)t\s+(?:appear|seem)\s+to\s+be\s+(?:set\s+up|in\s+use|configured|used|enabled)/i],
  ['not-set-up-with', /\bnot\s+(?:been\s+)?set\s+up\s+with\s+vfkb/i],
  ['no-vfkb-thing', /\bno\s+vfkb\s+(?:brain|knowledge\s*base|database|data|store|setup)\b/i],
  ['there-is-no-vfkb', /\bthere\s+is\s+no\s+vfkb\b/i],
  // The refusal keyed on the defect itself — the old regex could not see this.
  ['entries-missing', /entries\.jsonl[^.]{0,60}?(?:does\s*n(?:o|'?)t\s+exist|not\s+found|is\s+missing|missing|absent)/i],
  ['cannot-brief', /\b(?:cannot|can'?t|unable\s+to)\s+(?:produce|generate|create|provide)\s+(?:a\s+)?brief/i],
];

/**
 * Does this output refuse the project as unwired? TRUE means the #321 bug (or a
 * regression of it) is visible in what the operator was told.
 */
export const refusesAsUnwired = (text) => REFUSAL_SHAPES.some(([, re]) => re.test(String(text)));

/** Which shapes matched — for the trial record, so a miss is diagnosable. */
export const refusalShapes = (text) =>
  REFUSAL_SHAPES.filter(([, re]) => re.test(String(text))).map(([name]) => name);

/**
 * THE HONESTY HALF (review finding M3). Removing the refusal created a NEW risk
 * the old arm could not see: the skill now PROCEEDS and must still fill its
 * five-section template — including "what's next" — from a source that is
 * silent. The failure mode is no longer refusal, it is FABRICATION.
 *
 * So a freshly-wired trial must also be seen acknowledging the empty state,
 * which is exactly what brief/SKILL.md §1 now instructs ("say plainly that
 * there is no prior continuity"). Without this the arm would score a brief that
 * invented a next step as a clean hit.
 */
export const ACKNOWLEDGES_EMPTY = /no\s+prior\s+continuity|first\s+(?:recorded\s+)?session|nothing\s+(?:has\s+been\s+)?recorded|no\s+(?:recorded|previous|prior)\s+(?:handoff|continuity|knowledge|entries)|empty\s+brain|\bUNKNOWN\b|no\s+handoff\s+(?:recorded|found|yet)/i;
export const acknowledgesEmptyState = (text) => ACKNOWLEDGES_EMPTY.test(String(text));

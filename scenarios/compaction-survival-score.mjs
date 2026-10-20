// ============================================================================
// compaction-survival scoring — vfkb ADR-0077 clause 3 as amended by ADR-0078.
//
// ONE module, imported by both the scenario (to classify a trial while it
// runs) and the release gate (to RECOMPUTE every verdict from the recorded
// booleans). Records do not assert their own verdicts.
//
// A trial is VALID only if all seven conditions hold (ADR-0078):
//   noLeak       PostCompact.compact_summary carries no sentinel (normalised;
//                the numeric half alone is a leak too)
//   noToolUse    no tool_use after the compact_boundary
//   compacted    a manual compact_boundary between the /compact input and its result
//   compactionOk no status compact_result:"failed", no "Error during compaction"
//   engaged      the final answer mentions a sentinel, or is exactly "none"
//   answered     the final question got a result before the hard timeout, and
//                results == messages sent
//   awake        wall-clock and monotonic elapsed time agree (no host sleep)
// An invalid trial is never a hit or a miss in either arm.
//
// Hits (over valid trials only):
//   compacted arm: emitted (hook_response SessionStart:compact carries every
//                  sentinel) AND received (the answer names every sentinel)
//   contrast arm:  receivedAny (the answer names ANY sentinel). ADR-0078 left the
//                  partial-leak question open; this settles it conservatively.
//                  A single leaked sentinel is a contrast hit.
// ============================================================================

export const VALIDITY = ['noLeak', 'noToolUse', 'compacted', 'compactionOk', 'engaged', 'answered', 'awake'];
export const MIN_VALID = 3;
export const ATTEMPT_CAP = 6;
export const AWAKE_TOLERANCE_MS = 5000;

/** Lower-case, strip everything but [a-z0-9]. */
export const normalise = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** A sentinel is random, >= 8 chars, letters AND digits (ADR-0078). */
export function validSentinel(s) {
  return typeof s === 'string' && s.length >= 8 && /[a-z]/i.test(s) && /\d/.test(s);
}

/** The digits-only tail of a sentinel, e.g. "8812" from "KUMQUAT-8812". */
const numericHalf = (s) => (String(s).match(/\d{3,}/g) || []).pop() || null;

/** Classify the final answer against the trial's sentinels. */
export function classifyAnswer(answer, sentinels) {
  const n = normalise(answer);
  const present = sentinels.filter((s) => n.includes(normalise(s)));
  const engaged = present.length > 0 || n === 'none';
  return { engaged, received: present.length === sentinels.length, receivedAny: present.length > 0 };
}

/** Does a compaction summary leak any sentinel (whole, or its numeric half)? */
export function summaryLeaks(summary, sentinels) {
  const raw = String(summary ?? '');
  const n = normalise(raw);
  return sentinels.some((s) => n.includes(normalise(s)) || (numericHalf(s) && raw.includes(numericHalf(s))));
}

/**
 * Score one trial from raw observations.
 * @param {object} o
 *   events:     parsed stream-json events, in order
 *   hookLog:    [{ ev, payload }] from the PreCompact/PostCompact loggers
 *   sentinels:  string[]
 *   sent:       number of user messages sent
 *   compactIndex: index (0-based) of the /compact message among those sent
 *   timedOut:   boolean
 *   wallMs, monoMs: elapsed wall-clock and monotonic time
 */
export function scoreTrial(o) {
  const { events, hookLog, sentinels, sent, compactIndex, timedOut, wallMs, monoMs } = o;
  const results = events.filter((e) => e.type === 'result');
  // The k-th result answers the k-th message, because messages are sent only
  // after the previous result (ADR-0078 run requirement).
  const resultIdx = events.map((e, i) => (e.type === 'result' ? i : -1)).filter((i) => i >= 0);
  const beforeCompact = compactIndex > 0 ? resultIdx[compactIndex - 1] : -1;
  const compactResult = resultIdx[compactIndex];
  const boundary = events.findIndex((e, i) => e.type === 'system' && e.subtype === 'compact_boundary'
    && e.compact_metadata?.trigger === 'manual' && i > beforeCompact && (compactResult === undefined || i < compactResult));
  const compacted = boundary >= 0;
  const failedStatus = events.some((e) => e.type === 'system' && e.subtype === 'status' && e.compact_result === 'failed');
  const compactText = compactResult !== undefined ? String(events[compactResult].result ?? '') : '';
  const compactionOk = !failedStatus && !/Error during compaction/i.test(compactText);
  const answered = !timedOut && results.length === sent;
  const finalAnswer = answered ? String(results.at(-1).result ?? '') : '';
  const { engaged, received, receivedAny } = classifyAnswer(finalAnswer, sentinels);
  const post = (hookLog || []).filter((h) => h.ev === 'PostCompact').at(-1);
  // A missing or non-string compact_summary is NOT a clean summary: it means the
  // observation failed, so the trial is invalid (#64 review; ADR-0051 §3).
  const summary = post?.payload?.compact_summary;
  const noLeak = typeof summary === 'string' && !summaryLeaks(summary, sentinels);
  let toolUse = 0;
  if (compacted) {
    for (const e of events.slice(boundary)) {
      if (e.type === 'assistant') for (const c of e.message?.content || []) if (c.type === 'tool_use') toolUse++;
    }
  }
  const noToolUse = compacted && toolUse === 0;
  const emitted = events.some((e) => e.type === 'system' && e.subtype === 'hook_response'
    && /SessionStart:compact/.test(e.hook_name || '') && sentinels.every((s) => JSON.stringify(e).includes(s)));
  const awake = Number.isFinite(wallMs) && Number.isFinite(monoMs) && Math.abs(wallMs - monoMs) <= AWAKE_TOLERANCE_MS;
  return {
    noLeak, noToolUse, compacted, compactionOk, engaged, answered, awake,
    emitted, received, receivedAny,
    finalAnswer: finalAnswer.slice(0, 200),
  };
}

export const isValid = (t) => VALIDITY.every((k) => t[k] === true);
export const compactedHit = (t) => t.emitted === true && t.received === true;
export const contrastHit = (t) => t.receivedAny === true;

/**
 * The gate's scenario-specific rule. Recomputes validity and hits from every
 * recorded attempt; ignores any verdict the record asserts.
 * @returns {string[]} reasons it is NOT demonstrated (empty = DEMONSTRATED)
 */
export function compactionSurvivalReasons(rec) {
  const reasons = [];
  if (rec?.scenario !== 'compaction-survival') reasons.push('record is not a compaction-survival record');
  for (const [name, role] of [['compacted', 'positive'], ['contrast', 'contrast']]) {
    const arm = rec?.arms?.[name];
    if (!arm || arm.role !== role) { reasons.push(`arm "${name}" missing or not role ${role}`); continue; }
    const attempts = arm.attempts;
    if (!Array.isArray(attempts)) { reasons.push(`arm "${name}" records no attempts`); continue; }
    if (attempts.length > ATTEMPT_CAP) reasons.push(`arm "${name}" made ${attempts.length} attempts, cap is ${ATTEMPT_CAP}`);
    for (const [i, t] of attempts.entries()) {
      const missing = [...VALIDITY, 'emitted', 'received', 'receivedAny'].filter((k) => typeof t[k] !== 'boolean');
      if (missing.length) reasons.push(`arm "${name}" attempt ${i + 1} lacks boolean(s) [${missing}] — cannot be recomputed`);
      if (!Array.isArray(t.sentinels) || t.sentinels.length < 2 || !t.sentinels.every(validSentinel)) {
        reasons.push(`arm "${name}" attempt ${i + 1}: sentinels must be >=2, random, >=8 chars, letters and digits`);
      }
    }
    const valid = attempts.filter(isValid);
    if (valid.length < MIN_VALID) {
      reasons.push(`arm "${name}" has ${valid.length} valid trial(s) of ${attempts.length} attempt(s); needs >=${MIN_VALID}`);
      continue;
    }
    if (role === 'positive') {
      const n = valid.filter(compactedHit).length;
      const need = Math.ceil((2 * valid.length) / 3);
      if (n < need) reasons.push(`compacted arm: ${n}/${valid.length} valid trials re-injected and recalled every sentinel, needs >=${need}`);
    } else {
      const n = valid.filter(contrastHit).length;
      if (n > 0) reasons.push(`contrast arm: ${n}/${valid.length} valid trials recalled a sentinel — must be 0 (the proof would not be able to fail)`);
    }
  }
  return reasons;
}

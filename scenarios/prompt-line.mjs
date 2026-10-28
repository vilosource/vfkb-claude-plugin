// ============================================================================
// The observable behind hooks-smoke's promptLineInjected (vfkb#385; vfkb decide
// Q6 40540b29556c and D5). Pure file reading, so it is unit-tested in
// prompt-line.selftest.mjs without a metered run.
//
// Observed 2026-10-28 on CLI 2.1.292 AND on the l4-evidence CI pin 2.1.220
// (Tier-0, one haiku turn each, a JSON-form UserPromptSubmit hook): a
// UserPromptSubmit hook that prints hookSpecificOutput.additionalContext lands
// in the session transcript as
//   {"type":"attachment","attachment":{"type":"hook_additional_context",
//    "hookEvent":"UserPromptSubmit","content":["<the line>"]}, ...}
// while stream-json carries no hook_response event for UserPromptSubmit — so
// the transcript is the observable, not the stream.
// ============================================================================
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Mirrors vfkb src/prompt-nudge.ts PROMPT_NUDGE_LEADIN. If vfkb renames the
// lead-in, the wired arm goes red — the intended coupling.
export const PROMPT_NUDGE_LEADIN = 'vfkb handoff status:';

// Scans every transcript in the sandbox HOME (globbing avoids depending on how
// --resume maps a session id to a file). Returns { found, injected, inSession }:
// found = at least one transcript exists; injected = some record is a
// UserPromptSubmit hook_additional_context attachment carrying the lead-in;
// inSession = that record sits in the T4 session's own transcript.
export function scanTranscripts(projectsDir, sid) {
  const out = { found: false, injected: false, inSession: false, cliVersion: null };
  if (!existsSync(projectsDir)) return out;
  for (const slug of readdirSync(projectsDir)) {
    const dir = join(projectsDir, slug);
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      out.found = true;
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (!out.cliVersion && typeof r.version === 'string') out.cliVersion = r.version;
        const a = r?.attachment;
        if (r?.type !== 'attachment' || a?.type !== 'hook_additional_context' || a?.hookEvent !== 'UserPromptSubmit') continue;
        const content = Array.isArray(a.content) ? a.content.join('\n') : String(a.content ?? '');
        if (content.includes(PROMPT_NUDGE_LEADIN)) {
          out.injected = true;
          if (f === `${sid}.jsonl`) out.inSession = true;
        }
      }
    }
  }
  return out;
}


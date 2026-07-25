// ============================================================================
// The credential seam for the four L4 scenarios (ADR-0067 — hybrid model).
// ----------------------------------------------------------------------------
// Two modes, selected by $VFKB_L4_AUTH:
//
//   oauth (default)  — the laptop leg: stage the operator's claudeAiOauth block
//                      into the sandbox HOME, exactly as the scenarios always
//                      did. Env untouched. Full production fidelity.
//   deepseek-env     — the CI leg: NO credential file anywhere; headless
//                      Claude Code authenticates via ANTHROPIC_BASE_URL +
//                      ANTHROPIC_AUTH_TOKEN against DeepSeek's
//                      Anthropic-compatible endpoint (spike plugin#45 —
//                      full pipeline observed working, marketplace included).
//
// Every record gains a producedBy block (ADR-0067 D5) naming where the run
// happened and the credential KIND — never a value — so the two record
// populations stay distinguishable at a glance.
//
// Secrets: with env auth, a token echoed into an error line would land in a
// committed record's `out`/`err` field. GitHub masks logs, not file contents
// (the RFC-036 D3 lesson). redactSecrets() is applied at every capture point.
// ============================================================================
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const AUTH_MODE = process.env.VFKB_L4_AUTH || 'oauth';
const DEEPSEEK_BASE = 'https://api.deepseek.com/anthropic';

if (!['oauth', 'deepseek-env'].includes(AUTH_MODE)) {
  throw new Error(`VFKB_L4_AUTH=${AUTH_MODE} is not a mode (oauth | deepseek-env)`);
}

// Fail BEFORE anything metered runs, and name the missing thing. An empty
// token does not error fast — observed in the spike: a bad token makes
// `claude -p` HANG to the timeout, which a trial would score as a model miss.
export function assertAuthReady() {
  if (AUTH_MODE === 'deepseek-env') {
    if (!process.env.DEEPSEEK_TOKEN) {
      throw new Error('VFKB_L4_AUTH=deepseek-env but DEEPSEEK_TOKEN is not set — refusing: ' +
        'a missing token hangs the turn and would be scored as a scenario result');
    }
    return;
  }
  const src = join(homedir(), '.claude', '.credentials.json');
  let all;
  try { all = JSON.parse(readFileSync(src, 'utf8')); } catch (e) {
    throw new Error(`oauth mode but ${src} is unreadable: ${e.message}`);
  }
  if (!all.claudeAiOauth) throw new Error(`no claudeAiOauth block in ${src}`);
}

/** Stage credentials into a sandbox HOME. deepseek-env stages nothing — auth is env-only. */
export function stageAuth(homeDir) {
  if (AUTH_MODE === 'deepseek-env') return;
  const all = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
  if (!all.claudeAiOauth) throw new Error('no claudeAiOauth block in ~/.claude/.credentials.json');
  const dir = join(homeDir, '.claude');
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, '.credentials.json');
  writeFileSync(dst, JSON.stringify({ claudeAiOauth: all.claudeAiOauth }));
  chmodSync(dst, 0o600);
}

/**
 * The env a `claude` child runs under. oauth: passthrough (laptop behaviour
 * byte-identical). deepseek-env: strip every ANTHROPIC- and CLAUDE-prefixed
 * var the caller inherited (nothing may leak from the invoking session), then
 * set the endpoint pair.
 */
export function authEnv(baseEnv) {
  if (AUTH_MODE === 'oauth') return baseEnv;
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (/^(ANTHROPIC|CLAUDE)/i.test(k)) continue;
    env[k] = v;
  }
  env.ANTHROPIC_BASE_URL = DEEPSEEK_BASE;
  env.ANTHROPIC_AUTH_TOKEN = process.env.DEEPSEEK_TOKEN;
  return env;
}

/** Redact the token (and any deepseek-key-shaped string) from text bound for a record. */
export function redactSecrets(text) {
  let out = String(text ?? '');
  const tok = process.env.DEEPSEEK_TOKEN;
  if (tok && tok.length >= 8) out = out.split(tok).join('***REDACTED***');
  return out.replace(/sk-[A-Za-z0-9]{16,}/g, '***REDACTED***');
}

/** The ADR-0067 D5 provenance block. Credential KIND only — never a value. */
export function producedBy(repoDir) {
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  } catch { /* recorded as unknown rather than omitted */ }
  const onRunner = process.env.GITHUB_ACTIONS === 'true';
  return {
    ranOn: onRunner ? 'github-runner' : 'laptop',
    credentialKind: AUTH_MODE === 'oauth' ? 'claude-oauth' : 'deepseek-env',
    authBase: AUTH_MODE === 'oauth' ? 'anthropic-production' : DEEPSEEK_BASE,
    runUrl: onRunner && process.env.GITHUB_SERVER_URL
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
    commit,
  };
}

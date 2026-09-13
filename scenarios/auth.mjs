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
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const AUTH_MODE = process.env.VFKB_L4_AUTH || 'oauth';
const DEEPSEEK_BASE = 'https://api.deepseek.com/anthropic';

if (!['oauth', 'deepseek-env'].includes(AUTH_MODE)) {
  throw new Error(`VFKB_L4_AUTH=${AUTH_MODE} is not a mode (oauth | deepseek-env)`);
}

/**
 * The Keychain service holding THIS profile's credentials.
 *
 * Claude Code keys its Keychain entry by config dir: the default `~/.claude`
 * profile uses the bare service name, and every relocated profile appends the
 * first 8 hex of sha256($CLAUDE_CONFIG_DIR). Reading the bare name from a
 * wrapper-launched session therefore returns ANOTHER profile's token — which is
 * how a run staged a stale `team` credential while `claude auth status` in the
 * same shell reported a live `max` one, and then failed all six trials with
 * "401 OAuth access token has been revoked".
 *
 * DERIVED, NOT DOCUMENTED (observed 2026-09-13). sha256(path)[:8] reproduced all
 * three suffixed entries on this machine exactly — .claude-cldp -> 7993e3dd,
 * .claude-cldw -> 77ec0b16, .claude-oneio -> a4edfbef — so it is a 3/3 match on
 * independent inputs rather than a guess. If Claude Code ever changes the scheme
 * this lookup simply misses and readRealCredentials() throws naming what it tried,
 * which is the safe direction: a loud miss, never a silently wrong account.
 */
function keychainService() {
  const base = 'Claude Code-credentials';
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (!cfg || resolve(cfg) === resolve(join(homedir(), '.claude'))) return base;
  return `${base}-${createHash('sha256').update(cfg).digest('hex').slice(0, 8)}`;
}

/**
 * Read the operator's real credentials, from wherever Claude Code actually keeps
 * them. Two lookups, in order, because BOTH assumptions in the original one-liner
 * were wrong on this machine (observed 2026-09-13, which is why the L4s could not
 * be run at all):
 *
 *   1. `$CLAUDE_CONFIG_DIR/.credentials.json`, else `~/.claude/.credentials.json`.
 *      Claude Code relocates its ENTIRE config dir via that variable and the wrapper
 *      launchers here all set it; hardcoding `~/.claude` looked in a directory the
 *      session does not use. (Same defect class as the guard this branch fixes.)
 *   2. The macOS login Keychain, service "Claude Code-credentials". On macOS there
 *      is NO credentials file at all by default — the token lives in the Keychain,
 *      and the payload is already the exact `{ claudeAiOauth: … }` shape the sandbox
 *      wants. Without this, oauth mode is unrunnable on a stock macOS install.
 *
 * Returns the parsed object, or throws naming every place it looked — a credential
 * lookup that fails vaguely costs a metered run to diagnose.
 */
function readRealCredentials() {
  const tried = [];
  const cfg = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const file = join(cfg, '.credentials.json');
  tried.push(file);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { /* fall through to the Keychain */ }

  if (process.platform === 'darwin') {
    const svc = keychainService();
    tried.push(`macOS Keychain service "${svc}"`);
    try {
      const out = execFileSync(
        'security',
        ['find-generic-password', '-s', svc, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return JSON.parse(out.trim());
    } catch { /* fall through to the throw */ }
  }
  throw new Error(`no readable Claude Code credentials — looked in: ${tried.join(' ; ')}`);
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
  let all;
  try { all = readRealCredentials(); } catch (e) {
    throw new Error(`oauth mode but no credentials could be read: ${e.message}`);
  }
  if (!all.claudeAiOauth) throw new Error('credentials found, but they carry no claudeAiOauth block');

  // PRESENT is not the same as VALID, and the difference costs real money. The
  // scenarios copy the STORED token into the sandbox verbatim; they never refresh
  // it. A live Claude Code session keeps working off an in-memory refresh, so the
  // snapshot on disk can be long expired while everything looks healthy — observed
  // 2026-09-13, when a token that expired two days earlier let this check pass and
  // then failed all six trials with "401 OAuth access token has been revoked",
  // burning the metered runs AND writing a 0/3 NOT-DEMONSTRATED record that blamed
  // the capability for an auth failure. That record is worse than the wasted spend:
  // it is false evidence in the DoD chain.
  //
  // This is the same reasoning as the empty-token check above ("a missing token
  // hangs the turn and would be scored as a model miss") — applied to the failure
  // mode that actually happened.
  const expiresAt = all.claudeAiOauth.expiresAt;
  if (typeof expiresAt === 'number' && expiresAt <= Date.now()) {
    const when = new Date(expiresAt).toISOString();
    throw new Error(
      `the stored claudeAiOauth token EXPIRED at ${when} — refusing before anything metered runs. ` +
        'A live session refreshes in memory without rewriting the store, so this can be stale while ' +
        'Claude Code still works. Re-authenticate (run `claude` and complete /login) so the refreshed ' +
        'token is written back, then re-run this scenario.',
    );
  }
}

/** Stage credentials into a sandbox HOME. deepseek-env stages nothing — auth is env-only. */
export function stageAuth(homeDir) {
  if (AUTH_MODE === 'deepseek-env') return;
  const all = readRealCredentials();
  if (!all.claudeAiOauth) throw new Error('credentials found, but they carry no claudeAiOauth block');
  const dir = join(homeDir, '.claude');
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, '.credentials.json');
  writeFileSync(dst, JSON.stringify({ claudeAiOauth: all.claudeAiOauth }));
  chmodSync(dst, 0o600);
}

/**
 * Pin a child to a SANDBOX home — both halves of it.
 *
 * Setting HOME alone is not isolation. Claude Code reads its config from
 * $CLAUDE_CONFIG_DIR when that is set, and only falls back to $HOME/.claude when
 * it is not — so a scenario launched from a wrapper-launched session (cldp/cldw/
 * cldo all export it) inherited the HOST's config dir straight through
 * `{ ...process.env, HOME: home }`. Two consequences, both silent:
 *   - `claude plugin install` in an arm wrote to the OPERATOR'S real registry
 *     instead of the sandbox;
 *   - the ADR-0059 guard (which resolves the same variable since vfkb ADR-0072)
 *     answered about the host, so inactive-signal's arms stopped being causal.
 *
 * Note the interaction with authEnv(): in deepseek mode it strips every
 * CLAUDE-prefixed key, which removes this pin — harmless, because the value it
 * removes is exactly the `$HOME/.claude` the fallback then computes. In oauth
 * mode (passthrough) the pin is what does the work.
 */
export function sandboxEnv(baseEnv, home) {
  return { ...baseEnv, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') };
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

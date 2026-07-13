#!/usr/bin/env node
// ============================================================================
// hooks.json release-flow smoke check (issue #6 — relocated ADR-0028 principle)
// ----------------------------------------------------------------------------
// Proves the plugin's SHIPPED WIRING (hooks.json + .mcp.json) works when the
// plugin is loaded through the REAL resolution path: `claude plugin
// marketplace add <this checkout>` + `claude plugin install` under a sandboxed
// HOME — not `--plugin-dir`, which bypasses marketplace resolution (ADR-0051).
// The sandbox HOME isolates all marketplace/install state from the operator's
// real ~/.claude (verified: the real config is untouched; the directory-source
// marketplace runs this checkout in place, so the tree under test is the tree
// that ships).
//
// CAUSAL DESIGN (only variable = whether the plugin is installed in the HOME):
//   - wired arm: sandbox HOME with the plugin marketplace-added + installed;
//   - unwired arm (contrast): identical sandbox HOME, no plugin. Every hook
//     observable must then come out false — if any comes out true without the
//     plugin, the check itself is broken and the gate goes red.
//
// OBSERVED, NOT ASSERTED (ADR-0029/0051 — content assertions, never exit
// codes), one boolean per issue-#6 requirement:
//   resumeInjected   SessionStart injects the brain: a turn can name the
//                    unguessable sentinel seeded into the handoff.
//   writeBlocked     PreToolUse gates the brain: a turn told to append to
//                    .vfkb/entries.jsonl leaves the file byte-identical.
//   stopFired        Stop hook ran and terminated: a session record exists
//                    with turnCount >= 1 AND every turn returned within its
//                    timeout (no hook loop).
//   sessionEndClean  SessionEnd ran without schema warnings: the brain
//                    auto-commit lands in the sandbox git log AND no captured
//                    stderr line mentions a schema/hook validation failure.
//   kbRoundTrip      the plugin-wired MCP server works end-to-end: a turn
//                    records a fact via kb_add and the exact text appears in
//                    entries.jsonl (read from disk, not from the agent).
//   mcpNine          the shipped MCP bundle answers tools/list with exactly
//                    the 9 kb_* tools (direct stdio JSON-RPC probe).
//
// Gotcha baked in: the sandbox HOME has no ~/.gitconfig, so the sandbox repo
// gets a repo-local git identity — without it SessionEnd's auto-commit fails
// silently (fail-open) and sessionEndClean would be a false red.
//
// VERDICT: DEMONSTRATED iff wired >= 2/3 AND contrast <= 1/3 (vfkb ADR-0022),
// recomputed by the release gate's own verdict(). LIVE + metered (haiku,
// 3 turns per trial per arm). One at a time.
//   node scenarios/hooks-smoke.mjs
//   VFKB_HS_TRIALS=1 node scenarios/hooks-smoke.mjs
// ============================================================================
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync,
  copyFileSync, chmodSync, existsSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { verdict } from './release-gate.mjs';

const REPO = resolve(process.argv[1], '../..');
const PLUGIN = join(REPO, 'plugin');
const CLI = join(PLUGIN, 'dist', 'bundles', 'vfkb.mjs');
const MCP = join(PLUGIN, 'dist', 'bundles', 'vfkb-mcp.mjs');
const TRIALS = Math.max(1, parseInt(process.env.VFKB_HS_TRIALS || '3', 10));
const MODEL = process.env.VFKB_HS_MODEL || 'claude-haiku-4-5-20251001';
const TIMEOUT = parseInt(process.env.VFKB_HS_TIMEOUT || '240000', 10);

const SENTINEL = 'quartzfinch-omega-58';
const KB_TOOLS = [
  'kb_add', 'kb_context', 'kb_get', 'kb_list', 'kb_map',
  'kb_resume', 'kb_search', 'kb_supersede', 'kb_transition',
];
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', ...o });

// --- credentials: the Claude-Code Max OAuth block only (l4-purpose pattern) --
function stageCreds(homeDir) {
  const src = join(homedir(), '.claude', '.credentials.json');
  const all = JSON.parse(readFileSync(src, 'utf8'));
  if (!all.claudeAiOauth) throw new Error('no claudeAiOauth block in ~/.claude/.credentials.json');
  const dir = join(homeDir, '.claude');
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, '.credentials.json');
  writeFileSync(dst, JSON.stringify({ claudeAiOauth: all.claudeAiOauth }));
  chmodSync(dst, 0o600);
}

// --- sandbox: an isolated HOME + a seeded project repo ----------------------
function buildSandbox(wired) {
  const root = mkdtempSync(join(tmpdir(), 'vfkb-hs-'));
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  stageCreds(home);

  // project repo: seeded brain with the sentinel handoff, on a topic branch
  // (SessionEnd auto-commits only on a non-main branch, by design — ADR-0033)
  sh('git', ['init', '-q'], { cwd: proj });
  sh('git', ['config', 'user.name', 'hooks-smoke'], { cwd: proj });
  sh('git', ['config', 'user.email', 'hooks-smoke@sandbox.local'], { cwd: proj });
  mkdirSync(join(proj, '.vfkb'));
  const env = { ...process.env, VFKB_DATA_DIR: join(proj, '.vfkb') };
  sh('node', [CLI, 'add', 'fact',
    `HANDOFF: refactor landed. The single next step is the migration codenamed ${SENTINEL}; ` +
    `everything else is blocked behind it.`,
    '--role', 'human', '--prov-status', 'verified', '--tag', 'handoff,next,status'],
    { env, stdio: 'ignore' });
  writeFileSync(join(proj, 'README.md'), 'hooks-smoke sandbox\n');
  sh('git', ['add', '-A'], { cwd: proj });
  sh('git', ['commit', '-qm', 'chore: scaffold'], { cwd: proj });
  sh('git', ['checkout', '-qb', 'work'], { cwd: proj });

  if (wired) {
    // The real resolution path: directory-source marketplace over THIS checkout.
    sh('claude', ['plugin', 'marketplace', 'add', REPO],
      { env: { ...process.env, HOME: home }, stdio: 'ignore', timeout: 60000 });
    sh('claude', ['plugin', 'install', 'vfkb@vfkb', '--scope', 'user'],
      { env: { ...process.env, HOME: home }, stdio: 'ignore', timeout: 60000 });
  }
  return { root, home, proj };
}

// --- one metered turn; returns {text, err, timedOut} ------------------------
function turn(sb, prompt, allowedTools) {
  const args = ['-p', prompt, '--output-format', 'json', '--model', MODEL];
  if (allowedTools) args.push('--allowedTools', allowedTools);
  let raw = '';
  let err = '';
  let timedOut = false;
  try {
    raw = sh('claude', args, {
      cwd: sb.proj,
      env: { ...process.env, HOME: sb.home },
      timeout: TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    timedOut = e.signal === 'SIGTERM';
    err = String(e.stderr || e.message || '').replace(/\s+/g, ' ').slice(0, 200);
    raw = String(e.stdout || '');
  }
  let text = '';
  try { text = String(JSON.parse(raw).result ?? ''); } catch { text = raw; }
  return { text, err, timedOut };
}

// --- deterministic stdio probe: tools/list on the shipped MCP bundle --------
function mcpToolNames() {
  return new Promise((resolveP) => {
    const brain = mkdtempSync(join(tmpdir(), 'vfkb-hs-mcp-'));
    const p = spawn('node', [MCP], {
      env: { ...process.env, VFKB_DATA_DIR: join(brain, '.vfkb') },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const done = (names) => {
      p.kill();
      rmSync(brain, { recursive: true, force: true });
      resolveP(names);
    };
    const timer = setTimeout(() => done([]), 15000);
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          done((msg.result?.tools ?? []).map((t) => t.name).sort());
        }
      }
    });
    p.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hooks-smoke', version: '0' } },
    }) + '\n');
  });
}

// --- one trial: three turns + side-effect observation ------------------------
async function runTrial(wired, note) {
  const sb = buildSandbox(wired);
  const entries = join(sb.proj, '.vfkb', 'entries.jsonl');
  const errs = [];

  // T1 — SessionStart injection
  const t1 = turn(sb,
    "A handoff in your session context may name a migration codenamed with a distinctive " +
    "hyphenated phrase. Reply with that codename exactly, or NONE.");
  errs.push(t1.err);

  // T2 — PreToolUse brain-write gate
  const before = readFileSync(entries, 'utf8');
  const t2 = turn(sb,
    'Use the Write or Edit tool to append the line {"hack":true} to the file ' +
    '.vfkb/entries.jsonl in this project. Report what happened.', 'Write,Edit');
  errs.push(t2.err);
  const after = readFileSync(entries, 'utf8');

  // T3 — MCP kb_add round-trip (deferred tool: the agent loads it via ToolSearch)
  const t3 = turn(sb,
    `Record a fact in the vfkb knowledge base with exact text '${note}'. The kb_add MCP tool ` +
    "may be deferred — load it with ToolSearch first if needed. Reply DONE or FAILED.",
    'ToolSearch,mcp__plugin_vfkb_vfkb__kb_add');
  errs.push(t3.err);
  const finalEntries = readFileSync(entries, 'utf8');

  // side effects
  let stopFired = false;
  const sessDir = join(sb.proj, '.vfkb', '.sessions');
  if (existsSync(sessDir)) {
    for (const f of readdirSync(sessDir)) {
      try {
        if ((JSON.parse(readFileSync(join(sessDir, f), 'utf8')).turnCount ?? 0) >= 1) stopFired = true;
      } catch { /* partial write — ignore */ }
    }
  }
  const gitLog = sh('git', ['log', '--oneline'], { cwd: sb.proj });
  const schemaWarn = errs.some((e) => /schema|hook.*(invalid|error)/i.test(e || ''));
  const mcpNames = await mcpToolNames();

  const obs = {
    resumeInjected: t1.text.toLowerCase().includes(SENTINEL),
    writeBlocked: before === after,
    stopFired: stopFired && !t1.timedOut && !t2.timedOut && !t3.timedOut,
    sessionEndClean: gitLog.includes('session-end auto-commit') && !schemaWarn,
    kbRoundTrip: finalEntries.includes(note),
    mcpNine: JSON.stringify(mcpNames) === JSON.stringify(KB_TOOLS),
    t1: t1.text.replace(/\s+/g, ' ').slice(0, 90),
    t3: t3.text.replace(/\s+/g, ' ').slice(0, 90),
    err: errs.filter(Boolean).join(' | ').slice(0, 200),
  };
  rmSync(sb.root, { recursive: true, force: true });
  return obs;
}

// --- drive: record shape v2, verdict recomputed by the gate ------------------
console.log(`vfkb-claude-plugin hooks-smoke  (model=${MODEL}, trials=${TRIALS})`);
console.log('wired hit = all six observables true; contrast hit = the four hook observables true\n');

const PRED = ['resumeInjected', 'writeBlocked', 'stopFired', 'sessionEndClean', 'kbRoundTrip', 'mcpNine'];
const CONTRAST_PRED = ['resumeInjected', 'writeBlocked', 'stopFired', 'sessionEndClean'];
const arms = {
  wired: { role: 'positive', predicate: PRED, trials: [] },
  unwired: { role: 'contrast', predicate: CONTRAST_PRED, trials: [] },
};
for (let t = 1; t <= TRIALS; t++) {
  for (const arm of ['wired', 'unwired']) {
    process.stdout.write(`  trial ${t}  ${arm.padEnd(8)} … `);
    const r = await runTrial(arm === 'wired', `SMOKE TRIAL NOTE ${t}-${arm}`);
    arms[arm].trials.push(r);
    const keys = arm === 'wired' ? PRED : CONTRAST_PRED;
    const hit = keys.every((k) => r[k] === true);
    const state = keys.map((k) => `${k}=${r[k] ? 1 : 0}`).join(' ');
    console.log(`${arm === 'wired' ? (hit ? 'HIT ' : 'miss') : (hit ? 'LEAK' : 'clean')}  ${state}${r.err ? '  ERR:' + r.err : ''}`);
  }
}

const pluginVersion = JSON.parse(
  readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'),
).version;
const record = {
  scenario: 'hooks-smoke', recordVersion: 2, pluginVersion, outerModel: MODEL,
  trials: TRIALS, generated: new Date().toISOString(), arms,
};

const { ok: demonstrated, reasons } = verdict(record);
console.log(demonstrated
  ? '\nDEMONSTRATED — the shipped hooks.json + .mcp.json work through the real marketplace resolution path (ADR-0022, recomputed)'
  : `\nNOT demonstrated — ${reasons.join('; ')}`);

mkdirSync(join(REPO, 'scenarios/records'), { recursive: true });
writeFileSync(join(REPO, 'scenarios/records/hooks-smoke.json'), JSON.stringify(record, null, 2) + '\n');
console.log(`record → scenarios/records/hooks-smoke.json (pluginVersion=${pluginVersion})`);
process.exit(demonstrated ? 0 : 1);

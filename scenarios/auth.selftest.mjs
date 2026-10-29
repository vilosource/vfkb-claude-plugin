// Deterministic selftest for the no-Keychain auth seam (auth.mjs). No network, no
// real Keychain, no real token: a fake CLAUDE_CODE_OAUTH_TOKEN is set before import.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE = 'sk-ant-oat01-FAKEfakeFAKEfake0123456789';
process.env.CLAUDE_CODE_OAUTH_TOKEN = FAKE;
delete process.env.VFKB_L4_AUTH;
const auth = await import('./auth.mjs');

let fails = 0;
const check = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) fails++; };

const env = auth.authEnv({ PATH: process.env.PATH, KEEP: '1' });
check('oauth child env carries the token', env.CLAUDE_CODE_OAUTH_TOKEN === FAKE);
check('oauth child env keeps the caller env', env.KEEP === '1');
const shim = env.PATH.split(':')[0];
check('the no-Keychain shim is first on PATH', readdirSync(shim).includes('security'));

const run = (args, input) => spawnSync('security', args, { env, input, encoding: 'utf8' });
const add = run(['add-generic-password', '-U', '-a', 'acct', '-s', 'svc-A', '-w', 'SECRET-VALUE-1']);
check('add-generic-password is refused (exit 44)', add.status === 44);
const viaStdin = run(['-i'], 'add-generic-password -U -a acct -s svc-B -X 00ff\n');
check('the `security -i` stdin write path is refused', viaStdin.status === 44);
const find = run(['find-generic-password', '-s', 'svc-C', '-w']);
check('reads answer "not found" (exit 44)', find.status === 44);

const attempts = auth.keychainWriteAttempts();
check('two write attempts logged, the read is not a write', attempts.length === 2);
check('the attempt names the service', attempts.includes('add-generic-password|svc-A'));
check('no secret argument is logged', !attempts.join('\n').includes('SECRET-VALUE-1'));

const home = mkdtempSync(join(tmpdir(), 'auth-selftest-'));
auth.stageAuth(home);
check('stageAuth writes nothing', readdirSync(home).length === 0);

check('redactSecrets removes the token', !auth.redactSecrets(`401 for ${FAKE}`).includes(FAKE));
check('redactSecrets removes an sk-ant- shaped string',
  !auth.redactSecrets('tok sk-ant-oat01-abcdefghijklmnopqrstuv').includes('abcdefghijklmnop'));

const throws = (f) => { try { f(); return false; } catch { return true; } };
const noCred = {};
check('guard: Background + no env credential + no stored token -> refuses',
  throws(() => auth.assertNoKeychainDialogs(noCred, { platform: 'darwin', manager: 'Background', readToken: () => null })));
check('guard: Background + env credential -> allowed',
  !throws(() => auth.assertNoKeychainDialogs({ CLAUDE_CODE_OAUTH_TOKEN: 'x' }, { platform: 'darwin', manager: 'Background' })));
check('guard: Aqua + no credential -> allowed',
  !throws(() => auth.assertNoKeychainDialogs(noCred, { platform: 'darwin', manager: 'Aqua', readToken: () => null })));
check('guard: not macOS -> allowed',
  !throws(() => auth.assertNoKeychainDialogs(noCred, { platform: 'linux', manager: 'Background', readToken: () => null })));

if (fails) { console.error(`${fails} check(s) failed`); process.exit(1); }
console.log('auth selftest: all checks passed');

#!/usr/bin/env node
// ============================================================================
// Negative checks for the release gate (vfkb ADR-0029: a proof that cannot
// fail proves nothing; ADR-0050/0051 DoD items 4, 5, 6 — "seen going red").
//
// A Brake nobody has watched fail is a Brake nobody knows is connected. Each
// case below builds a synthetic plugin tree in a tmpdir, breaks exactly one
// thing, and asserts the gate reports it. The baseline case asserts the gate
// stays green when nothing is broken — otherwise every red below is vacuous.
//
//   node scenarios/release-gate.selftest.mjs
// ============================================================================
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGate } from './release-gate.mjs';

const DISCLOSURE =
  "Delivery is unproven: this plugin's install and upgrade path has never been verified " +
  'end-to-end by a sandboxed proof. Per-capability L4s load the plugin from a source tree and ' +
  'therefore prove the capability, not its delivery.';

const write = (root, rel, body) => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};

const trial = (sentinel, haiku = true) => ({ sentinel, haiku, models: ['claude-haiku-4-5-20251001'] });

/** A record that passes: positive 3/3, contrast 0/3. */
const goodRecord = (scenario, version) => ({
  scenario,
  recordVersion: 2,
  pluginVersion: version,
  trials: 3,
  arms: {
    wired: { role: 'positive', predicate: ['sentinel', 'haiku'], trials: [trial(true), trial(true), trial(true)] },
    contrast: { role: 'contrast', predicate: ['sentinel'], trials: [trial(false), trial(false), trial(false)] },
  },
});

/** A complete, healthy plugin tree. Each case mutates one thing. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gate-selftest-'));
  const V = '0.4.0';
  write(root, 'plugin/.claude-plugin/plugin.json', { name: 'vfkb', version: V });
  write(root, '.claude-plugin/marketplace.json', { name: 'vfkb', plugins: [{ name: 'vfkb', source: './plugin' }] });
  write(root, 'plugin/skills/vfkb/SKILL.md', '---\nname: vfkb\n---\n\n# vfkb\n');
  write(root, 'plugin/skills/brief/SKILL.md', '---\nname: brief\ncontext: fork\nagent: vfkb:briefer\n---\n\n# brief\n');
  write(root, 'plugin/agents/briefer.md', '---\nname: briefer\nmodel: haiku\n---\n\nbrief.\n');
  write(root, 'plugin/hooks/hooks.json', { hooks: { SessionStart: [{ command: 'node dist/bundles/vfkb.mjs hook session-start' }] } });
  write(root, 'plugin/.mcp.json', { mcpServers: { vfkb: { args: ['dist/bundles/vfkb-mcp.mjs'] } } });
  write(root, 'plugin/dist/bundles/vfkb.mjs', '// bundle\n');
  write(root, 'plugin/dist/bundles/vfkb-mcp.mjs', '// bundle\n');
  write(root, 'scenarios/records/brief-skill.json', goodRecord('brief-skill', V));
  write(root, 'DELIVERY-STATUS.json', { delivery: 'unproven', proofRecord: 'install-path', disclosure: DISCLOSURE });
  write(root, 'README.md', `# plugin\n\n> ${DISCLOSURE}\n`);
  return root;
}

const CASES = [
  {
    name: 'baseline — nothing broken',
    expect: null,
    break: () => {},
  },
  // ---- DoD 4: evidence ----
  {
    name: 'version bumped without re-running the L4',
    expect: /\[evidence\].*produced against plugin 0\.4\.0.*plugin\.json is 0\.5\.0/s,
    break: (r) => write(r, 'plugin/.claude-plugin/plugin.json', { name: 'vfkb', version: '0.5.0' }),
  },
  {
    name: 'contrast arm leaks on every trial (the proof could not fail)',
    expect: /\[evidence\].*contrast arm "contrast" leaked 3\/3/s,
    break: (r) => {
      const rec = goodRecord('brief-skill', '0.4.0');
      rec.arms.contrast.trials = [trial(true), trial(true), trial(true)];
      write(r, 'scenarios/records/brief-skill.json', rec);
    },
  },
  {
    name: 'positive arm misses the haiku pin (sentinel hit, fork not observed)',
    expect: /\[evidence\].*positive arm "wired" hit 0\/3/s,
    break: (r) => {
      const rec = goodRecord('brief-skill', '0.4.0');
      rec.arms.wired.trials = [trial(true, false), trial(true, false), trial(true, false)];
      write(r, 'scenarios/records/brief-skill.json', rec);
    },
  },
  {
    name: 'legacy record self-asserting demonstrated:true while an arm fails',
    expect: /\[evidence\].*requires v2/s,
    break: (r) =>
      write(r, 'scenarios/records/brief-skill.json', {
        scenario: 'brief-skill', pluginVersion: '0.4.0', trials: 3,
        wired: 1, contrast: 3, demonstrated: true,
        arms: { wired: [trial(true)], contrast: [trial(true), trial(true), trial(true)] },
      }),
  },
  {
    name: 'record dropped entirely',
    expect: /\[evidence\].*missing record/s,
    break: (r) => rmSync(join(r, 'scenarios/records/brief-skill.json')),
  },
  // ---- DoD 5: packaging ----
  {
    name: 'a declared skill is removed from the shipped tree',
    expect: /\[packaging\].*declared skill "brief" is missing/s,
    break: (r) => rmSync(join(r, 'plugin/skills/brief'), { recursive: true }),
  },
  {
    name: 'a skill forks to an agent that did not ship',
    expect: /\[packaging\].*declares agent "vfkb:briefer".*missing or empty/s,
    break: (r) => rmSync(join(r, 'plugin/agents/briefer.md')),
  },
  {
    name: 'wiring invokes a vendored bundle that did not ship',
    expect: /\[packaging\].*invokes plugin\/dist\/bundles\/vfkb-mcp\.mjs.*did not ship/s,
    break: (r) => rmSync(join(r, 'plugin/dist/bundles/vfkb-mcp.mjs')),
  },
  {
    name: 'hooks.json does not parse',
    expect: /\[packaging\].*hooks\.json does not parse/s,
    break: (r) => write(r, 'plugin/hooks/hooks.json', '{ not json'),
  },
  // ---- DoD 6: delivery honesty ----
  {
    name: 'delivery unproven and the README stays silent',
    expect: /\[delivery\].*README\.md does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', '# plugin\n\nNothing to see here.\n'),
  },
  {
    // The real README quotes and bolds the disclosure across wrapped lines.
    // A whitespace-only normalizer misses it and the gate goes red on a repo
    // that is, in fact, disclosing. Observed while wiring this up.
    name: 'disclosure is honored when blockquoted, bolded and rewrapped',
    expect: null,
    break: (r) => {
      const md = DISCLOSURE.replace(/(.{1,60}) /g, '$1\n');
      write(r, 'README.md', `# plugin\n\n> [!IMPORTANT]\n> **${md.split('\n').join('\n> ')}**\n`);
    },
  },
  // ---- evasions: the cases the original selftest missed ----
  // Found by an adversarial review agent (brain 2bc7b3631afe), not by the
  // author, who only ever tested the obvious breakages. Both were live GREEN.
  {
    name: 'EVASION — disclosure buried in an HTML comment (invisible to every reader)',
    expect: /\[delivery\].*README\.md does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n<!-- ${DISCLOSURE} -->\n`),
  },
  {
    name: 'EVASION — disclosure buried in a fenced code block (exhibited, not stated)',
    expect: /\[delivery\].*README\.md does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', '# plugin\n\n```\n' + DISCLOSURE + '\n```\n'),
  },
  // Round 3 of adversarial review. Each of these was GREEN against the patch
  // that closed the round-2 holes: the blacklist grew a new gap per syntax.
  // They are why the check now scans blocks and keeps only prose.
  {
    name: 'EVASION — disclosure in a 4-space indented code block (exhibited, not stated)',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n    ${DISCLOSURE}\n`),
  },
  {
    name: 'EVASION — disclosure inside <script> (GitHub renders nothing at all)',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n<script>\n${DISCLOSURE}\n</script>\n`),
  },
  {
    name: 'EVASION — disclosure inside <style>',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n<style>\n${DISCLOSURE}\n</style>\n`),
  },
  {
    name: 'EVASION — disclosure inside <details> (renders collapsed by default)',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n<details><summary>notes</summary>\n${DISCLOSURE}\n</details>\n`),
  },
  {
    name: 'EVASION — UNTERMINATED code fence (renders everything after it as code)',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', '# plugin\n\n```\n' + DISCLOSURE + '\n'),
  },
  {
    name: 'EVASION — UNTERMINATED HTML comment (swallows the rest of the file)',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n<!-- ${DISCLOSURE}\n`),
  },
  {
    // Guard against over-correction: a README that legitimately contains code
    // blocks must still pass when the disclosure is real prose.
    name: 'a real README with fences and HTML elsewhere still passes',
    expect: null,
    break: (r) =>
      write(
        r,
        'README.md',
        `# plugin\n\n\`\`\`bash\nclaude plugin install vfkb\n\`\`\`\n\n<details><summary>changelog</summary>\nstuff\n</details>\n\n> [!IMPORTANT]\n> **${DISCLOSURE}**\n\n    indented example\n`,
      ),
  },
  {
    name: 'EVASION — a single-trial record passing as DEMONSTRATED (ADR-0022 §5 says N>=3)',
    expect: /\[evidence\].*trials=1.*requires N>=3/s,
    break: (r) => {
      const rec = goodRecord('brief-skill', '0.4.0');
      rec.trials = 1;
      rec.arms.wired.trials = [trial(true)];
      rec.arms.contrast.trials = [trial(false)];
      write(r, 'scenarios/records/brief-skill.json', rec);
    },
  },
  {
    name: 'EVASION — contrast arm scores on a field no trial carries, so it holds vacuously',
    expect: /\[evidence\].*not a boolean on every trial.*vacuously/s,
    break: (r) => {
      const rec = goodRecord('brief-skill', '0.4.0');
      rec.arms.contrast.predicate = ['nonexistent_field'];
      rec.arms.contrast.trials = [trial(true), trial(true), trial(true)]; // leaks on every trial
      write(r, 'scenarios/records/brief-skill.json', rec);
    },
  },
  {
    name: 'EVASION — a skill ships in the tree but is not declared, so nothing checks it',
    expect: /\[packaging\].*skill "ghost" ships in the tree but is not declared/s,
    break: (r) => write(r, 'plugin/skills/ghost/SKILL.md', '---\nname: ghost\n---\n'),
  },
  // ---- malformed inputs must be REPORTED, not thrown ----
  {
    name: 'plugin.json missing → a finding, not a stack trace',
    expect: /\[packaging\].*plugin\.json is missing or unreadable/s,
    break: (r) => rmSync(join(r, 'plugin/.claude-plugin/plugin.json')),
  },
  {
    name: 'marketplace.json does not parse → a finding, not a stack trace',
    expect: /\[packaging\].*marketplace\.json does not parse/s,
    break: (r) => write(r, '.claude-plugin/marketplace.json', '{ nope'),
  },
  {
    name: 'a quoted `agent: "vfkb:briefer"` frontmatter value still resolves',
    expect: null,
    break: (r) => write(r, 'plugin/skills/brief/SKILL.md', '---\nname: brief\nagent: "vfkb:briefer"\n---\n\n# brief\n'),
  },
  {
    name: 'delivery claims PROVEN with no install-path record',
    expect: /\[delivery\].*claims delivery is PROVEN.*missing record/s,
    break: (r) => write(r, 'DELIVERY-STATUS.json', { delivery: 'proven', proofRecord: 'install-path' }),
  },
  {
    name: 'delivery claims PROVEN on a record bound to the wrong version',
    expect: /\[delivery\].*claims delivery is PROVEN.*produced against plugin 0\.3\.0/s,
    break: (r) => {
      write(r, 'scenarios/records/install-path.json', goodRecord('install-path', '0.3.0'));
      write(r, 'DELIVERY-STATUS.json', { delivery: 'proven', proofRecord: 'install-path' });
    },
  },
  {
    name: 'delivery claims PROVEN on a record whose contrast arm leaked',
    expect: /\[delivery\].*claims delivery is PROVEN.*contrast arm .* leaked/s,
    break: (r) => {
      const rec = goodRecord('install-path', '0.4.0');
      rec.arms.contrast.trials = [trial(true), trial(true), trial(true)];
      write(r, 'scenarios/records/install-path.json', rec);
      write(r, 'DELIVERY-STATUS.json', { delivery: 'proven', proofRecord: 'install-path' });
    },
  },
  {
    name: 'the install-path proof landed but the status was never flipped',
    expect: /\[delivery\].*still says "unproven" — flip it/s,
    break: (r) => write(r, 'scenarios/records/install-path.json', goodRecord('install-path', '0.4.0')),
  },
  {
    name: 'DELIVERY-STATUS.json missing entirely',
    expect: /\[delivery\].*missing DELIVERY-STATUS\.json/s,
    break: (r) => rmSync(join(r, 'DELIVERY-STATUS.json')),
  },
  {
    name: 'GREEN — install-path proven, status flipped, disclosure dropped',
    expect: null,
    break: (r) => {
      write(r, 'scenarios/records/install-path.json', goodRecord('install-path', '0.4.0'));
      write(r, 'DELIVERY-STATUS.json', { delivery: 'proven', proofRecord: 'install-path' });
      write(r, 'README.md', '# plugin\n\nDelivery is proven.\n');
    },
  },
];

let bad = 0;
for (const c of CASES) {
  const root = fixture();
  let failures;
  try {
    c.break(root);
    ({ failures } = runGate(root));
  } catch (e) {
    console.error(`  ERROR  ${c.name} — gate threw: ${e.message}`);
    bad++;
    rmSync(root, { recursive: true, force: true });
    continue;
  }
  rmSync(root, { recursive: true, force: true });

  const joined = failures.join('\n');
  if (c.expect === null) {
    if (failures.length) {
      console.error(`  FAIL   ${c.name}\n         expected green, gate reported:\n         ${joined.replace(/\n/g, '\n         ')}`);
      bad++;
    } else console.log(`  ok     ${c.name} — gate green`);
  } else if (!c.expect.test(joined)) {
    console.error(
      `  FAIL   ${c.name}\n         expected a failure matching ${c.expect}\n` +
        `         got: ${failures.length ? joined : '(gate stayed GREEN — the Brake is not connected)'}`,
    );
    bad++;
  } else {
    console.log(`  ok     ${c.name} — gate red, as required`);
  }
}

console.log();
if (bad) {
  console.error(`release-gate selftest FAILED: ${bad}/${CASES.length} case(s) wrong`);
  process.exit(1);
}
console.log(`release-gate selftest passed: ${CASES.length}/${CASES.length} cases (the Brake is connected)`);

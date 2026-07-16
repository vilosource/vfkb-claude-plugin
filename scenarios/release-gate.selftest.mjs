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
import { runGate, checkVendor, hashTree } from './release-gate.mjs';

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
  write(root, 'scenarios/records/hooks-smoke.json', goodRecord('hooks-smoke', V));
  write(root, 'scenarios/records/inactive-signal.json', goodRecord('inactive-signal', V));
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
  {
    name: 'hooks-smoke record dropped (issue #6 gate)',
    expect: /\[evidence\].*missing record.*hooks-smoke/s,
    break: (r) => rmSync(join(r, 'scenarios/records/hooks-smoke.json')),
  },
  {
    name: 'hooks-smoke positive arm below threshold (wiring regressed)',
    expect: /\[evidence\].*positive arm "wired" hit 1\/3/s,
    break: (r) => {
      const rec = goodRecord('hooks-smoke', '0.4.0');
      rec.arms.wired.trials = [trial(true), trial(false), trial(false)];
      write(r, 'scenarios/records/hooks-smoke.json', rec);
    },
  },
  {
    name: 'inactive-signal record dropped (issue #4 / ADR-0059 gate)',
    expect: /\[evidence\].*missing record.*inactive-signal/s,
    break: (r) => rmSync(join(r, 'scenarios/records/inactive-signal.json')),
  },
  {
    name: 'inactive-signal contrast leaks (guard banners even with plugin present)',
    expect: /\[evidence\].*contrast arm "contrast" leaked 3\/3/s,
    break: (r) => {
      const rec = goodRecord('inactive-signal', '0.4.0');
      rec.arms.contrast.trials = [trial(true), trial(true), trial(true)];
      write(r, 'scenarios/records/inactive-signal.json', rec);
    },
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
  // Round 4. Every classifier above was anchored to column 0, so ONE level of
  // blockquote nesting slipped all of them. Found by review, not by the author.
  {
    name: 'EVASION — fenced block nested one blockquote deep (`> ```)',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', '# plugin\n\n> ```\n> ' + DISCLOSURE + '\n> ```\n'),
  },
  {
    name: 'EVASION — indented code nested one blockquote deep',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n>     ${DISCLOSURE}\n`),
  },
  {
    name: 'EVASION — <script> nested one blockquote deep',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n> <script>\n> ${DISCLOSURE}\n> </script>\n`),
  },
  {
    name: 'EVASION — <p style="display:none"> (a tag no blacklist enumerated)',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n<p style="display:none">\n${DISCLOSURE}\n</p>\n`),
  },
  // Round 5. The hand-rolled scanner peeled blockquote markers but not LIST
  // markers, so the whole class reopened one `- ` deep. These pass now because
  // a real CommonMark renderer resolves block structure — the scanner is gone.
  {
    name: 'EVASION — fenced block inside a list item (`- ```)',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', '# plugin\n\n- ```\n  ' + DISCLOSURE + '\n  ```\n'),
  },
  {
    name: 'EVASION — fenced block inside a list inside a blockquote',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', '# plugin\n\n> - ```\n>   ' + DISCLOSURE + '\n>   ```\n'),
  },
  {
    name: 'EVASION — <script> inside a list item',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n- <script>\n  ${DISCLOSURE}\n  </script>\n`),
  },
  {
    name: 'EVASION — element hidden by style="display:none"',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n<div style="display:none">\n\n${DISCLOSURE}\n\n</div>\n`),
  },
  {
    name: 'EVASION — element hidden by the `hidden` attribute',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n<p hidden>\n\n${DISCLOSURE}\n\n</p>\n`),
  },
  // FALSE-RED guards. A Brake that blocks an honest release is its own failure
  // mode, so these must stay GREEN. The first two are the common README shape:
  // a badge or line-break immediately above the disclosure paragraph. The
  // hand-rolled scanner rejected both.
  {
    name: 'FALSE-RED guard — <br> immediately above the disclosure, no blank line',
    expect: null,
    break: (r) => write(r, 'README.md', `# plugin\n\n<br>\n${DISCLOSURE}\n`),
  },
  {
    name: 'FALSE-RED guard — an <img> badge line above the disclosure',
    expect: null,
    break: (r) => write(r, 'README.md', `# plugin\n\n<img src="badge.svg">\n${DISCLOSURE}\n`),
  },
  {
    name: 'FALSE-RED guard — the disclosure inside a <table> cell (it renders)',
    expect: null,
    break: (r) => write(r, 'README.md', `# plugin\n\n<table><tr><td>\n\n${DISCLOSURE}\n\n</td></tr></table>\n`),
  },
  // Round 6. Deciding "is it hidden?" by substring-matching `hidden` in the
  // opening tag matched attribute VALUES — and on a void element the removal
  // then deleted the rest of the document, disclosure included.
  {
    name: 'FALSE-RED guard — an attribute VALUE containing the word "hidden"',
    expect: null,
    break: (r) => write(r, 'README.md', `# plugin\n\n<div title="not hidden ">\n\n${DISCLOSURE}\n\n</div>\n`),
  },
  {
    name: 'FALSE-RED guard — <img alt="logo hidden on print"> above the disclosure',
    expect: null,
    break: (r) => write(r, 'README.md', `# plugin\n\n<img src="x.png" alt="logo hidden on print">\n\n${DISCLOSURE}\n`),
  },
  {
    // A void element hides nothing, so a `hidden` one must drop only its own
    // tag. Removing "to the closing tag" finds none and deletes the rest of the
    // document — disclosure included.
    name: 'FALSE-RED guard — a void element with a real `hidden` attribute above the disclosure',
    expect: null,
    break: (r) => write(r, 'README.md', `# plugin\n\n<img hidden src="x.png">\n\n${DISCLOSURE}\n`),
  },
  {
    // The disclosure text is operator-authored in DELIVERY-STATUS.json.
    //
    // The FIRST version of this guard used `run \`claude plugin update\` to
    // refresh` — inline code followed by a SPACE, which is the one adjacent
    // context that survived the bug it was meant to catch. It passed while the
    // gate rejected `run \`verify\`.` A guard shaped to miss its own bug is
    // worth less than no guard, because it reads as coverage. Punctuation-
    // adjacent now, which is where inline elements actually break.
    name: 'FALSE-RED guard — inline code immediately before a period',
    expect: null,
    break: (r) => {
      const d = 'Delivery is unproven: run `verify`.';
      write(r, 'DELIVERY-STATUS.json', { delivery: 'unproven', proofRecord: 'install-path', disclosure: d });
      write(r, 'README.md', `# plugin\n\n> ${d}\n`);
    },
  },
  {
    name: 'FALSE-RED guard — bold immediately before a period',
    expect: null,
    break: (r) => {
      const d = 'Delivery is unproven: it is **really** unproven.';
      write(r, 'DELIVERY-STATUS.json', { delivery: 'unproven', proofRecord: 'install-path', disclosure: d });
      write(r, 'README.md', `# plugin\n\n> ${d}\n`);
    },
  },
  {
    // Symmetric rendering alone would let both sides carry the SAME spurious
    // space. This is the case that needs inline tags to vanish rather than
    // become a space: the disclosure marks up a word the README states plainly.
    name: 'FALSE-RED guard — disclosure uses inline code; README states it as plain prose',
    expect: null,
    break: (r) => {
      write(r, 'DELIVERY-STATUS.json', {
        delivery: 'unproven',
        proofRecord: 'install-path',
        disclosure: 'Delivery is unproven: run `verify`.',
      });
      write(r, 'README.md', '# plugin\n\n> Delivery is unproven: run verify.\n');
    },
  },
  {
    name: 'FALSE-RED guard — inline code before a comma, mid-sentence',
    expect: null,
    break: (r) => {
      const d = 'Delivery is unproven: see the `docs`, then ship.';
      write(r, 'DELIVERY-STATUS.json', { delivery: 'unproven', proofRecord: 'install-path', disclosure: d });
      write(r, 'README.md', `# plugin\n\n> ${d}\n`);
    },
  },
  // The Brake must not be able to switch ITSELF off. Rendering both sides means
  // a `disclosure` that renders to nothing makes `.includes('')` vacuously true,
  // and a completely silent README passes. The raw-field emptiness check cannot
  // see it: the field is non-empty; its rendered form is not.
  {
    name: 'SELF-DISABLING — disclosure is an HTML comment (renders to nothing)',
    expect: /\[delivery\].*renders to .*disables this check/s,
    break: (r) => {
      write(r, 'DELIVERY-STATUS.json', { delivery: 'unproven', proofRecord: 'install-path', disclosure: '<!-- delivery is unproven -->' });
      write(r, 'README.md', '# plugin\n\nThis README says nothing about delivery.\n');
    },
  },
  {
    name: 'SELF-DISABLING — disclosure hidden inside <div hidden>',
    expect: /\[delivery\].*renders to .*disables this check/s,
    break: (r) => {
      write(r, 'DELIVERY-STATUS.json', { delivery: 'unproven', proofRecord: 'install-path', disclosure: '<div hidden>Delivery is unproven.</div>' });
      write(r, 'README.md', '# plugin\n\nThis README says nothing about delivery.\n');
    },
  },
  {
    name: 'SELF-DISABLING — a disclosure too short to inform anyone',
    expect: /\[delivery\].*minimum 20/s,
    break: (r) => {
      write(r, 'DELIVERY-STATUS.json', { delivery: 'unproven', proofRecord: 'install-path', disclosure: '.' });
      write(r, 'README.md', '# plugin\n\nAnything at all.\n');
    },
  },
  // `hidden` is an HTML boolean attribute: presence hides, whatever the value.
  {
    name: 'EVASION — <div hidden="false"> still hides (boolean attribute)',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n<div hidden="false">\n\n${DISCLOSURE}\n\n</div>\n`),
  },
  {
    // A bounded removal loop stopped silently after 100 elements, so decoys
    // exhausted the budget and the real wrapper survived, "visible".
    name: 'EVASION — 120 hidden decoys ahead of the hidden wrapper',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => {
      const decoys = Array.from({ length: 120 }, (_, i) => `<span hidden>x${i}</span>`).join('\n');
      write(r, 'README.md', `# plugin\n\n${decoys}\n\n<div hidden>\n\n${DISCLOSURE}\n\n</div>\n`);
    },
  },
  // These two still hide, and must still go red.
  {
    name: 'EVASION — a genuine `hidden` attribute still hides',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n<div hidden>\n\n${DISCLOSURE}\n\n</div>\n`),
  },
  {
    name: 'EVASION — an unclosed hidden element hides everything after it',
    expect: /\[delivery\].*does not carry the disclosure verbatim/s,
    break: (r) => write(r, 'README.md', `# plugin\n\n<div hidden>\n\n${DISCLOSURE}\n`),
  },
  {
    name: 'FALSE-RED guard — an unterminated <!-- inside an inline code span',
    expect: null,
    break: (r) => write(r, 'README.md', '# plugin\n\nUse the `<!--` marker in hooks.\n\n> ' + DISCLOSURE + '\n'),
  },
  {
    name: 'FALSE-RED guard — disclosure as an indented continuation of a list item',
    expect: null,
    break: (r) => write(r, 'README.md', `# plugin\n\n- outer\n\n    ${DISCLOSURE}\n`),
  },
  {
    name: 'FALSE-RED guard — a line that is an autolink, not an HTML tag',
    expect: null,
    break: (r) => write(r, 'README.md', `# plugin\n\n<https://example.com/docs>\n\n> ${DISCLOSURE}\n`),
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
    break: (r) =>
      write(r, 'scenarios/records/install-path.json', {
        ...goodRecord('install-path', '0.4.0'),
        pluginTreeHash: hashTree(join(r, 'plugin')),
      }),
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
      write(r, 'scenarios/records/install-path.json', {
        ...goodRecord('install-path', '0.4.0'),
        pluginTreeHash: hashTree(join(r, 'plugin')),
      });
      write(r, 'DELIVERY-STATUS.json', { delivery: 'proven', proofRecord: 'install-path' });
      write(r, 'README.md', '# plugin\n\nDelivery is proven.\n');
    },
  },
  // ---- tree-binding (issue #22): a record must prove the tree that ships ----
  {
    // The pre-#22 record shape: version-bound but tree-blind. It must not be
    // able to support `proven` — that is the dishonesty class being closed.
    name: 'delivery claims PROVEN on a record with no pluginTreeHash (pre-#22 shape)',
    expect: /\[delivery\].*claims delivery is PROVEN.*carries no pluginTreeHash/s,
    break: (r) => {
      write(r, 'scenarios/records/install-path.json', goodRecord('install-path', '0.4.0'));
      write(r, 'DELIVERY-STATUS.json', { delivery: 'proven', proofRecord: 'install-path' });
      write(r, 'README.md', '# plugin\n\nDelivery is proven.\n');
    },
  },
  {
    // The gap version-binding cannot see: plugin/ changes under an unchanged
    // version string after the record was pinned. DEMONSTRATED, version-bound —
    // and proving a tree that is not the one shipping.
    name: 'delivery claims PROVEN but plugin/ changed after the record was pinned (same version)',
    expect: /\[delivery\].*claims delivery is PROVEN.*plugin\/ changed after the record was pinned/s,
    break: (r) => {
      write(r, 'scenarios/records/install-path.json', {
        ...goodRecord('install-path', '0.4.0'),
        pluginTreeHash: hashTree(join(r, 'plugin')),
      });
      write(r, 'DELIVERY-STATUS.json', { delivery: 'proven', proofRecord: 'install-path' });
      write(r, 'README.md', '# plugin\n\nDelivery is proven.\n');
      // ...and then a byte a consumer receives changes, version untouched.
      write(r, 'plugin/skills/vfkb/SKILL.md', '---\nname: vfkb\n---\n\n# vfkb (drifted)\n');
    },
  },
];

// The vendored renderer guards every check below it, so it gets its own can-fail
// case. It validates the file this process LOADED, not one inside a fixture
// tree — so it cannot be driven from `fixture()`, and without this it would be
// the one Brake never watched failing (ADR-0029).
let bad = 0;
let total = CASES.length;
{
  const dir = mkdtempSync(join(tmpdir(), 'gate-vendor-'));
  const pristine = join(dir, 'ok.mjs');
  const tampered = join(dir, 'tampered.mjs');
  const real = new URL('./vendor/marked.esm.mjs', import.meta.url);
  writeFileSync(pristine, readFileSync(real));
  writeFileSync(tampered, `${readFileSync(real, 'utf8')}\n// one byte too many\n`);

  const cases = [
    ['the real vendored renderer', undefined, 0],
    ['a byte-identical copy', pristine, 0],
    ['a tampered copy', tampered, 1],
    ['a missing file', join(dir, 'nope.mjs'), 1],
  ];
  total += cases.length;
  for (const [label, path, wantFails] of cases) {
    const got = checkVendor(path).length;
    if ((got > 0) !== (wantFails > 0)) {
      console.error(`  FAIL   vendor integrity: ${label} — expected ${wantFails ? 'red' : 'green'}, got ${got} failure(s)`);
      bad++;
    } else console.log(`  ok     vendor integrity: ${label} — ${got ? 'red' : 'green'}, as required`);
  }
  rmSync(dir, { recursive: true, force: true });
}

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
  console.error(`release-gate selftest FAILED: ${bad}/${total} case(s) wrong`);
  process.exit(1);
}
console.log(`release-gate selftest passed: ${total}/${total} cases (the Brake is connected)`);

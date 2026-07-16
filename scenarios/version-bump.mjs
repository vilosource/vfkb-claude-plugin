#!/usr/bin/env node
// ============================================================================
// Deterministic version Brake (vfkb ADR-0061 — shipped versions are immutable)
// ----------------------------------------------------------------------------
// ADR-0060 made bump-and-tag "one atomic step". Prose cannot enforce atomicity:
// both halves are skippable by an operator (or an LLM) in a hurry, and both were
// skipped — `templates/vfkb-guard.mjs`, a file consumers COMMIT, shipped in #16
// under an already-shipped `0.5.0` with no bump. That is the bug this closes.
//
// The invariant, stated as one sentence:
//
//   If the consumer-facing surface differs from what `vfkb--v{version}` already
//   shipped, then `version` is stale and MUST be bumped.
//
// It is expressed against the TAG, not against the merge-base, and that choice
// is load-bearing. A merge-base check asks "did this PR change the surface?",
// which is a question about a diff and answers "no" for a PR that reverts onto
// a drifted main. This asks "does the artifact match the version it claims?",
// which is a question about the ARTIFACT — the thing a consumer actually
// installs. It therefore holds on any checkout, in any order, with no PR
// context: run it on a branch, on main, or on a detached HEAD and it means the
// same thing.
//
// Deliberately NOT in release-gate.mjs. That gate is pure-filesystem by
// construction ("No LLM, no auth, no network") and its purity is why it can be
// selftested against synthetic trees in a tmpdir. This check needs git history
// and tags. Mixing them would cost the gate the property that makes it
// trustworthy, so it ships as its own Brake with its own negative checks
// (`version-bump.selftest.mjs`).
//
//   node scenarios/version-bump.mjs          # check this checkout
// ============================================================================
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// The consumer-facing surface: everything whose contents reach a consumer.
//
// This list is the declaration of record and is checked against the tree below
// — a surface path that stops existing must be REMOVED here deliberately, not
// silently skipped, or the Brake goes vacuous exactly like the proofs ADR-0029
// warns about.
//
//   plugin/     — what `claude plugin install` resolves and runs. The
//                 marketplace manifest points `plugins[0].source` at it.
//   templates/  — `vfkb-guard.mjs`, which consumers COPY AND COMMIT into their
//                 own repo (ADR-0059). It is not loaded from the plugin dir, so
//                 it looks like tooling and is not; omitting it is precisely the
//                 mistake that produced the 0.5.0 drift, and a Brake that misses
//                 the bug it was written for is worse than no Brake.
//
// Everything else is deliberately NOT surface. `scenarios/` is proof machinery,
// `.github/` is CI, `*.md` is prose, `.vfkb/` is this repo's own brain: none of
// them change the bytes a consumer installs, and requiring a version bump (plus
// three metered L4 re-runs) to land a test would make the Brake something people
// route around. ADR-0060 lists the `hooks-smoke` L4 (#15) as drift; observed, it
// touched only `scenarios/` + `RELEASING.md` and changed nothing a consumer gets.
export const SURFACE = ['plugin', 'templates'];

const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

// `git rev-parse HEAD:ghost` writes "fatal: path 'ghost' does not exist" to
// stderr before exiting non-zero. Existence probes below EXPECT that failure, so
// inheriting stderr prints `fatal:` lines all over a passing run's log — which
// reads as a broken Brake and trains people to ignore real ones.
const gitQuiet = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** The release tag name for a version. ADR-0060: the format is load-bearing. */
export const tagFor = (name, version) => `${name}--v${version}`;

/**
 * Does `ref` exist as a tag in this repo? A missing tag and a broken repo must
 * not be confused: `git rev-parse` exits non-zero for both, so ask the ref db.
 */
const tagExists = (repo, tag) => {
  const out = git(repo, 'tag', '--list', tag);
  return out.split('\n').includes(tag);
};

/**
 * Check one checkout. Returns { ok, reasons, notes }.
 *
 * `repo` is a git worktree; `name`/`version` come from its plugin.json.
 * `surface` is injectable purely so the selftest can watch the anti-vacuity
 * branch go red (ADR-0029) — production always uses the declared SURFACE.
 */
export function checkVersionBump(repo, surface = SURFACE) {
  const reasons = [];
  const notes = [];

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(repo, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
  } catch (e) {
    return { ok: false, reasons: [`plugin/.claude-plugin/plugin.json is missing or unreadable: ${e.message}`], notes };
  }
  const { name, version } = manifest;
  if (typeof name !== 'string' || !name) return { ok: false, reasons: ['plugin.json declares no name'], notes };
  if (typeof version !== 'string' || !version) return { ok: false, reasons: ['plugin.json declares no version'], notes };

  const tag = tagFor(name, version);
  const has = (ref, path) => {
    try {
      gitQuiet(repo, 'rev-parse', `${ref}:${path}`);
      return true;
    } catch {
      return false;
    }
  };

  // No tag => this version has never shipped, so there is nothing it could
  // contradict. This is the green path for a correctly-bumped release PR.
  if (!tagExists(repo, tag)) {
    // ...but "no tag" and "no tags at all" are not the same thing, and this
    // Brake reads the SAME on both while failing OPEN. A checkout without tags
    // (the Actions default is shallow and tagless — this workflow opts in with
    // `fetch-tags: true`) would make every version look unreleased and the check
    // pass vacuously forever, silently, in the exact configuration it exists to
    // police. This repo has shipped six tagged versions; zero of them present
    // means the tag data is missing, not that nothing was ever released.
    const released = git(repo, 'tag', '--list', `${name}--v*`);
    if (!released) {
      return {
        ok: false,
        reasons: [
          `no ${name}--v* tags exist in this checkout, so there is nothing to compare ${version} ` +
            `against and this check would pass without checking anything. Fetch the tags ` +
            `(CI: actions/checkout with fetch-depth: 0 + fetch-tags: true; locally: ` +
            `\`git fetch --tags\`). If this plugin genuinely has no releases yet, this Brake has ` +
            `nothing to enforce and should be removed deliberately, not satisfied by an empty ref db.`,
        ],
        notes,
      };
    }
    notes.push(
      `version ok: ${version} is unreleased (no ${tag} tag; ${released.split('\n').length} other ` +
        `release tag(s) present, so the tag data is really here) — nothing shipped under it yet`,
    );
    return { ok: true, reasons, notes };
  }

  // A surface entry naming a path that exists on NEITHER side is dead: it can
  // never contribute a diff, so it silently stops checking anything. Absent at
  // HEAD but present in the tag is a different thing entirely — that is a
  // shipped file being DELETED, which is drift and must be reported as drift.
  // Conflating the two made this Brake tell an operator to edit SURFACE when
  // what they had actually done was remove a released file.
  for (const path of surface) {
    if (!has('HEAD', path) && !has(tag, path)) {
      reasons.push(
        `declared surface path "${path}/" exists neither at HEAD nor in ${tag} — it is the list ` +
          `this Brake diffs, so a dead entry checks nothing. Remove it from SURFACE deliberately, ` +
          `or restore the path.`,
      );
    }
  }
  if (reasons.length) return { ok: false, reasons, notes };

  // The whole-tree diff is filtered in JS rather than passed to git as a
  // pathspec. `git diff <tag> -- templates` aborts ("path exists on disk, but
  // not in HEAD") whenever a surface dir is present on only one side — which is
  // exactly the deletion case this Brake must report, so the pathspec form
  // crashed on the input it most needed to handle.
  //
  // Diffing against the tag (not HEAD) compares the WORKING TREE, so an
  // uncommitted edit is caught too. That matters for the local pre-flight: a
  // check that goes green locally and red in CI is one people stop running.
  let raw;
  try {
    raw = git(repo, 'diff', '--name-only', tag);
  } catch (e) {
    return {
      ok: false,
      reasons: [`could not diff against ${tag}: ${e.message} — is the tag fetched? (CI needs fetch-tags)`],
      notes,
    };
  }
  const changed = raw
    .split('\n')
    .filter(Boolean)
    .filter((f) => surface.some((s) => f === s || f.startsWith(`${s}/`)))
    .join('\n');

  if (!changed) {
    notes.push(`version ok: the surface (${surface.map((s) => `${s}/`).join(', ')}) is byte-identical to ${tag}`);
    return { ok: true, reasons, notes };
  }

  const files = changed.split('\n').filter(Boolean);
  reasons.push(
    `version ${version} was already released as ${tag}, but the consumer-facing surface has ` +
      `changed since — ${files.length} file(s) differ:\n` +
      files.map((f) => `           ${f}`).join('\n') +
      `\n\n         A shipped version is immutable (ADR-0060/0061). Shipping these under ${version} ` +
      `is the\n         drift that put templates/vfkb-guard.mjs into an already-released 0.5.0.\n` +
      `         Fix: bump "version" in plugin/.claude-plugin/plugin.json, then re-pin the L4\n` +
      `         records to the new version (see RELEASING.md). The tag is created for you on merge.`,
  );
  return { ok: false, reasons, notes };
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { ok, reasons, notes } = checkVersionBump(repo);
  for (const n of notes) console.log(n);
  for (const r of reasons) console.error(`VERSION FAIL: ${r}`);
  if (!ok) {
    console.error('\nversion brake FAILED');
    process.exit(1);
  }
  console.log('\nversion brake PASSED');
}

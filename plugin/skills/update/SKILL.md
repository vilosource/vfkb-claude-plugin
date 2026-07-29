---
name: update
description: Check whether a newer version of the vfkb plugin is available for THIS project and update it if so. Use when the user asks to "update vfkb", "check for a vfkb update", "is there a newer vfkb", or wants to make sure they have the latest skills/fixes before relying on them. Runs forked on Haiku (ADR-0049 Layer 1 shape) — pure checklist work, no session context needed, same shape as /vfkb:brief. Scoped to this one project only, never other projects on the machine. A restart is still required afterward for a running session to actually load the new version.
context: fork
agent: vfkb:updater
---

# vfkb self-update

Check this project's vfkb plugin installation against the latest available release, and update it
if newer. Work the checklist in order; report exactly what happened, not what you expect happened.

## 1. Guard

Confirm vfkb is actually installed for THIS project (scope: project, this directory) — `claude
plugin list --json` lists every project's registrations across the whole machine, so a bare `grep
vfkb` can pass even when it's a *different* project that has it installed. Scope the check to this
directory's exact path (Node, not `jq` — Claude Code always has Node available; a consumer machine
may not have `jq`):

    node -e "
      const cwd = process.cwd();
      let list;
      try {
        list = JSON.parse(require('child_process').execSync('claude plugin list --json').toString());
      } catch (e) {
        console.error('could not check plugin registry:', e.message);
        process.exit(2);
      }
      process.exit(list.some(p => p.id === 'vfkb@vfkb' && p.projectPath === cwd) ? 0 : 1);
    "

Three distinct outcomes, not two — a broken check must not be read as "not installed":

- **Exit 0** — installed here; continue.
- **Exit 1** — genuinely not installed for this project; say so and stop. Don't install it fresh;
  that's a different flow (the vfkb-new-project skill).
- **Exit 2** (or any crash/stack trace) — the check itself failed (CLI missing, unreadable
  registry, malformed JSON), not "not installed." Report the actual error and stop; do not tell the
  user vfkb isn't installed when you actually don't know.

## 2. Refresh the marketplace

    claude plugin marketplace update vfkb

If this fails (offline, no network, marketplace not configured), say so and stop — the update check
needs current release data, not a stale cache.

## 3. Update (or confirm current)

Run, from the project root:

    claude plugin update vfkb@vfkb --scope project

Three possible outcomes — report whichever actually happened, don't assume:

- `vfkb is already at the latest version (X)` — nothing to do; tell the user they're current.
- `Plugin "vfkb" updated from X to Y ... Restart to apply changes` — tell the user the old and new
  version, and that this session needs a restart before the update actually takes effect. The
  update fetches and caches the new version's plugin content and updates the registry
  (`~/.claude/plugins/installed_plugins.json`) right away; what it does *not* do is reach into an
  already-running session and hot-reload the skills that session already loaded into memory — that
  part only happens on restart.
- Anything else (non-zero exit, an error message, no network) — report the failure plainly, quoting
  the actual error output. Do not infer an old/new version, and do not claim a restart is needed —
  but don't assert "nothing changed" either; an update that errors partway through is not something
  you observed the state of. Say the version and restart status are unknown/unverified given the
  error, not that they're unchanged.

Scope this to `--scope project` only, for THIS project's directory. Never touch `user` scope or any
other project's registry entry — this command is not a fleet-wide update across every project on
the machine.

## 4. Report back

State plainly: the version before, the version after (or "already current"), and whether a restart
is needed. Don't claim the new skills/fixes are active yet if a restart hasn't happened.

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

Confirm vfkb is actually installed for THIS project (scope: project, this directory). If it isn't,
say so and stop — don't install it fresh; that's a different flow (the vfkb-new-project skill).

## 2. Refresh the marketplace

    claude plugin marketplace update vfkb

If this fails (offline, no network, marketplace not configured), say so and stop — the update check
needs current release data, not a stale cache.

## 3. Update (or confirm current)

Run, from the project root:

    claude plugin update vfkb@vfkb --scope project

There are exactly two possible outcomes — report whichever actually happened, don't assume:

- `vfkb is already at the latest version (X)` — nothing to do; tell the user they're current.
- `Plugin "vfkb" updated from X to Y ... Restart to apply changes` — tell the user the old and new
  version, and that this session needs a restart before the update actually takes effect. A plugin
  update only rewrites the installed-version registry (`~/.claude/plugins/installed_plugins.json`);
  it does not hot-reload a running session's already-loaded skills.

Scope this to `--scope project` only, for THIS project's directory. Never touch `user` scope or any
other project's registry entry — this command is not a fleet-wide update across every project on
the machine.

## 4. Report back

State plainly: the version before, the version after (or "already current"), and whether a restart
is needed. Don't claim the new skills/fixes are active yet if a restart hasn't happened.

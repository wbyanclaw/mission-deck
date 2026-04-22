# Mission Deck Installer Checklist

This checklist defines the safety bar for `mission-deck-install`.

## Goal

The installer is a minimal config adapter for the user's existing OpenClaw setup.

It must:

- install the plugin
- wire the plugin into the host config
- preserve user-owned behavior

It must not behave like a full config generator.

## Config Safety

- Only write the minimum fields required to load `mission-deck`.
- Preserve existing `plugins.entries.mission-deck.config` values.
- Do not rewrite unrelated plugin entries.
- Do not rewrite agent, model, tool, channel, or auth settings.
- Do not write fields unless they are valid for the target host schema.

## Load Path Safety

- Ensure the plugin directory is present in `plugins.load.paths`.
- Do not remove existing load paths.
- Do not duplicate the same load path.
- Do not reorder existing load paths unless required.

## Install Behavior

- Copy the plugin into `~/.openclaw/extensions/mission-deck` by default.
- Exclude runtime artifacts and unrelated local files from the install tree.
- Support clean reinstall behavior so removed source files do not linger in the target directory.
- Treat plugin installation and config mutation as separate verifiable steps.

## User Config Adaptation

- Merge with the user's existing config instead of replacing it.
- If `mission-deck` is already configured, preserve user-owned runtime options.
- If the host uses a different config schema, fail clearly instead of guessing.
- Prefer leaving optional settings unset over inventing defaults in user config.

## Verification

`--verify` should check:

- plugin directory exists
- plugin manifest exists
- `plugins.entries.mission-deck` exists and is enabled
- `plugins.load.paths` includes the plugin directory

Verification should not claim success only because files were copied.

## Restart Safety

- Never restart the service unless the user explicitly requests it.
- Treat `--restart` as a high-risk operation.
- Prefer verifying config compatibility before restart.
- If restart fails, report it clearly and do not hide partial success.

## Failure Model

The installer must fail loudly when:

- `openclaw.json` is missing
- the target config shape is incompatible
- the plugin directory cannot be written
- post-install verification fails

It should avoid partial-success messaging that implies the runtime is healthy when only file copy succeeded.

## Release Check

Before release, confirm:

1. `npm test` passes.
2. A fresh install works on a clean target.
3. A reinstall does not leave stale files behind.
4. The host starts without config validation errors.
5. Logs show `mission-deck` was actually loaded.

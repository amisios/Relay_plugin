# Maintaining Custom Relay

Custom Relay is upstream [Relay](https://github.com/No-Instructions/Relay) plus a thin layer. The
layer is built so that each upstream release merges with few or no conflicts.

## How the fork is put together

**Upstream files stay (nearly) verbatim.** The fork's footprint in them is a handful of short hooks,
each marked `[custom]`:

```bash
git grep -n '\[custom\]' -- src esbuild.config.mjs   # every hook into upstream code
git diff upstream/<tag> --stat                       # the whole footprint vs. upstream
```

**Fork logic lives in fork-owned files** that upstream never touches:

| Path | What it is |
|---|---|
| `src/local/custom.ts` | `CustomRelay`: backend mode, per-mode folder lists, endpoints, permission limits |
| `src/local/FakePocketBase.ts` | Stands in for PocketBase in self-hosted mode; serves the control-plane's `/registry` |
| `src/local/colors.ts` | Deterministic / chosen cursor colors |
| `src/components/SelfHostSettings.svelte` | Top of settings: server toggle, self-hosted setup, version check, add folder by secret |
| `custom/manifest.overlay.json` | Plugin id, name, author, update repository, fork revision |
| `custom/build/` | esbuild plugin (id/repo/version rewrite) and `finalize.mjs` (manifest + bundle check) |
| `custom/tests/`, `custom/jest.config.mjs` | The fork's unit tests |
| `build.d/custom.json` | The default build flavor |
| `build/` | Docker build and `install.sh` |
| `.github/README.md` | The README GitHub shows (upstream's `README.md` stays as-is) |

**Renames happen at build time.** `manifest.json` is upstream's, untouched. The build reads
`custom/manifest.overlay.json` and does three things:

- rewrites the plugin id `system3-relay` → `relay-custom` in every upstream `src/**/*.ts`. This
  covers the settings tab, command ids, editor binding, storage keys and public API events.
- points the in-plugin updater at this repository (`REPOSITORY` and two exact rewrites in
  `UpdateManager.ts`).
- sets `GIT_TAG`, the version the plugin reports, to `<upstream version>[-<revision>]`.

If upstream changes the code an exact rewrite targets, the build fails and names the file; adjust
`custom/build/esbuild-plugin.mjs`. Upstream's `relay-plugin-api.d.ts` still names the
`system3-relay:*` events; at runtime they are `relay-custom:*`.

## Build and test

No Node needed locally:

```bash
cd build && docker compose run --rm --build build   # type-check, fork tests, bundle -> ../dist
./install.sh /path/to/vault
```

With Node available: `npm ci`, then `npm run build` (same flavor) or
`npx jest -c custom/jest.config.mjs`.

Upstream's own tests (`__tests__/**`) are git-crypt encrypted in public checkouts, so `npm test`
cannot run here. The fork's tests use their own config for that reason.

## Versions

- `x.y.z` is always the upstream release this build is based on. It comes from upstream's
  `manifest.json`.
- `revision` in the overlay is the fork-only revision. The version becomes `x.y.z-<revision>`.
- The control-plane (the server repo) uses the same `x.y.z` with its own `-N`. **Same x.y.z means
  compatible.** The settings page checks this against the server's `/health`.
- BRAT orders releases by semver, and there `x.y.z-N` sorts *below* `x.y.z`. Once you ship any
  `-N` for an `x.y.z`, don't ship the bare `x.y.z` after it, or BRAT users won't move.

## Git layout

- `origin` is `amisios/Relay_plugin`. `main` is the fork. `legacy/0.3` keeps the pre-0.8.12 history.
- `upstream` fetches only `main` and **tags**, stored locally as `upstream/<tag>` so they don't
  collide with this fork's `v*` tags. Upstream **rewrites `main`**, so always merge release tags,
  never `upstream/main`.
- Push tags by name (`git push origin v0.8.13-1`). Never use `git push --tags`, which would publish
  every `upstream/*` tag to this fork.
- Keep GitHub Actions **disabled** on this fork. Upstream's `release.yaml` and `pre-release.yml`
  would build and publish an upstream-branded release on every tag push.

## Upgrading to a new upstream release

```bash
git fetch upstream                          # new tags arrive as upstream/<tag>
git checkout -b upgrade/<tag> main
git merge upstream/<tag>                    # conflicts, if any, are in [custom] hooks
```

1. Resolve conflicts by keeping upstream's code and re-applying the small `[custom]` hook.
2. Reset `revision` in `custom/manifest.overlay.json` for the new base version.
3. Check whether the control-plane needs changes:
   `scripts/contract-diff.sh <old-tag> <new-tag>` in the server repo lists upstream changes in the code
   the control-plane imitates. Adapt the control-plane if needed, then give it the same `x.y.z`.
4. Build in Docker; the fork tests run as part of it. Smoke-test both modes in a vault:
   - self-hosted: sync, cursors, add a folder by secret, settings show ✓
   - official: sign-in screen
5. Merge into `main`, tag `v<version>`, and push the branch and tag.
6. Publish a GitHub release for the tag with `dist/main.js`, `dist/manifest.json` and
   `dist/styles.css` attached. BRAT installs from releases.

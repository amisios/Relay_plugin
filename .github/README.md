# Custom Relay 🛰️

Real-time collaborative editing in Obsidian — against **your own server**, or the official one.

Custom Relay is a fork of [Relay](https://github.com/No-Instructions/Relay) (by System 3, MIT) with
two modes, picked at the top of its settings:

- **Self-hosted server** (default) — connects to a relay server and control-plane **you host
  yourself**. No vendor account, no sign-in, no collaborator limit.
- **Official Relay (System 3)** — exactly upstream Relay: sign in, share keys, create Relay Servers.

It installs under its own id (`relay-custom`), so it can sit **alongside** the official Relay
plugin without conflicting.

- ✍️ **Live collaborative editing** with other people's cursors
- 📁 **Multiple shared folders** on one relay, each protected by its own **folder secret**
- 📎 **Every file type shared** — notes and canvases live, everything else (images, PDFs, encrypted
  files, …) as whole files, up to 250 MiB each
- 🔒 **You control access** — the server only hands out tokens to folder members
- 🧩 **No accounts** — pick a display name and colour; a per-device secret key proves it's you
- 🛟 **Safe renames and deletes** — renaming a parent folder keeps the share; mass removals need
  confirmation, and collaborators' removed files are backed up

> **Self-hosted mode requires a backend.** Someone must run the companion stack (relay server +
> control-plane). Ask them for the details below.

---

## What you need before installing

| Thing | Example | Where from |
|---|---|---|
| **Control-plane URL** | `http://relay.example.com:8094` | Your admin |
| **Folder secret** (one per folder) | `K3PQ-7VWM-2XRT-9HFD` | Your admin |
| **Network access** | VPN / LAN | Your admin |

---

## 1. Install

Custom Relay isn't in the Obsidian community store — install it with **BRAT**:

1. Obsidian → **Settings → Community plugins → Browse** → search **BRAT** → Install → Enable.
2. Settings → **BRAT** → **Add beta plugin** → paste:
   ```
   amisios/Relay_plugin
   ```
3. Settings → **Community plugins** → enable **Custom Relay**.

## 2. Set yourself up

Settings → **Custom Relay** → **Server: Self-hosted server** (the default), then:

- **Display name** — how collaborators see you.
- **Your colour** — your cursor colour (pick a preset or a custom one).
- **Control-plane URL** — the URL your admin gave you.

Click **Save**. The plugin reloads itself to apply — that's expected.

You'll now see the relay, but **no folders yet**. That's by design: the URL gets you into the
relay, but every folder needs its own secret.

## 3. Add a shared folder

1. Settings → **Custom Relay** → **Add a folder** → paste the **folder secret** → **Add folder**.
   The plugin reloads.
2. Open the relay's folder list, find the folder, and click **Add to vault** — choose where it
   should live in your vault.

It now syncs. Repeat with another secret for each additional folder.

---

## Using the official Relay service

Settings → **Custom Relay** → **Connect to** → **Official Relay (System 3)**. The plugin reloads
and behaves like upstream Relay: sign in, join with share keys, create Relay Servers.

- Each mode keeps **its own shared folders**. Switching parks the current list and restores the
  other mode's, so neither backend ever sees the other's folders. Your sign-in survives a switch.
- Don't enable the official Relay plugin in the same vault while Custom Relay is in official mode;
  both would sync the same folders. (Custom Relay warns you if it notices.)

---

## Versions and compatibility

Custom Relay carries the version of the upstream Relay release it is built on: Custom Relay
0.8.12 is upstream Relay 0.8.12 plus this fork's changes. The self-hosted server uses the same
numbers:

> **Plugin and server work together when they share the same `x.y.z`.**

Settings → Custom Relay shows the server's version, with a ✓ when it matches.

---

## How access works

- The **control-plane URL** alone makes you a member of the relay — it shows you nothing.
- **Every folder is private** and gated by its own secret. Redeeming a secret records you as a
  member of that folder.
- The server **refuses to issue tokens** for folders you're not a member of, so a folder you
  haven't unlocked is both invisible and unreachable.
- If your access is revoked, it stops working within ~10 minutes (the token lifetime).

- Your plugin makes up a user id and a **secret key** the first time it runs. The server binds the
  key to the id, so knowing someone's id is not enough to act as them.

**Security note:** there are no accounts. Access is gated by folder secrets and your device's key,
which is strong against outsiders and accidents. This is designed for a **small trusted group on a
private network** (VPN/LAN, plain `http`), not for the open internet. Use at your own risk.

## Shared folder safety

- **Renaming or moving a parent folder** of a shared folder keeps it shared; the share follows.
- **If a shared folder disappears** from outside Obsidian (Finder, or another sync tool such as
  Obsidian Sync, iCloud or Syncthing), Relay pauses it on that device and asks where it went.
  Nothing is removed for collaborators.
- **Removing 10 or more files at once, or a quarter of a folder,** asks first: *Restore them here*,
  *Pause this folder*, or *Remove for everyone*. Nothing is sent until you choose.
- **When a collaborator removes files,** your copies go to `.trash/relay/<folder>/<date-time>/` with
  their sub-folders kept. If they removed a lot at once, your files stay until you choose *Keep my
  copies* (shares them again) or *Apply*.
- Command palette: **“Review held removals and paused folders.”**

> **Don't also sync Relay-shared folders with another tool** (Obsidian Sync, iCloud, Syncthing, git)
> on devices where Relay runs. Two sync engines fight over the same files. Exclude the shared
> folders in the other tool, or run Relay on one device only.

---

## Building from source

No Node needed on your machine — the build runs in Docker:

```bash
cd build
docker compose run --rm --build build        # -> ../dist/{main.js,manifest.json,styles.css}
./install.sh /path/to/vault [more/vaults...] # copies them into .obsidian/plugins/relay-custom/
```

Then reload Obsidian (or toggle the plugin off/on). How the fork is put together and how it follows
upstream releases: [custom/UPSTREAM.md](../custom/UPSTREAM.md).

---

## Differences from upstream Relay

In **self-hosted** mode:

- Talks to **your** control-plane instead of System 3's; no account or sign-in.
- **No collaborator cap.**
- Folders are **admin-created** and gated by **folder secrets** (no folder creation from the UI).
- Members are read-write; there's no read-only role yet.
- **Every file type** syncs by default ("Other files" is on).
- Each device has a **secret identity key** (no OAuth).

In **both** modes:

- Installs as `relay-custom` so it **coexists** with the official Relay plugin.
- **Shared folder safety** (above): rename-following, mass-removal confirmation, structured backups.
- The "Send bug report" command is removed; it uploads logs to System 3.
- Updates come from this repository's releases, not upstream's.

## Credits & licence

All the hard parts — the CRDT sync engine, the merge machinery, the editor integration — are the
work of [System 3](https://system3.md/) in [Relay](https://github.com/No-Instructions/Relay), and
of the [y-sweet](https://github.com/jamsocket/y-sweet) / [Yjs](https://github.com/yjs/yjs)
projects underneath it. This fork only swaps out the hosted control plane for a self-hosted one.

MIT licensed, like upstream. See [LICENSE](../LICENSE).

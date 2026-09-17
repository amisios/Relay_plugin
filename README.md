# Custom Relay 🛰️

Real-time collaborative editing in Obsidian — against **your own server**.

Custom Relay is a fork of [Relay](https://github.com/No-Instructions/Relay) (by System 3, MIT) that
connects to a relay server and control-plane **you host yourself**. No vendor account, no sign-in,
no collaborator limit. It installs under its own id (`relay-custom`), so it can run **alongside**
the official Relay plugin without conflicting.

- ✍️ **Live collaborative editing** with other people's cursors
- 📁 **Multiple shared folders** on one relay, each protected by its own **folder secret**
- 🔒 **You control access** — the server only hands out tokens to folder members
- 🧩 **Self-declared identity** — pick a display name and colour, no OAuth

> **Requires a self-hosted backend.** This plugin does nothing on its own — someone must run the
> companion stack (relay server + control-plane). Ask them for the details below.

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

Settings → **Custom Relay**:

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

## How access works

- The **control-plane URL** alone makes you a member of the relay — it shows you nothing.
- **Every folder is private** and gated by its own secret. Redeeming a secret records you as a
  member of that folder.
- The server **refuses to issue tokens** for folders you're not a member of, so a folder you
  haven't unlocked is both invisible and unreachable.
- If your access is revoked, it stops working within ~10 minutes (the token lifetime).

**Security note, honestly stated:** identity here is *self-declared* — the plugin simply tells the
server who you are. Access is gated by knowing a folder secret, which is strong against outsiders
and accidents, but this is designed for a **small trusted group on a private network**, not for
mutually-distrusting users on the open internet.

---

## For the admin (server side)

The backend is the companion `relay-selfhost` stack (relay server + control-plane, via Docker).
Manage folders and membership with:

```bash
docker exec relay_control_plane node src/index.js admin list
docker exec relay_control_plane node src/index.js admin folder add "Notes"      # prints a secret
docker exec relay_control_plane node src/index.js admin folder set-secret Notes # rotate it
docker exec relay_control_plane node src/index.js admin grant  <userId> Notes   # no secret needed
docker exec relay_control_plane node src/index.js admin revoke <userId> Notes
docker exec relay_control_plane node src/index.js admin kick   <userId>         # all folders
docker exec relay_control_plane node src/index.js admin add    <userId>         # make admin
```

Changes apply immediately — no restart. Find a user's id in the control-plane logs
(`docker logs relay_control_plane | grep 'user='`).

---

## Building from source

No Node needed on your machine — the build runs in Docker:

```bash
cd build
docker compose run --rm --build build        # -> ../dist/{main.js,manifest.json,styles.css}
./install.sh /path/to/vault [more/vaults...] # copies them into .obsidian/plugins/relay-custom/
```

Then reload Obsidian (or toggle the plugin off/on).

---

## Differences from upstream Relay

- Talks to **your** control-plane instead of System 3's; no account or sign-in.
- **No collaborator cap.**
- Folders are **admin-created** and gated by **folder secrets** (no folder creation from the UI).
- Members are read-write; there's no read-only role yet.
- Installs as `relay-custom` so it **coexists** with the official Relay plugin.

## Credits & licence

All the hard parts — the CRDT sync engine, the merge machinery, the editor integration — are the
work of [System 3](https://system3.md/) in [Relay](https://github.com/No-Instructions/Relay), and
of the [y-sweet](https://github.com/jamsocket/y-sweet) / [Yjs](https://github.com/yjs/yjs)
projects underneath it. This fork only swaps out the hosted control plane for a self-hosted one.

MIT licensed, like upstream. See [LICENSE](LICENSE).

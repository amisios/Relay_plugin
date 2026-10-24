<script lang="ts">
	import type Live from "src/main";
	import { Notice, requestUrl } from "obsidian";
	import { onMount } from "svelte";
	import { usercolors } from "../User";
	import { colorFromString } from "../local/colors";
	import { makeIdentityToken } from "../local/FakePocketBase";
	import { CustomRelay, type BackendMode } from "../local/custom";

	export let plugin: Live;

	const custom = CustomRelay.for(plugin);
	const current = custom.settings.get() ?? {};
	const configuredUrl = custom.selfHost?.controlPlaneUrl ?? "";

	let mode: BackendMode = custom.mode;
	let displayName: string = current.displayName ?? "";
	let controlPlaneUrl: string = current.controlPlaneUrl ?? "";
	let color: string =
		current.color ??
		(current.userId ? colorFromString(current.userId).color : "#30bced");

	let folderSecret: string = "";
	let joining = false;

	// Plugin and control-plane are compatible when they share the upstream
	// x.y.z; a "-N" suffix is a fork-only revision on either side.
	type Compat = "checking" | "ok" | "mismatch" | "unknown" | "unreachable";
	let compat: Compat = "checking";
	let controlPlaneVersion = "";
	const baseVersion = (v: string) => v.replace(/^v/, "").split("-")[0];

	onMount(async () => {
		if (!custom.isCustom || !configuredUrl) return;
		try {
			const res = await requestUrl({
				url: `${configuredUrl}/health`,
				method: "GET",
				throw: false,
			});
			if (res.status !== 200) {
				compat = "unreachable";
				return;
			}
			controlPlaneVersion =
				(res.json as { version?: string } | undefined)?.version ?? "";
			compat = !controlPlaneVersion
				? "unknown"
				: baseVersion(controlPlaneVersion) === baseVersion(plugin.version)
					? "ok"
					: "mismatch";
		} catch {
			compat = "unreachable";
		}
	});

	async function save() {
		if (!controlPlaneUrl.trim()) {
			new Notice("Enter a control-plane URL.", 5000);
			return;
		}
		await custom.settings.update((cur) => ({
			...cur,
			displayName: displayName.trim(),
			controlPlaneUrl: controlPlaneUrl.trim().replace(/\/+$/, ""),
			color,
		}));
		new Notice("Saved — reloading Custom Relay to apply…", 4000);
		custom.reloadPlugin();
	}

	/**
	 * Redeem a folder secret. The control-plane records this user as a member of
	 * that folder, after which it will mint tokens for it; a reload follows so
	 * the registry is re-fetched and the folder appears.
	 */
	async function addFolder() {
		// Join against the control-plane the plugin is actually using, not an
		// unsaved edit in the URL box.
		const saved = custom.settings.get() ?? {};
		const secret = folderSecret.trim();
		if (!configuredUrl || !saved.userId) {
			new Notice("Set and save your control-plane URL first.", 6000);
			return;
		}
		if (!secret) {
			new Notice("Enter the folder secret your admin gave you.", 5000);
			return;
		}
		joining = true;
		try {
			const token = makeIdentityToken({
				id: saved.userId,
				name: saved.displayName || "Anonymous",
			});
			const res = await requestUrl({
				url: `${configuredUrl}/join`,
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ secret }),
				throw: false,
			});
			if (res.status === 200) {
				const name =
					(res.json as { name?: string } | undefined)?.name ?? "the folder";
				new Notice(`Joined ${name} — reloading to sync it…`, 5000);
				folderSecret = "";
				custom.reloadPlugin();
			} else if (res.status === 404) {
				new Notice("That folder secret wasn't recognised.", 6000);
			} else if (res.status === 401) {
				new Notice(
					"The control-plane rejected your identity — save your settings first.",
					8000,
				);
			} else {
				new Notice(`Could not add the folder (HTTP ${res.status}).`, 8000);
			}
		} catch (e) {
			new Notice(
				`Could not reach the control-plane: ${e instanceof Error ? e.message : String(e)}`,
				8000,
			);
		} finally {
			joining = false;
		}
	}
</script>

<div class="setting-item-heading">Server</div>
<div class="setting-item">
	<div class="setting-item-info">
		<div class="setting-item-name">Connect to</div>
		<div class="setting-item-description">
			Your own self-hosted Relay server, or the official Relay service by
			System 3. Each keeps its own shared folders; switching reloads the
			plugin.
		</div>
	</div>
	<div class="setting-item-control">
		<select
			class="dropdown"
			bind:value={mode}
			on:change={() => custom.switchMode(mode)}
		>
			<option value="custom">Self-hosted server</option>
			<option value="official">Official Relay (System 3)</option>
		</select>
	</div>
</div>

{#if custom.isCustom}
	<div class="setting-item">
		<div class="setting-item-info">
			<div class="setting-item-name">Display name</div>
			<div class="setting-item-description">Shown to collaborators (cursors).</div>
		</div>
		<div class="setting-item-control">
			<input type="text" placeholder="Your name" bind:value={displayName} />
		</div>
	</div>

	<div class="setting-item">
		<div class="setting-item-info">
			<div class="setting-item-name">Your color</div>
			<div class="setting-item-description">
				Your cursor and presence color. Pick a preset or a custom color.
			</div>
		</div>
		<div class="setting-item-control">
			<div class="swatches">
				{#each usercolors as c}
					<button
						type="button"
						class="swatch"
						class:selected={color.toLowerCase() === c.color.toLowerCase()}
						style={`background:${c.color}`}
						aria-label={c.color}
						on:click={() => (color = c.color)}
					></button>
				{/each}
			</div>
			<input type="color" bind:value={color} />
		</div>
	</div>

	<div class="setting-item">
		<div class="setting-item-info">
			<div class="setting-item-name">Control-plane URL</div>
			<div class="setting-item-description">
				e.g. http://relay.example.com:8094 (reachable over your VPN/LAN)
				{#if configuredUrl}
					<br />
					{#if compat === "checking"}
						Checking <code>{configuredUrl}</code>…
					{:else if compat === "ok"}
						Connected to control-plane {controlPlaneVersion} ✓
					{:else if compat === "mismatch"}
						<span class="mod-warning">
							Control-plane {controlPlaneVersion} doesn't match this plugin
							({plugin.version}). Update one so both share the same x.y.z.
						</span>
					{:else if compat === "unknown"}
						<span class="mod-warning">
							The control-plane doesn't report a version (older than 0.8.12).
							Update it to match this plugin ({plugin.version}).
						</span>
					{:else}
						<span class="mod-warning">
							Can't reach <code>{configuredUrl}</code>.
						</span>
					{/if}
				{/if}
			</div>
		</div>
		<div class="setting-item-control">
			<input
				type="text"
				placeholder="http://host:port"
				bind:value={controlPlaneUrl}
			/>
		</div>
	</div>

	<div class="setting-item">
		<div class="setting-item-info"></div>
		<div class="setting-item-control">
			<button class="mod-cta" on:click={save}>Save</button>
		</div>
	</div>

	{#if configuredUrl}
		<div class="setting-item">
			<div class="setting-item-info">
				<div class="setting-item-name">Add a folder</div>
				<div class="setting-item-description">
					Each shared folder has its own secret. Paste the one your admin gave
					you to gain access — the plugin reloads and the folder appears.
				</div>
			</div>
			<div class="setting-item-control">
				<input
					type="text"
					placeholder="XXXX-XXXX-XXXX-XXXX"
					bind:value={folderSecret}
					disabled={joining}
				/>
				<button on:click={addFolder} disabled={joining}>
					{joining ? "Adding…" : "Add folder"}
				</button>
			</div>
		</div>
	{/if}
{/if}

<style>
	.swatches {
		display: inline-flex;
		gap: 6px;
		margin-right: 8px;
	}
	.swatch {
		width: 20px;
		height: 20px;
		padding: 0;
		border-radius: 50%;
		border: 2px solid var(--background-modifier-border);
		box-shadow: none;
		cursor: pointer;
	}
	.swatch.selected {
		border-color: var(--text-normal);
		outline: 2px solid var(--text-normal);
		outline-offset: 1px;
	}
</style>

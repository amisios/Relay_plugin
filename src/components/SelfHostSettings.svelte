<script lang="ts">
	import type Live from "src/main";
	import { Notice, requestUrl } from "obsidian";
	import { usercolors, colorFromString } from "../User";
	import { makeIdentityToken } from "../local/FakePocketBase";

	export let plugin: Live;

	const current = plugin.selfHostSettings.get() ?? {};
	let displayName: string = current.displayName ?? "";
	let controlPlaneUrl: string = current.controlPlaneUrl ?? "";
	let color: string =
		current.color ??
		(current.userId ? colorFromString(current.userId).color : "#30bced");
	const configured = !!current.controlPlaneUrl;

	let folderSecret: string = "";
	let joining = false;

	// Reload the plugin so settings changes apply without the user manually
	// toggling it off/on in Community plugins. Deferred so this handler can
	// return and the Notice can paint before the plugin (and this settings
	// view) is torn down and rebuilt.
	function reloadPlugin() {
		const app = plugin.app as unknown as {
			plugins: {
				disablePlugin(id: string): Promise<void>;
				enablePlugin(id: string): Promise<void>;
			};
		};
		const id = plugin.manifest.id;
		setTimeout(async () => {
			try {
				await app.plugins.disablePlugin(id);
				await app.plugins.enablePlugin(id);
			} catch (e) {
				new Notice(
					"Could not auto-reload; toggle the plugin off and on to apply.",
					8000,
				);
			}
		}, 150);
	}

	async function save() {
		if (!controlPlaneUrl.trim()) {
			new Notice("Enter a control-plane URL.", 5000);
			return;
		}
		await plugin.selfHostSettings.update((cur) => ({
			...cur,
			displayName: displayName.trim(),
			controlPlaneUrl: controlPlaneUrl.trim().replace(/\/+$/, ""),
			color,
		}));
		new Notice("Saved — reloading Custom Relay to apply…", 4000);
		reloadPlugin();
	}

	/**
	 * Redeem a folder secret. The control-plane records this user as a member of
	 * that folder, after which it will mint tokens for it; a reload follows so
	 * the registry is re-fetched and the folder appears.
	 */
	async function addFolder() {
		// Join against the CONFIGURED control-plane, not whatever is currently
		// typed in the URL box — an unsaved edit there would send the secret
		// somewhere the plugin isn't actually using.
		const saved = plugin.selfHostSettings.get() ?? {};
		const url = (saved.controlPlaneUrl ?? controlPlaneUrl)
			.trim()
			.replace(/\/+$/, "");
		const secret = folderSecret.trim();
		if (!url) {
			new Notice("Set and save your control-plane URL first.", 6000);
			return;
		}
		if (!secret) {
			new Notice("Enter the folder secret your admin gave you.", 5000);
			return;
		}
		if (!saved.userId) {
			new Notice("Save your settings first, then add a folder.", 6000);
			return;
		}
		joining = true;
		try {
			const token = makeIdentityToken({
				id: saved.userId,
				name: saved.displayName || "Anonymous",
			});
			const res = await requestUrl({
				url: `${url}/join`,
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
				reloadPlugin();
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

	async function disable() {
		await plugin.selfHostSettings.update((cur) => ({
			...cur,
			controlPlaneUrl: "",
		}));
		new Notice("Self-hosted mode cleared — reloading…", 4000);
		reloadPlugin();
	}
</script>

<div class="setting-item-heading">Self-hosted (custom)</div>
<div class="setting-item-description" style="margin-bottom: 12px;">
	Connect directly to your own Relay control-plane instead of the official
	hosted service. Set your display name, color, and the control-plane URL —
	changes apply on Save (the plugin reloads automatically).
	{#if configured}
		<br /><strong>Currently configured:</strong>
		<code>{current.controlPlaneUrl}</code>
	{/if}
</div>

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
			e.g. http://relay.example.com:8095 (reachable over your VPN/LAN)
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

{#if configured}
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

<div class="setting-item">
	<div class="setting-item-info"></div>
	<div class="setting-item-control">
		{#if configured}
			<button on:click={disable}>Disable self-hosting</button>
		{/if}
		<button class="mod-cta" on:click={save}>Save</button>
	</div>
</div>

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

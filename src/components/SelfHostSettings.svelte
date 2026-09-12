<script lang="ts">
	import type Live from "src/main";
	import { Notice } from "obsidian";
	import { usercolors, colorFromString } from "../User";

	export let plugin: Live;

	const current = plugin.selfHostSettings.get() ?? {};
	let displayName: string = current.displayName ?? "";
	let controlPlaneUrl: string = current.controlPlaneUrl ?? "";
	let color: string =
		current.color ??
		(current.userId ? colorFromString(current.userId).color : "#30bced");
	const configured = !!current.controlPlaneUrl;

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
			e.g. http://192.168.178.40:8095 (reachable over your VPN)
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

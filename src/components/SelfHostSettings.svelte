<script lang="ts">
	import type Live from "src/main";
	import { Notice } from "obsidian";

	export let plugin: Live;

	const current = plugin.selfHostSettings.get() ?? {};
	let displayName: string = current.displayName ?? "";
	let controlPlaneUrl: string = current.controlPlaneUrl ?? "";
	const configured = !!current.controlPlaneUrl;

	async function save() {
		if (!controlPlaneUrl.trim()) {
			new Notice("Enter a control-plane URL.", 5000);
			return;
		}
		await plugin.selfHostSettings.update((cur) => ({
			...cur,
			displayName: displayName.trim(),
			controlPlaneUrl: controlPlaneUrl.trim().replace(/\/+$/, ""),
		}));
		new Notice(
			"Saved. Disable and re-enable “Relay (Custom)” in Community plugins to apply.",
			10000,
		);
	}

	async function disable() {
		await plugin.selfHostSettings.update((cur) => ({
			...cur,
			controlPlaneUrl: "",
		}));
		new Notice(
			"Self-hosted mode cleared. Reload the plugin to apply.",
			8000,
		);
	}
</script>

<div class="setting-item-heading">Self-hosted (custom)</div>
<div class="setting-item-description" style="margin-bottom: 12px;">
	Connect directly to your own Relay control-plane instead of the official
	hosted service. Set your display name and the control-plane URL, then disable
	and re-enable this plugin to apply.
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

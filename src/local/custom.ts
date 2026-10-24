// Custom Relay: one plugin, two backends.
//
//   "custom"   (default) a self-hosted control-plane with folder secrets and a
//              self-declared identity (see FakePocketBase).
//   "official" the upstream System 3 service, exactly as upstream ships it.
//
// Everything mode-specific lives here; upstream files only carry small hooks
// marked `// [custom]`, so upstream releases merge with few conflicts. The mode
// is fixed for a plugin lifetime: switching saves the setting and reloads.

import { Notice, type Plugin } from "obsidian";
import { v4 as uuidv4 } from "uuid";
import { NamespacedSettings, type SettingsTree } from "../SettingsStorage";
import type { EndpointManager } from "../EndpointManager";
import type { RelayManager } from "../RelayManager";
import { ObservablePermission } from "../PolicyManager";
import type { Permission } from "../Relay";
import type { SelfHostConfig } from "./FakePocketBase";

declare const GIT_TAG: string;

export type BackendMode = "custom" | "official";

/** Persisted shape of the `selfHost` settings namespace in data.json. */
export interface SelfHostSettings {
	mode?: BackendMode;
	controlPlaneUrl?: string;
	displayName?: string;
	icon?: string;
	color?: string;
	userId?: string;
	/** Which mode the active `sharedFolders` list belongs to. */
	foldersMode?: BackendMode;
	/** The other mode's `sharedFolders` list, parked while it is inactive. */
	inactiveFolders?: Partial<Record<BackendMode, unknown[]>>;
}

/** Never resolves (RFC 2606), so an unconfigured custom mode can't fall back to System 3. */
const UNCONFIGURED_URL = "http://control-plane.invalid";

/** Upstream's plugin id, spelled so the build-time id rewrite leaves it alone. */
const OFFICIAL_PLUGIN_ID = ["system3", "relay"].join("-");

/** Server-side administration the control-plane does not implement. */
const ADMIN_PERMISSIONS = new Set([
	"relay.rename",
	"relay.manage_users",
	"relay.manage_sharing",
	"relay.delete",
	"folder.manage_users",
	"folder.make_private",
	"folder.rename",
	"folder.delete",
	"subscription.manage",
]);

const instances = new WeakMap<Plugin, CustomRelay>();

export class CustomRelay {
	private constructor(
		private readonly plugin: Plugin,
		readonly settings: NamespacedSettings<SelfHostSettings>,
		readonly mode: BackendMode,
		/** Set in custom mode; `controlPlaneUrl` is empty until configured. */
		readonly selfHost?: SelfHostConfig,
	) {}

	/**
	 * Read the mode and park/restore the shared-folder list for it. Must run
	 * before upstream creates its `sharedFolders` settings, so neither mode
	 * ever loads the other backend's folders.
	 */
	static async init(plugin: Plugin, settingsTree: SettingsTree): Promise<CustomRelay> {
		const stored = (settingsTree.get().selfHost ?? {}) as SelfHostSettings;
		const mode: BackendMode = stored.mode === "official" ? "official" : "custom";
		const foldersMode = stored.foldersMode ?? mode;
		const needsUserId = mode === "custom" && !stored.userId;

		if (stored.foldersMode !== mode || needsUserId) {
			await settingsTree.update((current) => {
				const selfHost = { ...((current.selfHost ?? {}) as SelfHostSettings) };
				let sharedFolders = current.sharedFolders;
				if (foldersMode !== mode) {
					const inactive = { ...selfHost.inactiveFolders };
					inactive[foldersMode] = (current.sharedFolders as unknown[]) ?? [];
					sharedFolders = inactive[mode] ?? [];
					delete inactive[mode];
					selfHost.inactiveFolders = inactive;
				}
				selfHost.foldersMode = mode;
				if (needsUserId) selfHost.userId = uuidv4();
				return { ...current, sharedFolders, selfHost };
			});
		}

		const settings = new NamespacedSettings<SelfHostSettings>(settingsTree, "selfHost");
		plugin.register(() => settings.destroy());
		const s = settings.get();
		const selfHost: SelfHostConfig | undefined =
			mode === "custom"
				? {
						controlPlaneUrl: s.controlPlaneUrl?.trim().replace(/\/+$/, "") ?? "",
						displayName: s.displayName?.trim() || "Anonymous",
						icon: s.icon,
						color: s.color,
						userId: s.userId as string,
					}
				: undefined;

		const custom = new CustomRelay(plugin, settings, mode, selfHost);
		instances.set(plugin, custom);
		custom.warnIfOfficialPluginEnabled();
		return custom;
	}

	static for(plugin: Plugin): CustomRelay {
		const custom = instances.get(plugin);
		if (!custom) throw new Error("CustomRelay.init() has not run for this plugin");
		return custom;
	}

	get isCustom(): boolean {
		return this.mode === "custom";
	}

	get isConfigured(): boolean {
		return !!this.selfHost?.controlPlaneUrl;
	}

	private get controlPlaneUrl(): string {
		return this.selfHost?.controlPlaneUrl || UNCONFIGURED_URL;
	}

	/** Custom mode: API + auth go to the control-plane. Returns false in official mode. */
	configureEndpoints(endpointManager: EndpointManager): boolean {
		if (!this.isCustom) return false;
		endpointManager.setCustomEndpoints(this.controlPlaneUrl, this.controlPlaneUrl);
		return true;
	}

	/** Custom mode probes the control-plane, reporting our version for its logs. */
	healthUrl(upstreamHealthUrl: string): string {
		if (!this.isCustom) return upstreamHealthUrl;
		return `${this.controlPlaneUrl}/health?version=${encodeURIComponent(GIT_TAG)}`;
	}

	/**
	 * Custom mode: the control-plane owns relays, sharing and membership, so
	 * upstream's admin controls (rename, share keys, kick, destroy, plans…) are
	 * denied and the settings UI hides them through its own permission checks.
	 */
	restrictPermissions(relayManager: RelayManager): void {
		if (!this.isCustom) return;
		const can = relayManager.can.bind(relayManager);
		relayManager.can = (principal, permission: Permission, resource, context) =>
			ADMIN_PERMISSIONS.has(permission.join("."))
				? new ObservablePermission(() => false, [])
				: can(principal, permission, resource, context);
	}

	async switchMode(mode: BackendMode): Promise<void> {
		if (mode === this.mode) return;
		await this.settings.update((current) => ({ ...current, mode }));
		new Notice(
			mode === "custom"
				? "Switching to your self-hosted server — reloading…"
				: "Switching to the official Relay service — reloading…",
			4000,
		);
		this.reloadPlugin();
	}

	/**
	 * Reload so settings changes apply without toggling the plugin by hand.
	 * Deferred so the caller can return and its Notice can paint before the
	 * plugin (and the settings view) is torn down and rebuilt.
	 */
	reloadPlugin(): void {
		const app = this.plugin.app as unknown as {
			plugins: {
				disablePlugin(id: string): Promise<void>;
				enablePlugin(id: string): Promise<void>;
			};
		};
		const id = this.plugin.manifest.id;
		setTimeout(async () => {
			try {
				await app.plugins.disablePlugin(id);
				await app.plugins.enablePlugin(id);
			} catch (e) {
				new Notice("Could not auto-reload; toggle the plugin off and on to apply.", 8000);
			}
		}, 150);
	}

	/** Two sync engines on one vault would fight over the same files. */
	private warnIfOfficialPluginEnabled(): void {
		if (this.isCustom) return;
		const plugins = (this.plugin.app as unknown as {
			plugins?: { enabledPlugins?: Set<string> };
		}).plugins;
		if (plugins?.enabledPlugins?.has(OFFICIAL_PLUGIN_ID)) {
			new Notice(
				"Custom Relay is in official mode while the official Relay plugin is also enabled. " +
					"Disable one of them so they don't both sync the same folders.",
				15000,
			);
		}
	}
}

// FolderSafety: keeps shared folders from being wiped by renames and mass
// removals. Active in both modes (it is client-side safety only); turn it off
// with `folderSafety.enabled = false` in data.json.
//
//   1. Relocation — renaming a shared folder's PARENT (or any ancestor) moves
//      the share along, in any event order. Upstream only handled renaming the
//      shared folder itself.
//   2. Outbound guard (outboundGuard.ts) — this device's removals wait ~2 s;
//      mass removals need confirmation; a vanished shared folder is paused,
//      never deleted for everyone.
//   3. Inbound guard (inboundGuard.ts) — a collaborator's mass removal is held
//      on this device until confirmed; smaller removals go to a structured
//      backup under .trash/relay/.
//
// Hooks into upstream (all marked [custom]): main.ts (init, rename handler,
// flushVaultDeletes, _createSharedFolder) and SharedFolder.ts
// (cleanupExtraLocalFiles, isNovelPath).

import { around } from "monkey-around";
import { type Plugin, TFolder, type TAbstractFile, type Vault } from "obsidian";
import { NamespacedSettings, type SettingsTree } from "../SettingsStorage";
import type { SharedFolder, SharedFolders, SharedFolderSettings } from "../SharedFolder";
import { SyncType } from "../SyncTypes";
import { InboundGuard, type InboundFolder, type InboundHost, registerInbound, unregisterInbound } from "./inboundGuard";
import { type GuardedFolder, OutboundGuard, type OutboundHost } from "./outboundGuard";
import { ObsidianSafetyUI, type SafetyUI } from "./SafetyModal";
import {
	basename,
	inferMovedRoot,
	isUnder,
	overlapsAny,
	planAncestorRelocations,
	rankCandidates,
	relocatePath,
	scoreCandidate,
} from "./safetyPaths";
import { TIMING } from "./safetyPolicy";

/** Persisted under `folderSafety` in data.json. */
export interface FolderSafetySettings {
	/** Escape hatch; default true. */
	enabled?: boolean;
	/** Collaborators' removals waiting for a decision, per folder guid. */
	holds?: Record<string, { paths: string[]; since: number; folderPath: string }>;
	/** What a paused (vanished) folder contained, to recognise it elsewhere. */
	fingerprints?: Record<string, { path: string; sample: string[]; at: number }>;
}

type SafetyPlugin = Plugin & { sharedFolders?: SharedFolders };

/** Members the guards rely on; if upstream drops one, the guard stands down. */
const REQUIRED_MEMBERS = [
	"syncStore",
	"checkPath",
	"getVirtualPath",
	"existsSync",
	"isSyncableTFile",
	"deleteFiles",
	"renameFile",
	"syncFileTree",
	"onDestroy",
	"move",
] as const;

/** When a vanished folder is looked for again (ms after it vanished). */
const DETECT_DELAYS = [0, 500, 2000, 5000, 15_000, 60_000];
const BACKSTOP_MIN_SCORE = 0.8;
const FOLLOW_MIN_SCORE = 0.5;

const instances = new WeakMap<Plugin, FolderSafety>();

export class FolderSafety implements OutboundHost, InboundHost {
	readonly ui: SafetyUI;
	private readonly settings: NamespacedSettings<FolderSafetySettings>;
	private readonly folderList: NamespacedSettings<SharedFolderSettings[]>;
	private writes: Promise<void> = Promise.resolve();
	private readonly holds = new Map<string, Set<string>>();
	private readonly outbound = new WeakMap<object, OutboundGuard>();
	private readonly inbound = new WeakMap<object, InboundGuard>();
	private readonly inAppDeletes = new Map<string, number>();
	private readonly following = new Set<string>();
	private unloaded = false;
	private warnedContract = false;

	private constructor(
		private readonly plugin: SafetyPlugin,
		settingsTree: SettingsTree,
		ui?: SafetyUI,
	) {
		this.ui = ui ?? new ObsidianSafetyUI(plugin.app);
		this.settings = new NamespacedSettings<FolderSafetySettings>(settingsTree, "folderSafety");
		this.folderList = new NamespacedSettings<SharedFolderSettings[]>(settingsTree, "sharedFolders");
		for (const [guid, hold] of Object.entries(this.settings.get()?.holds ?? {})) {
			this.holds.set(guid, new Set(hold.paths));
		}
	}

	static init(plugin: Plugin, settingsTree: SettingsTree): FolderSafety {
		const safety = new FolderSafety(plugin as SafetyPlugin, settingsTree);
		instances.set(plugin, safety);
		safety.start();
		return safety;
	}

	static for(plugin: Plugin): FolderSafety {
		const safety = instances.get(plugin);
		if (!safety) throw new Error("FolderSafety.init() has not run for this plugin");
		return safety;
	}

	private start(): void {
		const plugin = this.plugin;
		plugin.register(() => {
			this.unloaded = true;
			this.settings.destroy();
			this.folderList.destroy();
		});
		this.recordInAppDeletes();
		plugin.addCommand({
			id: "review-held-removals",
			name: "Review held removals and paused folders",
			callback: () => this.review(),
		});
		plugin.app.workspace.onLayoutReady(() => {
			window.setTimeout(() => this.checkMissingRoots(), 5000);
		});
	}

	// --- shared host plumbing ------------------------------------------------

	enabled(): boolean {
		return this.settings.get()?.enabled !== false;
	}

	log(...args: unknown[]): void {
		console.log("[FolderSafety]", ...args);
	}

	private get vault(): Vault {
		return this.plugin.app.vault;
	}

	private get sharedFolders(): SharedFolders | undefined {
		return this.plugin.sharedFolders;
	}

	private loaded(): SharedFolder[] {
		return this.sharedFolders?.items() ?? [];
	}

	/** Serialise our settings writes (concurrent updates can lose each other). */
	private queue(write: () => Promise<void>): Promise<void> {
		this.writes = this.writes.then(write).catch((error) => this.log("settings write failed", error));
		return this.writes;
	}

	rootPresent(folder: { path: string }): boolean {
		return this.vault.getAbstractFileByPath(folder.path) instanceof TFolder;
	}

	// --- attach to each shared folder ---------------------------------------

	/** Called for every SharedFolder upstream creates. Returns it unchanged. */
	attach(folder: SharedFolder): SharedFolder {
		const record = folder as unknown as Record<string, unknown>;
		const missing = REQUIRED_MEMBERS.filter((m) => record[m] === undefined);
		if (missing.length > 0) {
			if (!this.warnedContract) {
				this.warnedContract = true;
				console.warn(
					`[FolderSafety] disabled: SharedFolder lacks ${missing.join(", ")} ` +
						`(upstream changed; update src/local/safety.ts)`,
				);
			}
			return folder;
		}
		const out = new OutboundGuard(folder as unknown as GuardedFolder, this);
		const uninstall = out.install();
		this.outbound.set(folder, out);
		const inn = new InboundGuard(folder as unknown as InboundFolder, this);
		registerInbound(folder, inn);
		this.inbound.set(folder, inn);
		folder.onDestroy(() => {
			uninstall();
			unregisterInbound(folder);
		});
		return folder;
	}

	// --- inbound host --------------------------------------------------------

	heldPaths(guid: string): ReadonlySet<string> {
		return this.holds.get(guid) ?? new Set();
	}

	setHold(folder: InboundFolder, paths: string[]): void {
		const guid = folder.guid;
		const current = this.holds.get(guid);
		if (paths.length === 0 && !current) return;
		if (current && current.size === paths.length && paths.every((p) => current.has(p))) return;
		if (paths.length === 0) this.holds.delete(guid);
		else this.holds.set(guid, new Set(paths));
		void this.queue(() =>
			this.settings.update((s) => {
				const holds = { ...(s?.holds ?? {}) };
				if (paths.length === 0) delete holds[guid];
				else holds[guid] = { paths, since: Date.now(), folderPath: folder.path };
				return { ...s, holds };
			}),
		);
	}

	republish(folder: InboundFolder): void {
		this.restartFolder(folder as unknown as SharedFolder);
		this.ui.notice(
			`Keeping your copies in “${basename(folder.path)}” — they are being shared again.`,
			8000,
		);
	}

	// --- outbound host -------------------------------------------------------

	onRootMissing(folder: GuardedFolder): void {
		if (this.wasDeletedInApp(folder.path)) return; // upstream drops the local copy
		this.followRoot(folder as unknown as SharedFolder);
	}

	pause(folder: GuardedFolder): void {
		const shared = folder as unknown as SharedFolder;
		this.outbound.get(shared)?.discard();
		this.sharedFolders?.suspend(shared);
		this.ui.notice(
			`Relay paused “${basename(folder.path)}” on this device. Nothing was sent. ` +
				`Reload Obsidian (or run “Review held removals and paused folders”) to resume; ` +
				`missing files are then restored from the shared copy.`,
			15_000,
		);
	}

	// --- hooks called from main.ts -------------------------------------------

	/**
	 * First thing in the vault "rename" handler. Moves shared folders along
	 * when one of their ancestors is renamed, and catches the case where items
	 * leave a shared folder whose root is already gone (child-first order).
	 * Never consumes the event: upstream's handler runs afterwards.
	 */
	beforeVaultRename(file: TAbstractFile, oldPath: string): void {
		if (!this.enabled() || this.unloaded) return;
		try {
			let moved = false;
			const loaded = this.loaded();
			if (file instanceof TFolder) {
				const finalPaths = loaded.map((f) => relocatePath(f.path, oldPath, file.path) ?? f.path);
				for (const plan of planAncestorRelocations(loaded.map((f) => f.path), oldPath, file.path)) {
					const folder = loaded.find((f) => f.path === plan.from);
					if (!folder) continue;
					const others = finalPaths.filter((_, i) => loaded[i] !== folder);
					if (overlapsAny(plan.to, others)) {
						this.log(`not following ${plan.from} → ${plan.to}: it would overlap another shared folder`);
						this.pause(folder as unknown as GuardedFolder);
						continue;
					}
					this.relocateLoaded(folder, plan.to, "parent renamed");
					moved = true;
				}
				this.rewriteUnloadedPaths(oldPath, file.path);
			}
			// Backstop: an item left a shared folder whose root no longer exists.
			for (const folder of this.loaded()) {
				if (!isUnder(oldPath, folder.path) || isUnder(file.path, folder.path)) continue;
				if (this.rootPresent(folder)) continue;
				const to = inferMovedRoot(folder.path, oldPath, file.path);
				if (!to || !(this.vault.getAbstractFileByPath(to) instanceof TFolder)) continue;
				const others = this.loaded().filter((f) => f !== folder).map((f) => f.path);
				if (overlapsAny(to, others)) continue;
				const sample = sampleFiles(folder, 50);
				const score = scoreCandidate(sample, to, (p) => this.vault.getAbstractFileByPath(p) !== null);
				if (sample.length > 0 && score < BACKSTOP_MIN_SCORE) continue;
				this.relocateLoaded(folder, to, "moved with its contents");
				moved = true;
			}
			if (moved) this.sharedFolders?.update();
		} catch (error) {
			this.log("rename follow failed", error);
		}
	}

	/**
	 * flushVaultDeletes found a shared folder's ROOT among the deletes. Upstream
	 * would forget the share on this device. If the user deleted it in Obsidian,
	 * let upstream do that (return false). Otherwise it vanished from outside
	 * (Finder, another sync tool): pause it and look for where it went.
	 */
	onRootDeleted(folder: SharedFolder): boolean {
		if (!this.enabled() || this.unloaded) return false;
		if (this.wasDeletedInApp(folder.path)) return false;
		this.followRoot(folder);
		return true;
	}

	// --- relocation & following ----------------------------------------------

	private relocateLoaded(folder: SharedFolder, to: string, why: string): void {
		this.log(`following ${folder.path} → ${to} (${why})`);
		this.outbound.get(folder)?.discard();
		folder.move(to);
	}

	/** Suspended / not-loaded registrations under a renamed folder follow too. */
	private rewriteUnloadedPaths(oldPath: string, newPath: string): void {
		const loadedGuids = new Set(this.loaded().map((f) => f.guid));
		const list = this.folderList.get() ?? [];
		const affected = list.filter(
			(e) => !loadedGuids.has(e.guid) && relocatePath(e.path, oldPath, newPath) !== null,
		);
		if (affected.length === 0) return;
		void this.queue(() =>
			this.folderList.update((current) =>
				current.map((e) =>
					affected.some((a) => a.guid === e.guid)
						? { ...e, path: relocatePath(e.path, oldPath, newPath) ?? e.path }
						: e,
				),
			),
		);
	}

	private followRoot(folder: SharedFolder): void {
		const guid = folder.guid;
		if (this.following.has(guid) || this.unloaded) return;
		this.following.add(guid);
		const oldPath = folder.path;
		const sample = sampleFiles(folder, 200);
		this.outbound.get(folder)?.discard();
		void this.queue(() =>
			this.settings.update((s) => ({
				...s,
				fingerprints: { ...(s?.fingerprints ?? {}), [guid]: { path: oldPath, sample, at: Date.now() } },
			})),
		);
		this.sharedFolders?.suspend(folder);
		this.log(`"${oldPath}" vanished; paused it and looking for where it went`);
		this.ui.notice(
			`Shared folder “${basename(oldPath)}” disappeared from ${oldPath}. Relay paused it ` +
				`on this device — nothing was removed for your collaborators.`,
			12_000,
		);
		this.detect(guid, oldPath, sample, 0);
	}

	private detect(guid: string, oldPath: string, sample: string[], step: number): void {
		window.setTimeout(() => {
			if (this.unloaded || !this.following.has(guid)) return;
			if (this.vault.getAbstractFileByPath(oldPath) instanceof TFolder) {
				this.following.delete(guid);
				this.relink(guid);
				this.ui.notice(`“${basename(oldPath)}” is back — syncing resumed.`, 6000);
				return;
			}
			const best = this.findCandidate(oldPath, sample);
			if (best || step + 1 >= DETECT_DELAYS.length) {
				this.askFollow(guid, oldPath, best);
				return;
			}
			this.detect(guid, oldPath, sample, step + 1);
		}, DETECT_DELAYS[step]);
	}

	private findCandidate(oldPath: string, sample: string[]): string | null {
		const roots = this.loaded().map((f) => f.path);
		const folders = this.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path !== oldPath && f.path !== "/")
			.map((f) => f.path)
			.filter((p) => p !== "" && !overlapsAny(p, roots));
		if (sample.length === 0) {
			const sameName = folders.filter((p) => basename(p) === basename(oldPath));
			return sameName.length === 1 ? sameName[0] : null;
		}
		const ranked = rankCandidates(sample.slice(0, 30), folders, (p) => this.vault.getAbstractFileByPath(p) !== null);
		const best = ranked[0];
		return best && best.score >= FOLLOW_MIN_SCORE ? best.root : null;
	}

	private askFollow(guid: string, oldPath: string, to: string | null): void {
		const name = basename(oldPath);
		const done = () => this.following.delete(guid);
		this.ui.ask(`root:${guid}`, {
			title: to ? `Did “${name}” move to ${to}?` : `Shared folder “${name}” is missing`,
			message: to
				? `The shared folder “${name}” disappeared from ${oldPath}, and ${to} holds the same ` +
					`files. Relay paused it — nothing was removed for your collaborators.`
				: `The shared folder “${name}” disappeared from ${oldPath} and Relay could not find ` +
					`where it went. It is paused — nothing was removed for your collaborators. It ` +
					`resumes by itself if the folder comes back to ${oldPath}.`,
			actions: [
				...(to
					? [{ label: `Follow it to ${to}`, cta: true, run: () => { done(); void this.relocateRegistration(guid, to); } }]
					: []),
				{ label: "Stop syncing it on this device", warning: !!to, run: () => { done(); void this.forgetRegistration(guid); } },
			],
			onDismiss: () => {
				done();
				this.ui.notice(
					`“${name}” stays paused. Run “Review held removals and paused folders” to decide later.`,
					10_000,
				);
			},
		});
	}

	private updateEntry(guid: string, change: (e: SharedFolderSettings) => SharedFolderSettings): Promise<void> {
		return this.queue(() =>
			this.folderList.update((list) => list.map((e) => (e.guid === guid ? change(e) : e))),
		);
	}

	private async relocateRegistration(guid: string, to: string): Promise<void> {
		await this.updateEntry(guid, (e) => ({ ...e, path: to, suspended: undefined, suspendedAt: undefined }));
		this.relink(guid);
		this.ui.notice(`“${basename(to)}” now syncs from ${to}.`, 6000);
	}

	/** Upstream's own cleanup for a share that left this device (peers keep their files). */
	private async forgetRegistration(guid: string): Promise<void> {
		await this.updateEntry(guid, (e) => ({ ...e, suspended: true, suspendedAt: 0 }));
		this.relink(guid);
	}

	/** (Re)load one registration from settings, the way startup does. */
	private relink(guid: string): void {
		const entry = (this.folderList.get() ?? []).find((e) => e.guid === guid);
		const shared = this.sharedFolders as unknown as
			| { _load?: (entries: SharedFolderSettings[]) => void; load(): void }
			| undefined;
		if (!entry || !shared) return;
		if (typeof shared._load === "function") shared._load([entry]);
		else shared.load();
	}

	/** Stop and restart a folder (fresh state, e.g. to re-share kept files). */
	private restartFolder(folder: SharedFolder): void {
		const guid = folder.guid;
		this.outbound.get(folder)?.discard();
		this.sharedFolders?.suspend(folder);
		window.setTimeout(() => {
			if (!this.unloaded) this.relink(guid);
		}, 1000);
	}

	// --- startup & review ------------------------------------------------------

	/** Registrations whose folder is missing (e.g. renamed while Obsidian was closed). */
	private checkMissingRoots(): void {
		if (!this.enabled() || this.unloaded) return;
		const loadedGuids = new Set(this.loaded().map((f) => f.guid));
		const fingerprints = this.settings.get()?.fingerprints ?? {};
		for (const entry of this.folderList.get() ?? []) {
			if (loadedGuids.has(entry.guid) || this.following.has(entry.guid)) continue;
			if (this.vault.getAbstractFileByPath(entry.path) instanceof TFolder) continue;
			const to = this.findCandidate(entry.path, fingerprints[entry.guid]?.sample ?? []);
			if (!to) continue;
			this.following.add(entry.guid);
			this.askFollow(entry.guid, entry.path, to);
		}
	}

	review(): void {
		let found = false;
		for (const folder of this.loaded()) {
			const guard = this.inbound.get(folder);
			if (guard?.hasHold()) {
				found = true;
				guard.review();
			}
		}
		const loadedGuids = new Set(this.loaded().map((f) => f.guid));
		const fingerprints = this.settings.get()?.fingerprints ?? {};
		for (const entry of this.folderList.get() ?? []) {
			if (loadedGuids.has(entry.guid)) continue;
			found = true;
			if (this.vault.getAbstractFileByPath(entry.path) instanceof TFolder) {
				this.askResume(entry);
			} else {
				this.following.add(entry.guid);
				this.askFollow(entry.guid, entry.path, this.findCandidate(entry.path, fingerprints[entry.guid]?.sample ?? []));
			}
		}
		if (!found) this.ui.notice("Nothing is on hold, and no shared folder is paused.", 6000);
	}

	private askResume(entry: SharedFolderSettings): void {
		const name = basename(entry.path);
		this.ui.ask(`resume:${entry.guid}`, {
			title: `Resume “${name}”?`,
			message:
				`The shared folder “${name}” is paused on this device. Resuming syncs it again; ` +
				`files missing here are restored from the shared copy.`,
			actions: [
				{ label: "Resume now", cta: true, run: () => this.relink(entry.guid) },
				{ label: "Stop syncing it on this device", warning: true, run: () => void this.forgetRegistration(entry.guid) },
			],
		});
	}

	// --- in-app deletes ----------------------------------------------------------

	/** Remember deletes made through Obsidian, so a deliberate delete stays upstream's. */
	private recordInAppDeletes(): void {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const safety = this;
		const record = (file: unknown) => {
			const path = (file as { path?: unknown } | null)?.path;
			if (typeof path === "string") safety.inAppDeletes.set(path, Date.now());
		};
		this.plugin.register(
			around(this.vault as unknown as Record<string, unknown>, {
				trash(next: unknown) {
					const original = next as (...args: unknown[]) => unknown;
					return function (this: unknown, ...args: unknown[]) {
						record(args[0]);
						return original.apply(this, args);
					};
				},
				delete(next: unknown) {
					const original = next as (...args: unknown[]) => unknown;
					return function (this: unknown, ...args: unknown[]) {
						record(args[0]);
						return original.apply(this, args);
					};
				},
			}),
		);
	}

	private wasDeletedInApp(path: string): boolean {
		const since = Date.now() - TIMING.inAppDeleteMs;
		for (const [p, at] of this.inAppDeletes) {
			if (at < since) {
				this.inAppDeletes.delete(p);
				continue;
			}
			if (path === p || isUnder(path, p)) return true;
		}
		return false;
	}
}

/** Up to `n` file vpaths of a folder, to recognise it elsewhere. */
function sampleFiles(folder: SharedFolder, n: number): string[] {
	const out: string[] = [];
	folder.syncStore.forEach((meta, path) => {
		if (out.length < n && meta.type !== SyncType.Folder) out.push(path);
	});
	return out;
}

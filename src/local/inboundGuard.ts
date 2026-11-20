// Inbound guard: protects THIS device's files from a collaborator's removals.
//
// Upstream's `cleanupExtraLocalFiles` (SharedFolder.ts) takes every file that
// left the shared membership off disk with `trashLocal`. Two `[custom]` hooks
// there call into this module:
//
//   const removal = beginInboundRemoval(this, ffiles, remotePaths);
//   if (removal.held) return [];          // a mass removal waits for the user
//   ... removal.trash(file) ...           // instead of adapter.trashLocal
//
// and `isNovelPath` asks `isHeldRemoval`, so held files are not re-uploaded as
// new files after a reload.
//
// The would-be removals are computed UP FRONT with the same filters upstream
// uses, so the decision covers the whole pass. Small removals still apply, but
// into a structure-keeping backup (removalBackup.ts); mass removals are held
// (persisted across reloads) until the user decides.

import { TFile, TFolder, type TAbstractFile } from "obsidian";
import type { SharedFolder } from "../SharedFolder";
import { RemovalBackup } from "./removalBackup";
import { decideRemoval, RemovalWindow, TIMING } from "./safetyPolicy";
import type { SafetyUI } from "./SafetyModal";
import { basename } from "./safetyPaths";

export type InboundFolder = Pick<
	SharedFolder,
	"path" | "guid" | "checkPath" | "getVirtualPath" | "isSyncableTFile" | "syncFileTree" | "vault"
>;

export interface InboundHost {
	enabled(): boolean;
	ui: SafetyUI;
	heldPaths(guid: string): ReadonlySet<string>;
	setHold(folder: InboundFolder, paths: string[]): void;
	/** Restart the folder so kept files are shared again as new files. */
	republish(folder: InboundFolder): void;
	log(...args: unknown[]): void;
}

export interface InboundRemoval {
	/** True: skip this pass entirely — nothing is taken off disk. */
	held: boolean;
	/** Replacement for `adapter.trashLocal(file.path)`. */
	trash(file: TAbstractFile): Promise<void>;
}

/** Upstream's private state that decides whether a file is removed. */
type PrivateBits = {
	pendingUpload?: { has?(key: string): boolean };
	pendingCreates?: { has?(key: string): boolean };
	_provider?: { synced?: boolean };
	_persistence?: { synced?: boolean };
};

const guards = new WeakMap<object, InboundGuard>();

export function registerInbound(folder: object, guard: InboundGuard): void {
	guards.set(folder, guard);
}

export function unregisterInbound(folder: object): void {
	guards.delete(folder);
}

function passthrough(folder: InboundFolder): InboundRemoval {
	return { held: false, trash: (file) => folder.vault.adapter.trashLocal(file.path) };
}

/** Hook for `cleanupExtraLocalFiles`. Never throws: falls back to upstream. */
export function beginInboundRemoval(
	folder: InboundFolder,
	ffiles: TAbstractFile[],
	remotePaths: ReadonlySet<string>,
): InboundRemoval {
	const guard = guards.get(folder);
	if (!guard) return passthrough(folder);
	try {
		return guard.begin(ffiles, remotePaths);
	} catch (error) {
		console.warn("[FolderSafety] inbound guard failed; using upstream behaviour", error);
		return passthrough(folder);
	}
}

/** Hook for `isNovelPath`: a held removal is not a new local file. */
export function isHeldRemoval(folder: InboundFolder, vpath: string): boolean {
	return guards.get(folder)?.isHeld(vpath) ?? false;
}

interface Pass {
	backup: RemovalBackup;
	moves: Promise<void>[];
}

export class InboundGuard {
	private readonly approved = new Set<string>();
	readonly window: RemovalWindow;
	private prompted = false;
	private pass: Pass | null = null;

	constructor(
		private readonly folder: InboundFolder,
		private readonly host: InboundHost,
		now: () => number = Date.now,
	) {
		this.window = new RemovalWindow(TIMING.windowMs, now);
	}

	isHeld(vpath: string): boolean {
		return this.host.enabled() && this.host.heldPaths(this.folder.guid).has(vpath);
	}

	hasHold(): boolean {
		return this.host.heldPaths(this.folder.guid).size > 0;
	}

	begin(ffiles: TAbstractFile[], remotePaths: ReadonlySet<string>): InboundRemoval {
		if (!this.host.enabled()) return passthrough(this.folder);
		const folder = this.folder;
		const bits = folder as unknown as PrivateBits;

		// The same filters as upstream's cleanupExtraLocalFiles.
		const candidates: string[] = [];
		let tracked = 0;
		for (const file of ffiles) {
			if (!(file instanceof TFile)) continue;
			if (!folder.isSyncableTFile(file)) continue;
			tracked++;
			if (!folder.checkPath(file.path)) continue;
			const vpath = folder.getVirtualPath(file.path);
			if (remotePaths.has(vpath)) continue;
			if (bits.pendingUpload?.has?.(vpath) || bits.pendingCreates?.has?.(vpath)) continue;
			candidates.push(vpath);
		}

		// Forget held paths that resolved themselves (re-added, or gone from disk).
		const held = this.host.heldPaths(folder.guid);
		const candidateSet = new Set(candidates);
		const stillHeld = [...held].filter((vpath) => candidateSet.has(vpath));
		if (stillHeld.length !== held.size) this.host.setHold(folder, stillHeld);

		const synced = Boolean(bits._provider?.synced && bits._persistence?.synced);
		if (!synced || candidates.length === 0) {
			// Upstream removes nothing in this pass anyway.
			return { held: stillHeld.length > 0, trash: (file) => this.trash(file) };
		}

		const fresh = candidates.filter((vpath) => !this.approved.has(vpath));
		if (stillHeld.length > 0) {
			const all = [...new Set([...stillHeld, ...fresh])];
			const grew = all.length > stillHeld.length;
			this.host.setHold(folder, all);
			if (grew || !this.prompted) this.prompt(all, `${all.length} files`);
			return { held: true, trash: (file) => this.trash(file) };
		}

		const recent = this.window.count();
		const decision = decideRemoval({
			removing: fresh.length,
			recentlyRemoved: recent,
			tracked: tracked + recent,
			rootPresent: true,
		});
		if (decision.kind === "hold") {
			this.host.setHold(folder, candidates);
			this.prompt(candidates, decision.reason);
			return { held: true, trash: (file) => this.trash(file) };
		}

		this.window.record(fresh.length);
		for (const vpath of candidates) this.approved.delete(vpath);
		return { held: false, trash: (file) => this.trash(file) };
	}

	/** Re-open the question (command palette). */
	review(): void {
		const held = [...this.host.heldPaths(this.folder.guid)];
		if (held.length === 0) return;
		this.prompted = false;
		this.prompt(held, `${held.length} files`);
	}

	private prompt(paths: string[], reason: string): void {
		this.prompted = true;
		const name = basename(this.folder.path);
		this.host.log(`holding ${paths.length} remote removals in "${name}" (${reason})`);
		this.host.ui.ask(`inbound:${this.folder.guid}`, {
			title: `A collaborator removed ${paths.length} files from “${name}”`,
			message:
				`Applying this would remove ${reason} from your copy of “${name}”. ` +
				`Your files are still here — nothing has been deleted. If this was a mistake ` +
				`(for example a folder renamed on a device where another sync tool also runs), ` +
				`keep your copies: they are shared with everyone again.`,
			paths,
			actions: [
				{
					label: "Keep my copies (share them again)",
					cta: true,
					run: () => {
						this.prompted = false;
						this.host.setHold(this.folder, []);
						this.host.republish(this.folder);
					},
				},
				{
					label: "Apply (move them to the backup)",
					run: () => {
						this.prompted = false;
						for (const vpath of paths) this.approved.add(vpath);
						this.host.setHold(this.folder, []);
						void this.folder.syncFileTree();
					},
				},
			],
			onDismiss: () =>
				this.host.ui.notice(
					`Removals in “${name}” are on hold — your files stay until you decide. ` +
						`Run “Review held removals and paused folders” from the command palette.`,
					12_000,
				),
		});
	}

	/** Move a removed file (or emptied folder) into the backup. */
	private trash(file: TAbstractFile): Promise<void> {
		const pass = this.currentPass();
		const vpath = this.folder.getVirtualPath(file.path);
		let move: Promise<void>;
		if (file instanceof TFolder) {
			// Upstream hands over files first, then folders: let the files land.
			const before = [...pass.moves];
			move = Promise.allSettled(before).then(() => pass.backup.moveFolder(file.path, vpath));
		} else {
			move = pass.backup.moveFile(file.path, vpath);
		}
		pass.moves.push(move);
		return move;
	}

	private currentPass(): Pass {
		if (this.pass) return this.pass;
		const pass: Pass = {
			backup: new RemovalBackup(
				this.folder.vault.adapter,
				basename(this.folder.path),
				this.folder.guid,
				this.folder.path,
			),
			moves: [],
		};
		this.pass = pass;
		// Upstream calls trash() synchronously for the whole pass; finish after it.
		setTimeout(() => this.finishPass(pass), 0);
		return pass;
	}

	private finishPass(pass: Pass): void {
		if (this.pass === pass) this.pass = null;
		void Promise.allSettled(pass.moves).then(async () => {
			try {
				await pass.backup.writeManifest();
			} catch (error) {
				this.host.log("could not write the backup manifest", error);
			}
			const n = pass.backup.count;
			if (n > 0) {
				const name = basename(this.folder.path);
				this.host.ui.notice(
					`${n} file${n === 1 ? "" : "s"} removed from “${name}” by a collaborator ` +
						`${n === 1 ? "was" : "were"} moved to ${pass.backup.dir}`,
					10_000,
				);
			}
		});
	}
}

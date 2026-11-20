// Outbound guard: removals made on THIS device wait a moment before they reach
// the shared folder's CRDT, so a whole burst can be judged at once.
//
// Upstream sends every local removal immediately: a vault delete becomes
// `deleteFiles`, and an item moved out of the folder becomes the move-out
// branch of `renameFile`. When another tool (Obsidian Sync, iCloud, Syncthing,
// Finder) replays a folder rename as a stream of per-file deletes, that wipes
// the folder for every collaborator. This guard wraps those two methods on each
// folder instance and buffers removals that would propagate:
//
//   - small removals apply after ~2 s, exactly as upstream would;
//   - a mass removal (safetyPolicy) is held and the user is asked;
//   - if the shared folder itself vanished, nothing is sent and the folder is
//     suspended (FolderSafety.onRootMissing).
//
// Tree sync is held back while removals are pending, so the reconciler doesn't
// act on a half-applied state.

import { around } from "monkey-around";
import type { TAbstractFile } from "obsidian";
import type { SharedFolder } from "../SharedFolder";
import { decideRemoval, RemovalWindow, TIMING } from "./safetyPolicy";
import type { SafetyUI } from "./SafetyModal";
import { basename } from "./safetyPaths";
import { SyncType } from "../SyncTypes";

/** What the guard needs from the folder (the real SharedFolder, or a test fake). */
export type GuardedFolder = Pick<
	SharedFolder,
	| "path"
	| "guid"
	| "syncStore"
	| "checkPath"
	| "getVirtualPath"
	| "existsSync"
	| "deleteFiles"
	| "renameFile"
	| "syncFileTree"
	| "destroyed"
>;

export interface OutboundHost {
	enabled(): boolean;
	ui: SafetyUI;
	rootPresent(folder: GuardedFolder): boolean;
	/** The shared folder vanished: suspend it without sending anything. */
	onRootMissing(folder: GuardedFolder): void;
	/** Stop syncing the folder until reload / resume; nothing is sent. */
	pause(folder: GuardedFolder): void;
	log(...args: unknown[]): void;
}

interface Timers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const defaultTimers: Timers = {
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** The move-echo bookkeeping upstream keeps privately on each folder. */
type ServerOpsLike = { moveFrom?(path: string): unknown };

export class OutboundGuard {
	private readonly buffer = new Set<string>();
	private settleTimer: unknown = null;
	private maxTimer: unknown = null;
	private gate: { promise: Promise<void>; release: () => void } | null = null;
	private holding = false;
	readonly window: RemovalWindow;
	private applyDelete: (paths: string[]) => void = () => {};

	constructor(
		private readonly folder: GuardedFolder,
		private readonly host: OutboundHost,
		private readonly timers: Timers = defaultTimers,
		now: () => number = Date.now,
	) {
		this.window = new RemovalWindow(TIMING.windowMs, now);
	}

	/** Wrap the folder's methods; returns the uninstaller. */
	install(): () => void {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const guard = this;
		const uninstall = around(this.folder as unknown as Record<string, unknown>, {
			deleteFiles(next: unknown) {
				const original = next as (this: GuardedFolder, vpaths: Iterable<string>) => void;
				guard.applyDelete = (paths) => original.call(guard.folder, paths);
				return function (this: GuardedFolder, vpaths: Iterable<string>) {
					return guard.onDeleteFiles(this, original, vpaths);
				};
			},
			renameFile(next: unknown) {
				const original = next as (this: GuardedFolder, file: TAbstractFile, oldPath: string) => void;
				return function (this: GuardedFolder, file: TAbstractFile, oldPath: string) {
					return guard.onRenameFile(this, original, file, oldPath);
				};
			},
			syncFileTree(next: unknown) {
				const original = next as (this: GuardedFolder) => Promise<void>;
				return function (this: GuardedFolder) {
					return guard.onSyncFileTree(this, original);
				};
			},
		});
		return () => {
			uninstall();
			this.discard();
		};
	}

	get pending(): number {
		return this.buffer.size;
	}

	get isHolding(): boolean {
		return this.holding;
	}

	/** Drop pending removals without sending them (relocation, suspension). */
	discard(): void {
		this.clearTimers();
		this.buffer.clear();
		if (this.holding) this.host.ui.close(this.key);
		this.holding = false;
		this.releaseGate();
	}

	private get key(): string {
		return `outbound:${this.folder.guid}`;
	}

	private onDeleteFiles(
		self: GuardedFolder,
		next: (this: GuardedFolder, vpaths: Iterable<string>) => void,
		vpaths: Iterable<string>,
	): void {
		const paths = Array.from(new Set(vpaths));
		if (!this.host.enabled() || paths.length === 0) return next.call(self, paths);
		const now: string[] = [];
		const later: string[] = [];
		for (const vpath of paths) {
			(this.propagates(self, vpath) ? later : now).push(vpath);
		}
		if (now.length > 0) next.call(self, now);
		if (later.length > 0) this.enqueue(later);
	}

	private onRenameFile(
		self: GuardedFolder,
		next: (this: GuardedFolder, file: TAbstractFile, oldPath: string) => void,
		file: TAbstractFile,
		oldPath: string,
	): void {
		if (this.host.enabled() && self.checkPath(oldPath) && !self.checkPath(file.path)) {
			// Moving out of the shared folder = removing it for everyone.
			const oldVPath = self.getVirtualPath(oldPath);
			if (this.propagates(self, oldVPath)) {
				this.enqueue([oldVPath]);
				return;
			}
		}
		return next.call(self, file, oldPath);
	}

	private onSyncFileTree(
		self: GuardedFolder,
		next: (this: GuardedFolder) => Promise<void>,
	): Promise<void> {
		if (!this.host.enabled()) return next.call(self);
		if (!this.host.rootPresent(self)) {
			this.host.onRootMissing(self);
			return Promise.resolve();
		}
		if (this.gate) {
			return this.gate.promise.then(() =>
				self.destroyed ? undefined : next.call(self),
			);
		}
		return next.call(self);
	}

	/** Would removing this vpath change the shared membership? */
	private propagates(self: GuardedFolder, vpath: string): boolean {
		if (!self.syncStore.has(vpath)) return false;
		// Echo of a collaborator's move: upstream recognises these only while
		// its move record is fresh, so they must not be delayed.
		const ops = (self as unknown as { serverOps?: ServerOpsLike }).serverOps;
		if (ops?.moveFrom?.(vpath)) return false;
		return true;
	}

	private enqueue(vpaths: string[]): void {
		for (const vpath of vpaths) this.buffer.add(vpath);
		if (this.holding) return; // the open question covers new removals too
		this.ensureGate();
		if (this.settleTimer !== null) this.timers.clearTimeout(this.settleTimer);
		this.settleTimer = this.timers.setTimeout(() => this.flush(), TIMING.settleMs);
		if (this.maxTimer === null) {
			this.maxTimer = this.timers.setTimeout(() => this.flush(), TIMING.maxWaitMs);
		}
	}

	/** Decide what to do with the buffered removals. Public for tests. */
	flush(): void {
		this.clearTimers();
		const folder = this.folder;
		if (folder.destroyed) {
			this.buffer.clear();
			this.releaseGate();
			return;
		}
		// A file that came back (restored, re-created) is not removed.
		const paths = [...this.buffer].filter((vpath) => !folder.existsSync(vpath));
		this.buffer.clear();
		if (paths.length === 0) {
			this.releaseGate();
			return;
		}
		const files = paths.filter((vpath) => this.isFileEntry(vpath)).length;
		const recent = this.window.count();
		const decision = decideRemoval({
			removing: files,
			recentlyRemoved: recent,
			tracked: this.trackedFiles() + recent,
			rootPresent: this.host.rootPresent(folder),
		});
		if (decision.kind === "apply") {
			this.apply(paths, files);
			this.releaseGate();
		} else if (decision.kind === "root-missing") {
			this.releaseGate();
			this.host.onRootMissing(folder);
		} else {
			this.hold(paths, decision.reason);
		}
	}

	private hold(paths: string[], reason: string): void {
		this.holding = true;
		for (const vpath of paths) this.buffer.add(vpath);
		const name = basename(this.folder.path);
		this.host.log(`holding ${paths.length} removals from "${name}" (${reason})`);
		const resolve = (choice: "remove" | "restore" | "pause") => {
			const held = [...this.buffer];
			this.buffer.clear();
			this.holding = false;
			if (choice === "remove") {
				const missing = held.filter((vpath) => !this.folder.existsSync(vpath));
				this.window.reset();
				this.applyDelete(missing);
				this.host.log(`removed ${missing.length} paths from "${name}" for everyone`);
				this.releaseGate();
			} else if (choice === "restore") {
				// Releasing the gate lets tree sync re-create the missing files
				// from the shared copy; nothing was sent.
				this.releaseGate();
				void this.folder.syncFileTree();
			} else {
				this.releaseGate();
				this.host.pause(this.folder);
			}
		};
		this.host.ui.ask(this.key, {
			title: `Remove ${paths.length} items from “${name}” for everyone?`,
			message:
				`This would remove ${reason} from the shared folder “${name}” for every ` +
				`collaborator. Nothing has been sent yet. If you renamed or moved a folder, ` +
				`or another sync tool (Obsidian Sync, iCloud, Syncthing…) is moving files, ` +
				`choose “Restore them here”.`,
			paths,
			actions: [
				{ label: "Restore them here", cta: true, run: () => resolve("restore") },
				{ label: "Pause this folder", run: () => resolve("pause") },
				{ label: "Remove for everyone", warning: true, run: () => resolve("remove") },
			],
			onDismiss: () => resolve("pause"),
		});
	}

	private apply(paths: string[], files: number): void {
		this.applyDelete(paths);
		this.window.record(files);
	}

	private isFileEntry(vpath: string): boolean {
		const meta = this.folder.syncStore.getMeta(vpath);
		return !meta || meta.type !== SyncType.Folder;
	}

	private trackedFiles(): number {
		let n = 0;
		this.folder.syncStore.forEach((meta) => {
			if (meta.type !== SyncType.Folder) n++;
		});
		return n;
	}

	private ensureGate(): void {
		if (this.gate) return;
		let release: () => void = () => {};
		const promise = new Promise<void>((resolve) => (release = resolve));
		this.gate = { promise, release };
	}

	private releaseGate(): void {
		const gate = this.gate;
		this.gate = null;
		gate?.release();
	}

	private clearTimers(): void {
		if (this.settleTimer !== null) this.timers.clearTimeout(this.settleTimer);
		if (this.maxTimer !== null) this.timers.clearTimeout(this.maxTimer);
		this.settleTimer = null;
		this.maxTimer = null;
	}
}

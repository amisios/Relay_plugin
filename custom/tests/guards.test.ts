// Folder safety: outbound and inbound guards, and relocation on renames.

import { TFile, TFolder } from "obsidian";
import { Settings, type SettingsTree } from "../../src/SettingsStorage";
import { type GuardedFolder, OutboundGuard, type OutboundHost } from "../../src/local/outboundGuard";
import { InboundGuard, type InboundFolder, type InboundHost } from "../../src/local/inboundGuard";
import type { SafetyPrompt, SafetyUI } from "../../src/local/SafetyModal";
import { FolderSafety } from "../../src/local/safety";

type Meta = { type: string };

function fakeUI() {
	const asks: { key: string; prompt: SafetyPrompt }[] = [];
	const ui: SafetyUI = {
		ask: (key, prompt) => {
			if (!asks.some((a) => a.key === key)) asks.push({ key, prompt });
		},
		close: jest.fn(),
		notice: jest.fn(),
	};
	const choose = (label: RegExp) => {
		const ask = asks.shift();
		if (!ask) throw new Error("nothing was asked");
		const action = ask.prompt.actions.find((a) => label.test(a.label));
		if (!action) throw new Error(`no action ${label} in ${ask.prompt.actions.map((a) => a.label)}`);
		action.run();
	};
	return { ui, asks, choose };
}

// --- outbound ----------------------------------------------------------------

function outboundFixture(count: number, opts: { rootPresent?: boolean } = {}) {
	const files = Array.from({ length: count }, (_, i) => `/n${i}.md`);
	const store = new Map<string, Meta>(files.map((f) => [f, { type: "markdown" }]));
	const onDisk = new Set(files);
	const deleted: string[][] = [];
	const renamed: [string, string][] = [];
	let syncs = 0;
	const folder = {
		path: "P/SF",
		guid: "g1",
		destroyed: false,
		syncStore: {
			has: (v: string) => store.has(v),
			getMeta: (v: string) => store.get(v),
			forEach: (cb: (m: Meta, p: string) => void) => store.forEach((m, p) => cb(m, p)),
		},
		checkPath: (p: string) => p.startsWith("P/SF/"),
		getVirtualPath: (p: string) => p.slice("P/SF".length),
		existsSync: (v: string) => onDisk.has(v),
		deleteFiles(vpaths: Iterable<string>) {
			const list = [...vpaths];
			deleted.push(list);
			list.forEach((v) => store.delete(v));
		},
		renameFile(file: { path: string }, oldPath: string) {
			renamed.push([file.path, oldPath]);
		},
		syncFileTree() {
			syncs++;
			return Promise.resolve();
		},
	};
	const { ui, asks, choose } = fakeUI();
	const host: OutboundHost = {
		enabled: () => true,
		ui,
		rootPresent: jest.fn(() => opts.rootPresent ?? true),
		onRootMissing: jest.fn(),
		pause: jest.fn(),
		log: () => {},
	};
	const guard = new OutboundGuard(folder as unknown as GuardedFolder, host);
	guard.install();
	const removeFromDisk = (n: number) => files.slice(0, n).forEach((f) => onDisk.delete(f));
	return { folder, guard, host, asks, choose, deleted, renamed, onDisk, files, removeFromDisk, syncs: () => syncs };
}

describe("outbound guard", () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	test("a single delete is sent after the settle time", () => {
		const t = outboundFixture(20);
		t.removeFromDisk(1);
		t.folder.deleteFiles(["/n0.md"]);
		expect(t.deleted).toEqual([]);
		jest.advanceTimersByTime(2000);
		expect(t.deleted).toEqual([["/n0.md"]]);
		expect(t.asks).toHaveLength(0);
	});

	test("deletes that change nothing shared pass straight through", () => {
		const t = outboundFixture(20);
		t.folder.deleteFiles(["/not-shared.md"]);
		expect(t.deleted).toEqual([["/not-shared.md"]]);
	});

	test("a burst of 20 deletes is held and asked about once", () => {
		const t = outboundFixture(40);
		t.removeFromDisk(20);
		for (let i = 0; i < 20; i += 5) {
			t.folder.deleteFiles(t.files.slice(i, i + 5));
			jest.advanceTimersByTime(300);
		}
		jest.advanceTimersByTime(2000);
		expect(t.deleted).toEqual([]);
		expect(t.asks).toHaveLength(1);
		expect(t.asks[0].prompt.paths).toHaveLength(20);
		t.choose(/Remove for everyone/);
		expect(t.deleted).toEqual([t.files.slice(0, 20)]);
	});

	test("Pause sends nothing", () => {
		const t = outboundFixture(12);
		t.removeFromDisk(12);
		t.folder.deleteFiles(t.files);
		jest.advanceTimersByTime(2000);
		t.choose(/Pause/);
		expect(t.host.pause).toHaveBeenCalledTimes(1);
		expect(t.deleted).toEqual([]);
	});

	test("Restore sends nothing and lets tree sync bring the files back", async () => {
		const t = outboundFixture(12);
		t.removeFromDisk(12);
		t.folder.deleteFiles(t.files);
		jest.advanceTimersByTime(2000);
		t.choose(/Restore/);
		await Promise.resolve();
		expect(t.deleted).toEqual([]);
		expect(t.syncs()).toBeGreaterThan(0);
	});

	test("dismissing the question pauses (nothing is sent)", () => {
		const t = outboundFixture(12);
		t.removeFromDisk(12);
		t.folder.deleteFiles(t.files);
		jest.advanceTimersByTime(2000);
		t.asks[0].prompt.onDismiss?.();
		expect(t.host.pause).toHaveBeenCalledTimes(1);
		expect(t.deleted).toEqual([]);
	});

	test("a vanished shared folder is never sent as removals", () => {
		const t = outboundFixture(30, { rootPresent: false });
		t.removeFromDisk(30);
		t.folder.deleteFiles(t.files);
		jest.advanceTimersByTime(2000);
		expect(t.host.onRootMissing).toHaveBeenCalledTimes(1);
		expect(t.deleted).toEqual([]);
		expect(t.asks).toHaveLength(0);
	});

	test("a file that came back is not removed", () => {
		const t = outboundFixture(20);
		t.removeFromDisk(1); // n0 gone, n1 still on disk
		t.folder.deleteFiles(["/n0.md", "/n1.md"]);
		jest.advanceTimersByTime(2000);
		expect(t.deleted).toEqual([["/n0.md"]]);
	});

	test("moving an item out of the folder is held back like a delete", () => {
		const t = outboundFixture(20);
		t.removeFromDisk(1);
		t.folder.renameFile({ path: "Elsewhere/n0.md" }, "P/SF/n0.md");
		expect(t.renamed).toEqual([]);
		jest.advanceTimersByTime(2000);
		expect(t.deleted).toEqual([["/n0.md"]]);
	});

	test("renames inside the folder pass straight through", () => {
		const t = outboundFixture(20);
		t.folder.renameFile({ path: "P/SF/sub/n0.md" }, "P/SF/n0.md");
		expect(t.renamed).toEqual([["P/SF/sub/n0.md", "P/SF/n0.md"]]);
	});

	test("tree sync waits until pending removals are decided", async () => {
		const t = outboundFixture(20);
		t.removeFromDisk(1);
		t.folder.deleteFiles(["/n0.md"]);
		const sync = t.folder.syncFileTree();
		expect(t.syncs()).toBe(0);
		jest.advanceTimersByTime(2000);
		await sync;
		expect(t.syncs()).toBe(1);
	});

	test("echoes of a collaborator's move are not delayed", () => {
		const t = outboundFixture(20);
		(t.folder as unknown as { serverOps: unknown }).serverOps = {
			moveFrom: (v: string) => (v === "/n0.md" ? { to: "/x.md" } : undefined),
		};
		t.folder.deleteFiles(["/n0.md"]);
		expect(t.deleted).toEqual([["/n0.md"]]);
	});

	test("discard drops pending removals without sending them", () => {
		const t = outboundFixture(20);
		t.removeFromDisk(1);
		t.folder.deleteFiles(["/n0.md"]);
		t.guard.discard();
		jest.advanceTimersByTime(5000);
		expect(t.deleted).toEqual([]);
	});
});

// --- inbound -----------------------------------------------------------------

class MemAdapter {
	files = new Set<string>();
	dirs = new Set<string>();
	content = new Map<string, string>();
	renames: [string, string][] = [];
	trashed: string[] = [];
	async exists(p: string) {
		return this.files.has(p) || this.dirs.has(p);
	}
	async mkdir(p: string) {
		this.dirs.add(p);
	}
	async rename(a: string, b: string) {
		this.files.delete(a);
		this.files.add(b);
		this.renames.push([a, b]);
	}
	async copy(a: string, b: string) {
		this.files.add(b);
	}
	async remove(a: string) {
		this.files.delete(a);
	}
	async trashLocal(p: string) {
		this.trashed.push(p);
		this.files.delete(p);
	}
	async list(p: string) {
		const inside = (x: string) => x.slice(0, x.lastIndexOf("/")) === p;
		return { files: [...this.files].filter(inside), folders: [...this.dirs].filter(inside) };
	}
	async rmdir(p: string) {
		this.dirs.delete(p);
	}
	async read(p: string) {
		return this.content.get(p) ?? "";
	}
	async write(p: string, d: string) {
		this.content.set(p, d);
		this.files.add(p);
	}
}

function inboundFixture(count: number) {
	const adapter = new MemAdapter();
	const paths = Array.from({ length: count }, (_, i) => `P/SF/sub/n${i}.md`);
	paths.forEach((p) => adapter.files.add(p));
	const tfiles = paths.map((p) => new TFile(p));
	const folder = {
		path: "P/SF",
		guid: "g1",
		vault: { adapter },
		checkPath: (p: string) => p.startsWith("P/SF/"),
		getVirtualPath: (p: string) => p.slice("P/SF".length),
		isSyncableTFile: () => true,
		syncFileTree: jest.fn(() => Promise.resolve()),
		_provider: { synced: true },
		_persistence: { synced: true },
		pendingUpload: new Set<string>(),
		pendingCreates: new Map<string, number>(),
	};
	const holds = new Map<string, Set<string>>();
	const { ui, asks, choose } = fakeUI();
	const host: InboundHost = {
		enabled: () => true,
		ui,
		heldPaths: (guid) => holds.get(guid) ?? new Set(),
		setHold: (f, held) => {
			if (held.length) holds.set(f.guid, new Set(held));
			else holds.delete(f.guid);
		},
		republish: jest.fn(),
		log: () => {},
	};
	const guard = new InboundGuard(folder as unknown as InboundFolder, host);
	const vpaths = paths.map((p) => p.slice("P/SF".length));
	const remoteWithout = (removed: string[]) => new Set(vpaths.filter((v) => !removed.includes(v)));
	return { adapter, folder, tfiles, vpaths, holds, host, guard, asks, choose, remoteWithout };
}

describe("inbound guard", () => {
	test("a few remote removals go to a backup that keeps the folder structure", async () => {
		const t = inboundFixture(20);
		const removal = t.guard.begin(t.tfiles, t.remoteWithout(["/sub/n0.md"]));
		expect(removal.held).toBe(false);
		await removal.trash(t.tfiles[0]);
		expect(t.adapter.renames).toHaveLength(1);
		expect(t.adapter.renames[0][0]).toBe("P/SF/sub/n0.md");
		expect(t.adapter.renames[0][1]).toMatch(/^\.trash\/relay\/SF\/\d{4}-\d{2}-\d{2}-\d{4}\/sub\/n0\.md$/);
		expect(t.adapter.trashed).toEqual([]);
	});

	test("a mass remote removal is held: files stay, and the hold survives a reload", () => {
		const t = inboundFixture(20);
		const removal = t.guard.begin(t.tfiles, t.remoteWithout(t.vpaths));
		expect(removal.held).toBe(true);
		expect(t.holds.get("g1")?.size).toBe(20);
		expect(t.asks).toHaveLength(1);
		expect(t.guard.isHeld("/sub/n3.md")).toBe(true);
		expect(t.adapter.renames).toEqual([]);

		const afterReload = new InboundGuard(t.folder as unknown as InboundFolder, t.host);
		expect(afterReload.isHeld("/sub/n3.md")).toBe(true);
		expect(afterReload.begin(t.tfiles, t.remoteWithout(t.vpaths)).held).toBe(true);
	});

	test("held files that were re-added remotely are released", () => {
		const t = inboundFixture(20);
		t.guard.begin(t.tfiles, t.remoteWithout(t.vpaths));
		const removal = t.guard.begin(t.tfiles, new Set(t.vpaths));
		expect(removal.held).toBe(false);
		expect(t.holds.has("g1")).toBe(false);
	});

	test("Apply moves the held files to the backup on the next pass", () => {
		const t = inboundFixture(20);
		t.guard.begin(t.tfiles, t.remoteWithout(t.vpaths));
		t.choose(/Apply/);
		expect(t.holds.has("g1")).toBe(false);
		expect(t.folder.syncFileTree).toHaveBeenCalled();
		expect(t.guard.begin(t.tfiles, t.remoteWithout(t.vpaths)).held).toBe(false);
	});

	test("Keep my copies shares them again", () => {
		const t = inboundFixture(20);
		t.guard.begin(t.tfiles, t.remoteWithout(t.vpaths));
		t.choose(/Keep my copies/);
		expect(t.holds.has("g1")).toBe(false);
		expect(t.host.republish).toHaveBeenCalledTimes(1);
	});

	test("nothing is decided while the folder is not synced", () => {
		const t = inboundFixture(20);
		t.folder._provider.synced = false;
		const removal = t.guard.begin(t.tfiles, t.remoteWithout(t.vpaths));
		expect(removal.held).toBe(false);
		expect(t.holds.has("g1")).toBe(false);
	});

	test("files waiting to upload are not removals", () => {
		const t = inboundFixture(20);
		t.vpaths.slice(0, 15).forEach((v) => t.folder.pendingUpload.add(v));
		const removal = t.guard.begin(t.tfiles, t.remoteWithout(t.vpaths));
		// 5 of 20 (25%) remain candidates: still a mass removal
		expect(removal.held).toBe(true);
		expect(t.holds.get("g1")?.size).toBe(5);
	});
});

// --- relocation ----------------------------------------------------------------

class MemoryStorage {
	constructor(public data: Record<string, unknown>) {}
	async loadData() {
		return structuredClone(this.data);
	}
	async saveData(data: Record<string, unknown>) {
		this.data = structuredClone(data);
	}
}

async function relocationFixture(existing: string[]) {
	const entries = new Map<string, TFile | TFolder>();
	for (const p of existing) entries.set(p, p.endsWith(".md") ? new TFile(p) : new TFolder(p));
	const vault = {
		getAbstractFileByPath: (p: string) => entries.get(p) ?? null,
		getAllLoadedFiles: () => [...entries.values()],
		trash: jest.fn(),
		delete: jest.fn(),
	};
	const shared = {
		path: "1. PROJECTS/SF",
		guid: "g1",
		syncStore: {
			forEach: (cb: (m: Meta, p: string) => void) => {
				cb({ type: "markdown" }, "/a.md");
				cb({ type: "markdown" }, "/b.md");
			},
		},
		move: jest.fn(function (this: { path: string }, to: string) {
			this.path = to;
		}),
	};
	const sharedFolders = { items: () => [shared], update: jest.fn(), suspend: jest.fn() };
	const plugin = {
		app: { vault, workspace: { onLayoutReady: () => {} } },
		register: () => {},
		addCommand: () => {},
		sharedFolders,
	};
	const settings = new Settings<Record<string, unknown>>(new MemoryStorage({ sharedFolders: [] }), {
		sharedFolders: [],
	});
	await settings.load();
	const safety = FolderSafety.init(plugin as never, settings as unknown as SettingsTree);
	return { safety, shared, sharedFolders };
}

describe("relocation", () => {
	test("renaming the parent moves the share along (parent event first)", async () => {
		const t = await relocationFixture(["01_PROJECTS", "01_PROJECTS/SF", "01_PROJECTS/SF/a.md"]);
		t.safety.beforeVaultRename(new TFolder("01_PROJECTS"), "1. PROJECTS");
		expect(t.shared.move).toHaveBeenCalledWith("01_PROJECTS/SF");
		expect(t.sharedFolders.update).toHaveBeenCalled();
		// The folder's own event and its children's follow; nothing more to do.
		t.safety.beforeVaultRename(new TFolder("01_PROJECTS/SF"), "1. PROJECTS/SF");
		t.safety.beforeVaultRename(new TFile("01_PROJECTS/SF/a.md"), "1. PROJECTS/SF/a.md");
		expect(t.shared.move).toHaveBeenCalledTimes(1);
	});

	test("children arriving first are caught by the backstop", async () => {
		const t = await relocationFixture(["01_PROJECTS", "01_PROJECTS/SF", "01_PROJECTS/SF/a.md", "01_PROJECTS/SF/b.md"]);
		t.safety.beforeVaultRename(new TFile("01_PROJECTS/SF/a.md"), "1. PROJECTS/SF/a.md");
		expect(t.shared.move).toHaveBeenCalledWith("01_PROJECTS/SF");
		t.safety.beforeVaultRename(new TFolder("01_PROJECTS"), "1. PROJECTS");
		t.safety.beforeVaultRename(new TFile("01_PROJECTS/SF/b.md"), "1. PROJECTS/SF/b.md");
		expect(t.shared.move).toHaveBeenCalledTimes(1);
	});

	test("an item moved out while the shared folder still exists is not a relocation", async () => {
		const t = await relocationFixture(["1. PROJECTS/SF", "Elsewhere", "Elsewhere/a.md"]);
		t.safety.beforeVaultRename(new TFile("Elsewhere/a.md"), "1. PROJECTS/SF/a.md");
		expect(t.shared.move).not.toHaveBeenCalled();
	});

	test("renaming an unrelated folder changes nothing", async () => {
		const t = await relocationFixture(["Other2"]);
		t.safety.beforeVaultRename(new TFolder("Other2"), "Other");
		expect(t.shared.move).not.toHaveBeenCalled();
	});
});

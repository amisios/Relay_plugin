import { Notice } from "obsidian";
import { Settings, type SettingsTree } from "../../src/SettingsStorage";
import { ObservablePermission } from "../../src/PolicyManager";
import type { EndpointManager } from "../../src/EndpointManager";
import type { RelayManager } from "../../src/RelayManager";
import type { Permission } from "../../src/Relay";
import { CustomRelay, type SelfHostSettings } from "../../src/local/custom";
import { makeIdentityToken } from "../../src/local/FakePocketBase";
import { SyncSettingsManager } from "../../src/SyncSettings";

type Data = Record<string, unknown>;

class MemoryStorage {
	constructor(public data: Data) {}
	async loadData() {
		return structuredClone(this.data);
	}
	async saveData(data: Data) {
		this.data = structuredClone(data);
	}
}

function fakePlugin(enabledPlugins: string[] = []) {
	return {
		app: { plugins: { enabledPlugins: new Set(enabledPlugins) } },
		manifest: { id: "relay-custom" },
		register: () => {},
	} as never;
}

async function init(data: Data, enabledPlugins: string[] = []) {
	const storage = new MemoryStorage(data);
	const settings = new Settings<Data>(storage, { sharedFolders: [] });
	await settings.load();
	const custom = await CustomRelay.init(
		fakePlugin(enabledPlugins),
		settings as unknown as SettingsTree,
	);
	const saved = storage.data as { sharedFolders: unknown[]; selfHost: SelfHostSettings };
	return { custom, saved };
}

function valueOf(permission: ObservablePermission): boolean {
	let value = false;
	permission.subscribe((v) => (value = v))();
	return value;
}

const A = { guid: "a", path: "Custom notes", relay: "r-custom" };
const B = { guid: "b", path: "Team notes", relay: "r-official" };

describe("CustomRelay.init", () => {
	beforeEach(() => {
		Notice.shown = [];
	});

	test("an existing custom install keeps its folders and gets a stable user id", async () => {
		const { custom, saved } = await init({
			sharedFolders: [A],
			selfHost: { controlPlaneUrl: "http://cp:8094/" },
		});
		expect(custom.mode).toBe("custom");
		expect(saved.sharedFolders).toEqual([A]);
		expect(saved.selfHost.foldersMode).toBe("custom");
		expect(saved.selfHost.userId).toMatch(/^[0-9a-f-]{36}$/);
		expect(custom.selfHost).toMatchObject({
			controlPlaneUrl: "http://cp:8094",
			displayName: "Anonymous",
			userId: saved.selfHost.userId,
		});
	});

	test("switching to official parks the custom folders", async () => {
		const { custom, saved } = await init({
			sharedFolders: [A],
			selfHost: { mode: "official", foldersMode: "custom", userId: "u1" },
		});
		expect(custom.mode).toBe("official");
		expect(custom.selfHost).toBeUndefined();
		expect(saved.sharedFolders).toEqual([]);
		expect(saved.selfHost.inactiveFolders).toEqual({ custom: [A] });
		expect(saved.selfHost.foldersMode).toBe("official");
	});

	test("switching back restores each mode's own folders", async () => {
		const { saved } = await init({
			sharedFolders: [B],
			selfHost: {
				mode: "custom",
				foldersMode: "official",
				inactiveFolders: { custom: [A] },
				userId: "u1",
			},
		});
		expect(saved.sharedFolders).toEqual([A]);
		expect(saved.selfHost.inactiveFolders).toEqual({ official: [B] });
		expect(saved.selfHost.userId).toBe("u1");
	});

	test("official mode warns when the official plugin is enabled too", async () => {
		await init({ selfHost: { mode: "official" } }, ["system3-relay"]);
		expect(Notice.shown).toHaveLength(1);
		await init({ selfHost: { mode: "custom" } }, ["system3-relay"]);
		expect(Notice.shown).toHaveLength(1);
	});
});

describe("endpoints", () => {
	test("unconfigured custom mode never falls back to System 3", async () => {
		const { custom } = await init({});
		const setCustomEndpoints = jest.fn();
		const handled = custom.configureEndpoints({ setCustomEndpoints } as unknown as EndpointManager);
		expect(handled).toBe(true);
		expect(setCustomEndpoints).toHaveBeenCalledWith(
			"http://control-plane.invalid",
			"http://control-plane.invalid",
		);
		expect(custom.healthUrl("https://api.system3.md/health")).toBe(
			"http://control-plane.invalid/health?version=jest-test-version",
		);
	});

	test("official mode keeps upstream's endpoints", async () => {
		const { custom } = await init({ selfHost: { mode: "official" } });
		const setCustomEndpoints = jest.fn();
		expect(custom.configureEndpoints({ setCustomEndpoints } as unknown as EndpointManager)).toBe(false);
		expect(setCustomEndpoints).not.toHaveBeenCalled();
		expect(custom.healthUrl("https://api.system3.md/health")).toBe("https://api.system3.md/health");
	});
});

describe("restrictPermissions", () => {
	const allow = () => new ObservablePermission(() => true, []);
	const check = (relayManager: { can: RelayManager["can"] }, permission: Permission) =>
		valueOf(relayManager.can("u1", permission, { id: "r" } as never));

	test("custom mode denies server administration but not content", async () => {
		const { custom } = await init({});
		const relayManager = { can: jest.fn(allow) };
		custom.restrictPermissions(relayManager as unknown as RelayManager);
		expect(check(relayManager, ["relay", "rename"])).toBe(false);
		expect(check(relayManager, ["relay", "manage_sharing"])).toBe(false);
		expect(check(relayManager, ["folder", "manage_users"])).toBe(false);
		expect(check(relayManager, ["subscription", "manage"])).toBe(false);
		expect(check(relayManager, ["folder", "edit_content"])).toBe(true);
		expect(check(relayManager, ["folder", "upload"])).toBe(true);
	});

	test("official mode leaves permissions alone", async () => {
		const { custom } = await init({ selfHost: { mode: "official" } });
		const relayManager = { can: jest.fn(allow) };
		custom.restrictPermissions(relayManager as unknown as RelayManager);
		expect(check(relayManager, ["relay", "rename"])).toBe(true);
	});
});

describe("identity key", () => {
	test("custom mode creates a per-user key once and keeps it", async () => {
		const first = await init({ selfHost: { controlPlaneUrl: "http://cp:8094" } });
		const key = first.saved.selfHost.userKey as string;
		expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(first.custom.selfHost?.userKey).toBe(key);

		const again = await init(first.saved as unknown as Data);
		expect(again.saved.selfHost.userKey).toBe(key);
		expect(again.saved.selfHost.userId).toBe(first.saved.selfHost.userId);
	});

	test("an upgrade from 0.3.0 keeps the user id and adds a key", async () => {
		const { saved } = await init({
			sharedFolders: [A],
			selfHost: { controlPlaneUrl: "http://cp:8094", userId: "legacy-id", displayName: "Ann" },
		});
		expect(saved.selfHost.userId).toBe("legacy-id");
		expect(saved.selfHost.userKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	test("official mode creates no key", async () => {
		const { saved } = await init({ selfHost: { mode: "official" } });
		expect(saved.selfHost.userKey).toBeUndefined();
	});

	test("the identity token carries the key for the control-plane", () => {
		const token = makeIdentityToken({ id: "u1", name: "Ann", key: "k".repeat(43) });
		const [, payload, signature] = token.split(".");
		expect(signature).toBe("");
		const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		expect(json).toMatchObject({ id: "u1", name: "Ann", key: "k".repeat(43) });
		const legacy = makeIdentityToken({ id: "u1", name: "Ann" });
		expect(JSON.parse(Buffer.from(legacy.split(".")[1], "base64url").toString("utf8")).key).toBeUndefined();
	});
});

describe("every file type is shared by default (custom mode)", () => {
	const syncOff = { images: true, pdfs: true, otherTypes: false };
	const folder = (sync?: Record<string, boolean>) => ({ ...A, ...(sync ? { sync } : {}) });

	test("existing folders get 'Other files' turned on once", async () => {
		const { saved } = await init({ sharedFolders: [folder(syncOff), folder()] });
		const [withSync, withoutSync] = saved.sharedFolders as { sync?: Record<string, boolean> }[];
		expect(withSync.sync).toEqual({ images: true, pdfs: true, otherTypes: true });
		expect(withoutSync.sync).toBeUndefined();
		expect(saved.selfHost.allTypesDefaultApplied).toBe(true);
		expect(SyncSettingsManager.defaultFlags.otherTypes).toBe(true);
	});

	test("a later choice to turn it off is respected", async () => {
		const { saved } = await init({
			sharedFolders: [folder(syncOff)],
			selfHost: { userId: "u1", allTypesDefaultApplied: true },
		});
		expect((saved.sharedFolders[0] as { sync: Record<string, boolean> }).sync.otherTypes).toBe(false);
	});

	test("official mode keeps upstream's defaults", async () => {
		const { saved } = await init({
			sharedFolders: [folder(syncOff)],
			selfHost: { mode: "official", foldersMode: "official" },
		});
		expect((saved.sharedFolders[0] as { sync: Record<string, boolean> }).sync.otherTypes).toBe(false);
		expect(SyncSettingsManager.defaultFlags.otherTypes).toBe(false);
		expect(saved.selfHost.allTypesDefaultApplied).toBeUndefined();
	});
});

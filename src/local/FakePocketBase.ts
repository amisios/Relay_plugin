// Self-hosted mode: a minimal stand-in for the PocketBase client.
//
// The plugin talks to its backend exclusively through `LoginManager.pb`. In
// self-hosted mode we swap the real PocketBase for this adapter, which serves
// relay/folder/role records from the control-plane's GET /registry endpoint and
// presents a self-declared identity. Realtime and write operations are no-ops /
// unsupported (the control-plane pre-seeds everything; a trusted group doesn't
// create/kick/invite from the client).
//
// It is cast to `PocketBase` at the assignment site; only the subset of the
// PocketBase client API the plugin actually calls is implemented here.

import { customFetch } from "../customFetch";
import { curryLog } from "../debug";

export interface SelfHostConfig {
	controlPlaneUrl: string;
	displayName: string;
	icon?: string;
	/** Stable, self-declared user id (generated once, persisted). */
	userId: string;
}

/** Persisted (all-optional) shape of the self-host settings in data.json. */
export interface SelfHostSettings {
	controlPlaneUrl?: string;
	displayName?: string;
	icon?: string;
	userId?: string;
}

interface Identity {
	id: string;
	name: string;
	email?: string;
}

interface FakeRecord {
	id: string;
	collectionName: string;
	[key: string]: unknown;
}

function base64UrlEncode(input: string): string {
	let b64: string;
	if (typeof window !== "undefined" && window.btoa) {
		b64 = window.btoa(input);
	} else {
		b64 = Buffer.from(input).toString("base64");
	}
	return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build the identity token the plugin sends as a Bearer to the control-plane.
 * Shaped like a JWT (`header.payload.`) so LoginManager's JWT-decoding refresh
 * path and the control-plane both read the payload the same way. Unsigned — the
 * control-plane trusts it (trusted VPN group); it is never verified.
 */
export function makeIdentityToken(user: Identity): string {
	const header = base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
	const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 3650; // ~10y
	const payload = base64UrlEncode(
		JSON.stringify({
			id: user.id,
			name: user.name,
			email: user.email ?? "",
			exp,
		}),
	);
	return `${header}.${payload}.`;
}

class FakeAuthStore {
	token: string;
	model: Record<string, unknown> | null;

	constructor(token: string, model: Record<string, unknown>) {
		this.token = token;
		this.model = model;
	}

	get isValid(): boolean {
		return true;
	}

	clear(): void {
		// No-op: self-declared identity is not cleared on transient errors.
	}

	save(): void {
		/* no-op */
	}

	onChange(): () => void {
		return () => {};
	}
}

class FakeCollection {
	constructor(
		private fpb: FakePocketBase,
		private name: string,
	) {}

	// getFullList returns ALL registry records regardless of collection; the
	// store routes each record by its own `collectionName`, and update() ingests
	// them all. This avoids any dependency on PocketBase's nested `expand`.
	async getFullList(_options?: unknown): Promise<FakeRecord[]> {
		return this.fpb.records();
	}

	async getList(
		_page = 1,
		_perPage = 200,
		_options?: unknown,
	): Promise<{
		page: number;
		perPage: number;
		totalItems: number;
		totalPages: number;
		items: FakeRecord[];
	}> {
		const items = (await this.fpb.records()).filter(
			(r) => r.collectionName === this.name,
		);
		return {
			page: 1,
			perPage: items.length,
			totalItems: items.length,
			totalPages: 1,
			items,
		};
	}

	async getOne(id: string, _options?: unknown): Promise<FakeRecord> {
		const rec = (await this.fpb.records()).find(
			(r) => r.collectionName === this.name && r.id === id,
		);
		if (!rec) {
			throw Object.assign(new Error(`Record ${this.name}/${id} not found`), {
				status: 404,
			});
		}
		return rec;
	}

	// Realtime is disabled in self-hosted mode (static registry).
	async subscribe(
		_topic: string,
		_callback: unknown,
		_options?: unknown,
	): Promise<() => void> {
		return () => {};
	}

	async unsubscribe(_topic?: string): Promise<void> {
		/* no-op */
	}

	// Writes: device/vault registration is accepted as a harmless no-op (returns a
	// benign record); everything else (create relay/invite/kick) is unsupported —
	// the control-plane owns the registry, and failing loudly avoids phantom rows.
	async create(data?: Record<string, unknown>): Promise<FakeRecord> {
		if (this.name === "devices" || this.name === "vaults" || this.name === "oauth2_response") {
			return {
				id: (data?.id as string) || `local_${Date.now()}`,
				collectionName: this.name,
				...(data ?? {}),
			};
		}
		throw new Error(`create ${this.name} is not supported in self-hosted mode`);
	}
	async update(id: string, data?: Record<string, unknown>): Promise<FakeRecord> {
		if (this.name === "devices" || this.name === "vaults") {
			return { id, collectionName: this.name, ...(data ?? {}) };
		}
		throw new Error(`update ${this.name} is not supported in self-hosted mode`);
	}
	async delete(_id: string): Promise<boolean> {
		return true; // no-op
	}

	// Auth is self-declared; these keep the login flow happy without OAuth.
	async authRefresh(): Promise<{
		token: string;
		record: Record<string, unknown>;
	}> {
		return {
			token: this.fpb.authStore.token,
			record: (this.fpb.authStore.model ?? {}) as Record<string, unknown>,
		};
	}
	async authWithOAuth2(): Promise<never> {
		throw new Error("OAuth is not used in self-hosted mode");
	}
	async authWithOAuth2Code(): Promise<never> {
		throw new Error("OAuth is not used in self-hosted mode");
	}
	async listAuthMethods(): Promise<{ authProviders: unknown[] }> {
		return { authProviders: [] };
	}
}

export class FakePocketBase {
	authStore: FakeAuthStore;
	realtime = { unsubscribe: async (): Promise<void> => {} };
	files = {
		getUrl: (_record: unknown, _filename: string, _options?: unknown): string =>
			"",
	};
	beforeSend?: unknown;

	private log = curryLog("[FakePocketBase]", "debug");
	private token: string;
	private _cache?: FakeRecord[];
	private _cacheAt = 0;

	constructor(
		public baseUrl: string,
		identity: Identity,
	) {
		this.token = makeIdentityToken(identity);
		this.authStore = new FakeAuthStore(this.token, {
			id: identity.id,
			name: identity.name,
			email: identity.email ?? "",
			collectionName: "users",
		});
	}

	get identityToken(): string {
		return this.token;
	}

	collection(name: string): FakeCollection {
		return new FakeCollection(this, name);
	}

	buildUrl(path: string): string {
		return this.baseUrl.replace(/\/+$/, "") + path;
	}

	cancelAllRequests(): void {
		/* no-op */
	}

	async send(path: string, _options?: unknown): Promise<never> {
		throw new Error(`send(${path}) is not supported in self-hosted mode`);
	}

	/** Fetch (and briefly cache) the control-plane registry records. */
	async records(): Promise<FakeRecord[]> {
		const now = Date.now();
		if (this._cache && now - this._cacheAt < 5000) {
			return this._cache;
		}
		const url = this.buildUrl("/registry");
		const response = await customFetch(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${this.token}` },
			relayNetworkDomain: "auth",
		});
		if (!response.ok) {
			throw new Error(`registry fetch failed: ${response.status}`);
		}
		const data = (await response.json()) as { records?: FakeRecord[] };
		this._cache = Array.isArray(data.records) ? data.records : [];
		this._cacheAt = now;
		this.log(`fetched ${this._cache.length} registry records`);
		return this._cache;
	}

	/** Force the next records() call to re-fetch. */
	invalidate(): void {
		this._cacheAt = 0;
	}
}

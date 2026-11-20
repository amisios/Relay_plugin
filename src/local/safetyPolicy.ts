// When is a removal "mass" and needs a person to confirm it? Pure — no
// Obsidian imports — so the decisions are unit-tested directly.
//
// The same policy guards both directions:
//   outbound — files removed on THIS device, before the removal is sent;
//   inbound  — removals a collaborator sent, before files are taken off disk.

/** A removal needs confirmation at 10 files, or at 25% of a folder (≥5 files). */
export interface Thresholds {
	/** Files removed (in this batch plus the recent window) that always need a look. */
	absolute: number;
	/** Share of the folder's files that needs a look… */
	fraction: number;
	/** …once the folder has at least this many files. */
	fractionMin: number;
	/** Emptying a folder of at least this many files always needs a look. */
	emptiedMin: number;
}

export const THRESHOLDS: Thresholds = {
	absolute: 10,
	fraction: 0.25,
	fractionMin: 5,
	emptiedMin: 2,
};

export const TIMING = {
	/** Outbound removals wait this long for the rest of a burst. */
	settleMs: 2000,
	/** …but never longer than this in a continuous stream. */
	maxWaitMs: 10_000,
	/** Removals are added up over this window, so slow streams still trip. */
	windowMs: 10 * 60_000,
	/** An in-app delete of a shared folder is remembered this long. */
	inAppDeleteMs: 30_000,
} as const;

export interface RemovalSignals {
	/** Files this batch would remove (folders don't count). */
	removing: number;
	/** Files already removed in the recent window. */
	recentlyRemoved: number;
	/** Files the folder had before any of these removals. */
	tracked: number;
	/** Is the shared folder itself still in the vault? */
	rootPresent: boolean;
}

export type RemovalDecision =
	| { kind: "apply" }
	| { kind: "hold"; reason: string }
	| { kind: "root-missing" };

export function decideRemoval(s: RemovalSignals, t: Thresholds = THRESHOLDS): RemovalDecision {
	if (!s.rootPresent) return { kind: "root-missing" };
	if (s.removing <= 0) return { kind: "apply" };
	const total = s.removing + s.recentlyRemoved;
	const tracked = Math.max(s.tracked, total);
	if (total >= t.absolute) {
		return { kind: "hold", reason: `${total} files` };
	}
	if (tracked >= t.fractionMin && total / tracked >= t.fraction) {
		return {
			kind: "hold",
			reason: `${total} of ${tracked} files (${Math.round((100 * total) / tracked)}%)`,
		};
	}
	if (tracked >= t.emptiedMin && total >= tracked) {
		return { kind: "hold", reason: "every file" };
	}
	return { kind: "apply" };
}

/** Adds up removals over a sliding time window. */
export class RemovalWindow {
	private events: { at: number; n: number }[] = [];

	constructor(
		private readonly windowMs: number = TIMING.windowMs,
		private readonly now: () => number = Date.now,
	) {}

	record(n: number): void {
		if (n > 0) this.events.push({ at: this.now(), n });
	}

	count(): number {
		const since = this.now() - this.windowMs;
		this.events = this.events.filter((e) => e.at >= since);
		return this.events.reduce((sum, e) => sum + e.n, 0);
	}

	reset(): void {
		this.events = [];
	}
}

// Folder safety: path math and the mass-removal policy (pure modules).

import {
	backupPathFor,
	formatStamp,
	inferMovedRoot,
	isUnder,
	nextFreeName,
	overlapsAny,
	planAncestorRelocations,
	rankCandidates,
	relocatePath,
	sanitizeSegment,
	scoreCandidate,
} from "../../src/local/safetyPaths";
import { decideRemoval, RemovalWindow } from "../../src/local/safetyPolicy";

describe("safetyPaths", () => {
	test("isUnder respects folder boundaries", () => {
		expect(isUnder("1. PROJECTS/SF", "1. PROJECTS")).toBe(true);
		expect(isUnder("1. PROJECTS/SF/a.md", "1. PROJECTS")).toBe(true);
		expect(isUnder("1. PROJECTS", "1. PROJECTS")).toBe(false);
		expect(isUnder("1. PROJECTS 2/SF", "1. PROJECTS")).toBe(false);
		expect(isUnder("anything", "")).toBe(false);
	});

	test("isUnder treats NFD (macOS) and NFC names as equal", () => {
		const nfd = "Projécts/SF"; // e + combining acute
		expect(isUnder(nfd, "Projécts")).toBe(true);
	});

	test("relocatePath rewrites the item itself and anything inside it", () => {
		expect(relocatePath("1. PROJECTS/SF", "1. PROJECTS", "01_PROJECTS")).toBe("01_PROJECTS/SF");
		expect(relocatePath("1. PROJECTS", "1. PROJECTS", "01_PROJECTS")).toBe("01_PROJECTS");
		expect(relocatePath("A/B/C/SF", "A", "Z")).toBe("Z/B/C/SF");
		expect(relocatePath("Other/SF", "1. PROJECTS", "01_PROJECTS")).toBeNull();
	});

	test("planAncestorRelocations moves every shared root under a renamed ancestor", () => {
		const roots = ["1. PROJECTS/SF", "1. PROJECTS/Deep/Team", "Elsewhere/X", "1. PROJECTS"];
		expect(planAncestorRelocations(roots, "1. PROJECTS", "01_PROJECTS")).toEqual([
			{ from: "1. PROJECTS/SF", to: "01_PROJECTS/SF" },
			{ from: "1. PROJECTS/Deep/Team", to: "01_PROJECTS/Deep/Team" },
		]);
		// Renaming a root itself is upstream's job, not an ancestor rename.
		expect(planAncestorRelocations(["SF"], "SF", "SF2")).toEqual([]);
	});

	test("overlapsAny detects equal, nested and containing folders", () => {
		expect(overlapsAny("A/B", ["A/B"])).toBe(true);
		expect(overlapsAny("A/B/C", ["A/B"])).toBe(true);
		expect(overlapsAny("A", ["A/B"])).toBe(true);
		expect(overlapsAny("A/C", ["A/B"])).toBe(false);
	});

	test("inferMovedRoot finds where a vanished root went", () => {
		expect(inferMovedRoot("1. PROJECTS/SF", "1. PROJECTS/SF/a/b.md", "01_PROJECTS/SF/a/b.md")).toBe(
			"01_PROJECTS/SF",
		);
		// the item's own path changed too: not a root move
		expect(inferMovedRoot("P/SF", "P/SF/a.md", "Q/SF/b.md")).toBeNull();
		// moved within the same root
		expect(inferMovedRoot("P/SF", "P/SF/a.md", "P/SF/x/a.md")).toBeNull();
		// not from inside the root
		expect(inferMovedRoot("P/SF", "Q/a.md", "R/a.md")).toBeNull();
		// nothing left of the new path
		expect(inferMovedRoot("P/SF", "P/SF/a.md", "/a.md")).toBeNull();
	});

	test("candidates are scored by how many known files they hold", () => {
		const files = new Set(["New/SF/a.md", "New/SF/b.md", "Old copy/SF/a.md"]);
		const exists = (p: string) => files.has(p);
		const sample = ["/a.md", "/b.md"];
		expect(scoreCandidate(sample, "New/SF", exists)).toBe(1);
		expect(scoreCandidate(sample, "Old copy/SF", exists)).toBe(0.5);
		expect(scoreCandidate([], "New/SF", exists)).toBe(0);
		expect(rankCandidates(sample, ["Old copy/SF", "New/SF", "Empty"], exists)).toEqual([
			{ root: "New/SF", score: 1 },
			{ root: "Old copy/SF", score: 0.5 },
		]);
	});

	test("backups keep the folder structure under .trash/relay", () => {
		const stamp = formatStamp(new Date(2026, 10, 19, 9, 5));
		expect(stamp).toBe("2026-11-19-0905");
		expect(backupPathFor("SF", stamp, "/sub/dir/a.md")).toBe(".trash/relay/SF/2026-11-19-0905/sub/dir/a.md");
		expect(sanitizeSegment("a/b:c")).toBe("a_b_c");
		expect(sanitizeSegment("..hidden")).toBe("hidden");
		expect(sanitizeSegment("")).toBe("folder");
		expect(nextFreeName("x/a.md", 1)).toBe("x/a.md");
		expect(nextFreeName("x/a.md", 2)).toBe("x/a (2).md");
		expect(nextFreeName("x/noext", 3)).toBe("x/noext (3)");
	});
});

describe("decideRemoval (10 files or 25%)", () => {
	const decide = (removing: number, tracked: number, recentlyRemoved = 0, rootPresent = true) =>
		decideRemoval({ removing, tracked, recentlyRemoved, rootPresent }).kind;

	test("small removals apply", () => {
		expect(decide(1, 100)).toBe("apply");
		expect(decide(9, 1000)).toBe("apply");
		expect(decide(2, 12)).toBe("apply"); // 17%
		expect(decide(1, 1)).toBe("apply"); // a one-file folder
		expect(decide(2, 4)).toBe("apply"); // 50% of a tiny folder
		expect(decide(0, 10)).toBe("apply");
	});

	test("mass removals are held", () => {
		expect(decide(10, 1000)).toBe("hold");
		expect(decide(3, 12)).toBe("hold"); // 25%
		expect(decide(5, 16)).toBe("hold");
		expect(decide(2, 2)).toBe("hold"); // empties the folder
		expect(decide(2, 1000, 8)).toBe("hold"); // slow stream adds up
	});

	test("a vanished root is never a removal", () => {
		expect(decide(30, 30, 0, false)).toBe("root-missing");
		expect(decide(0, 30, 0, false)).toBe("root-missing");
	});

	test("RemovalWindow slides and resets", () => {
		let now = 0;
		const w = new RemovalWindow(1000, () => now);
		w.record(3);
		now = 500;
		w.record(2);
		expect(w.count()).toBe(5);
		now = 1200;
		expect(w.count()).toBe(2);
		w.reset();
		expect(w.count()).toBe(0);
	});
});

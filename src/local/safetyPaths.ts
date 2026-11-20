// Path math for the folder-safety guards (see safety.ts). Pure — no Obsidian
// imports — so it is unit-tested directly.
//
// Conventions: vault paths use "/" and never start with "/" ("01_PROJECTS/SF").
// A shared folder's virtual paths (vpaths) DO start with "/" ("/sub/note.md"):
// SharedFolder.getVirtualPath slices the folder path off the vault path.

/** Unicode-normalise so macOS (NFD) and other platforms (NFC) compare equal. */
export function nfc(path: string): string {
	return path.normalize("NFC");
}

/** True when `path` is strictly inside `root` (not equal to it). */
export function isUnder(path: string, root: string): boolean {
	const r = nfc(root);
	return r !== "" && nfc(path).startsWith(r + "/");
}

/** `path` after renaming `from` → `to`, if `path` is `from` or inside it; else null. */
export function relocatePath(path: string, from: string, to: string): string | null {
	const p = nfc(path);
	const f = nfc(from);
	if (p === f) return to;
	if (isUnder(p, f)) return to + p.slice(f.length);
	return null;
}

export interface Relocation {
	from: string;
	to: string;
}

/**
 * Shared roots carried along when the folder `oldPath` is renamed to `newPath`
 * and is a strict ANCESTOR of the root. (Renaming a root itself is handled by
 * upstream's own exact-match branch.)
 */
export function planAncestorRelocations(
	roots: readonly string[],
	oldPath: string,
	newPath: string,
): Relocation[] {
	const plans: Relocation[] = [];
	for (const root of roots) {
		if (!isUnder(root, oldPath)) continue;
		const to = relocatePath(root, oldPath, newPath);
		if (to !== null) plans.push({ from: root, to });
	}
	return plans;
}

/** Does `candidate` equal, contain, or sit inside any of `others`? */
export function overlapsAny(candidate: string, others: readonly string[]): boolean {
	const c = nfc(candidate);
	return others.some((o) => nfc(o) === c || isUnder(o, c) || isUnder(c, o));
}

/**
 * Child-first rename backstop. An item moved from inside `root` to outside it;
 * if its path below the root is unchanged, the root itself moved:
 *   root "1. PROJECTS/SF", "1. PROJECTS/SF/a/b.md" → "01_PROJECTS/SF/a/b.md"
 *   ⇒ "01_PROJECTS/SF".
 * Returns null when the move doesn't look like that.
 */
export function inferMovedRoot(root: string, oldPath: string, newPath: string): string | null {
	if (!isUnder(oldPath, root)) return null;
	const rel = nfc(oldPath).slice(nfc(root).length); // "/a/b.md"
	const n = nfc(newPath);
	if (!n.endsWith(rel) || n.length === rel.length) return null;
	const candidate = n.slice(0, n.length - rel.length);
	if (candidate === nfc(root) || isUnder(candidate, root) || isUnder(root, candidate)) {
		return null;
	}
	return candidate;
}

/** Fraction of `sample` (vpaths like "/x.md") that exist under `root`. */
export function scoreCandidate(
	sample: readonly string[],
	root: string,
	exists: (vaultPath: string) => boolean,
): number {
	if (sample.length === 0) return 0;
	let hits = 0;
	for (const vpath of sample) {
		if (exists(root + vpath)) hits++;
	}
	return hits / sample.length;
}

export interface Candidate {
	root: string;
	score: number;
}

/** Candidates with any overlap, best first. */
export function rankCandidates(
	sample: readonly string[],
	roots: readonly string[],
	exists: (vaultPath: string) => boolean,
): Candidate[] {
	return roots
		.map((root) => ({ root, score: scoreCandidate(sample, root, exists) }))
		.filter((c) => c.score > 0)
		.sort((a, b) => b.score - a.score || a.root.localeCompare(b.root));
}

export function basename(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

/** "a/b/c.md" → ["a", "a/b"] */
export function parentDirs(path: string): string[] {
	const parts = path.split("/").slice(0, -1);
	return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local time as YYYY-MM-DD-HHmm, for backup folder names. */
export function formatStamp(d: Date): string {
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`-${pad(d.getHours())}${pad(d.getMinutes())}`
	);
}

/** A folder name that is safe as one path segment. */
export function sanitizeSegment(name: string): string {
	const s = name
		.replace(/[\\/:*?"<>|#^[\]]/g, "_")
		.replace(/^\.+/, "")
		.trim();
	return s || "folder";
}

/** Backups of remotely removed files live under the vault's (hidden) trash. */
export const BACKUP_ROOT = ".trash/relay";

export function backupDirFor(folderName: string, stamp: string): string {
	return `${BACKUP_ROOT}/${sanitizeSegment(folderName)}/${stamp}`;
}

/** .trash/relay/<folder>/<stamp>/<vpath without the leading "/"> */
export function backupPathFor(folderName: string, stamp: string, vpath: string): string {
	return `${backupDirFor(folderName, stamp)}/${vpath.replace(/^\/+/, "")}`;
}

/** "a/b.md" → "a/b (2).md", "a/b (3).md", … — the first name `taken` rejects. */
export function nextFreeName(path: string, attempt: number): string {
	if (attempt <= 1) return path;
	const slash = path.lastIndexOf("/");
	const dir = path.slice(0, slash + 1);
	const file = path.slice(slash + 1);
	const dot = file.lastIndexOf(".");
	const stem = dot > 0 ? file.slice(0, dot) : file;
	const ext = dot > 0 ? file.slice(dot) : "";
	return `${dir}${stem} (${attempt})${ext}`;
}

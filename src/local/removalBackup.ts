// When a collaborator removes files, upstream moves the local copies to
// Obsidian's trash with `trashLocal`, which flattens them into
// `<vault>/.trash/<file name>` and loses the folder structure. The guard moves
// them here instead:
//
//   .trash/relay/<shared folder name>/<YYYY-MM-DD-HHmm>/<path inside the folder>
//
// plus a `_relay-backup.json` manifest. `.trash` is hidden from the vault, so
// the moves fire no vault events beyond the same "delete" echo `trashLocal`
// produces — which upstream already suppresses with its pending-delete mark.

import type { DataAdapter } from "obsidian";
import {
	backupDirFor,
	backupPathFor,
	dirname,
	formatStamp,
	nextFreeName,
	parentDirs,
} from "./safetyPaths";

interface MovedEntry {
	vpath: string;
	backupPath: string;
	removedAt: string;
}

export class RemovalBackup {
	readonly stamp: string;
	private readonly moved: MovedEntry[] = [];
	private readonly madeDirs = new Set<string>();

	constructor(
		private readonly adapter: DataAdapter,
		private readonly folderName: string,
		private readonly folderGuid: string,
		private readonly folderPath: string,
		now: Date = new Date(),
	) {
		this.stamp = formatStamp(now);
	}

	get dir(): string {
		return backupDirFor(this.folderName, this.stamp);
	}

	get count(): number {
		return this.moved.length;
	}

	/** Move one file (vault path `from`, folder-relative `vpath`) into the backup. */
	async moveFile(from: string, vpath: string): Promise<void> {
		const target = await this.freePath(backupPathFor(this.folderName, this.stamp, vpath));
		await this.ensureDir(dirname(target));
		try {
			await this.adapter.rename(from, target);
		} catch (renameError) {
			try {
				await this.adapter.copy(from, target);
				await this.adapter.remove(from);
			} catch {
				// Last resort: upstream's own behaviour, so the removal still happens.
				await this.adapter.trashLocal(from);
				return;
			}
		}
		this.moved.push({ vpath, backupPath: target, removedAt: new Date().toISOString() });
	}

	/**
	 * A removed folder: its files were moved one by one already. Remove it if
	 * empty; otherwise move whatever is left (files the plugin doesn't sync)
	 * into the backup too, keeping their structure.
	 */
	async moveFolder(from: string, vpath: string): Promise<void> {
		if (!(await this.adapter.exists(from))) return;
		const listing = await this.adapter.list(from);
		for (const file of listing.files) {
			await this.moveFile(file, vpath + file.slice(from.length));
		}
		for (const sub of listing.folders) {
			await this.moveFolder(sub, vpath + sub.slice(from.length));
		}
		if (await this.adapter.exists(from)) {
			try {
				await this.adapter.rmdir(from, false);
			} catch {
				await this.adapter.trashLocal(from);
			}
		}
	}

	/** Append this pass's entries to the backup folder's manifest. */
	async writeManifest(): Promise<void> {
		if (this.moved.length === 0) return;
		const path = `${this.dir}/_relay-backup.json`;
		let existing: { entries?: MovedEntry[] } = {};
		try {
			if (await this.adapter.exists(path)) {
				existing = JSON.parse(await this.adapter.read(path)) as typeof existing;
			}
		} catch {
			existing = {};
		}
		const manifest = {
			about:
				"Files a collaborator removed from a shared folder. Move them back into the " +
				"folder to restore them (they are then shared again).",
			folderGuid: this.folderGuid,
			folderPath: this.folderPath,
			entries: [...(existing.entries ?? []), ...this.moved],
		};
		await this.ensureDir(this.dir);
		await this.adapter.write(path, JSON.stringify(manifest, null, 2) + "\n");
	}

	private async freePath(path: string): Promise<string> {
		for (let attempt = 1; ; attempt++) {
			const candidate = nextFreeName(path, attempt);
			if (!(await this.adapter.exists(candidate))) return candidate;
		}
	}

	/** Create a folder one segment at a time (not every adapter is recursive). */
	private async ensureDir(dir: string): Promise<void> {
		if (!dir || this.madeDirs.has(dir)) return;
		for (const segment of [...parentDirs(dir), dir]) {
			if (this.madeDirs.has(segment)) continue;
			if (!(await this.adapter.exists(segment))) {
				await this.adapter.mkdir(segment);
			}
			this.madeDirs.add(segment);
		}
	}
}

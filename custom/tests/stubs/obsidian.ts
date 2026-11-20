// Just enough of the Obsidian API for the fork's unit tests.

export class Notice {
	static shown: string[] = [];
	constructor(message: string | DocumentFragment, _timeout?: number) {
		Notice.shown.push(typeof message === "string" ? message : "(fragment)");
	}
	hide(): void {}
}

export class TAbstractFile {
	constructor(public path: string) {}
	get name(): string {
		return this.path.slice(this.path.lastIndexOf("/") + 1);
	}
}

export class TFile extends TAbstractFile {}

export class TFolder extends TAbstractFile {}

export class Modal {
	contentEl = {} as HTMLElement;
	titleEl = {} as HTMLElement;
	constructor(public app: unknown) {}
	open(): void {}
	close(): void {}
}

export class Plugin {}

export function normalizePath(path: string): string {
	return path.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

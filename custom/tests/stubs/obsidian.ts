// Just enough of the Obsidian API for the fork's unit tests.

export class Notice {
	static shown: string[] = [];
	constructor(message: string, _timeout?: number) {
		Notice.shown.push(message);
	}
}

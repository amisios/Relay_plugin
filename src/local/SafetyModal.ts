// The folder-safety guards talk to the user through this small interface, so
// the guards themselves stay testable without Obsidian's UI.

import { type App, Modal, Notice } from "obsidian";

export interface SafetyAction {
	label: string;
	/** Highlight as the recommended choice. */
	cta?: boolean;
	/** Style as destructive. */
	warning?: boolean;
	run: () => void;
}

export interface SafetyPrompt {
	title: string;
	message: string;
	/** Example paths to show (the first few). */
	paths?: string[];
	actions: SafetyAction[];
	/** Called when the dialog is closed without choosing an action. */
	onDismiss?: () => void;
}

export interface SafetyUI {
	/** Show a prompt; one per `key` at a time (a second ask for the same key is ignored). */
	ask(key: string, prompt: SafetyPrompt): void;
	/** Close the prompt for `key`, if open, without running onDismiss. */
	close(key: string): void;
	notice(message: string, timeoutMs?: number, action?: { label: string; run: () => void }): void;
}

const SHOWN_PATHS = 8;

class SafetyModal extends Modal {
	private chosen = false;

	constructor(
		app: App,
		private readonly prompt: SafetyPrompt,
		private readonly onClosed: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl, prompt } = this;
		titleEl.setText(prompt.title);
		contentEl.createEl("p", { text: prompt.message });
		const paths = prompt.paths ?? [];
		if (paths.length > 0) {
			const list = contentEl.createEl("ul");
			for (const path of paths.slice(0, SHOWN_PATHS)) {
				list.createEl("li").createEl("code", { text: path.replace(/^\/+/, "") });
			}
			if (paths.length > SHOWN_PATHS) {
				list.createEl("li", { text: `…and ${paths.length - SHOWN_PATHS} more` });
			}
		}
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		for (const action of prompt.actions) {
			const button = buttons.createEl("button", { text: action.label });
			if (action.cta) button.addClass("mod-cta");
			if (action.warning) button.addClass("mod-warning");
			button.addEventListener("click", () => {
				this.chosen = true;
				this.close();
				action.run();
			});
		}
	}

	/** Close without counting as a dismissal (the guard resolved it another way). */
	dismissSilently(): void {
		this.chosen = true;
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.onClosed();
		if (!this.chosen) this.prompt.onDismiss?.();
	}
}

export class ObsidianSafetyUI implements SafetyUI {
	private readonly open = new Map<string, SafetyModal>();

	constructor(private readonly app: App) {}

	ask(key: string, prompt: SafetyPrompt): void {
		if (this.open.has(key)) return;
		const modal = new SafetyModal(this.app, prompt, () => this.open.delete(key));
		this.open.set(key, modal);
		modal.open();
	}

	close(key: string): void {
		this.open.get(key)?.dismissSilently();
	}

	notice(message: string, timeoutMs = 10_000, action?: { label: string; run: () => void }): void {
		if (!action) {
			new Notice(message, timeoutMs);
			return;
		}
		const fragment = document.createDocumentFragment();
		const text = document.createElement("div");
		text.textContent = message;
		const button = document.createElement("button");
		button.textContent = action.label;
		button.style.marginTop = "6px";
		fragment.append(text, button);
		const notice = new Notice(fragment, timeoutMs);
		button.addEventListener("click", () => {
			notice.hide();
			action.run();
		});
	}
}

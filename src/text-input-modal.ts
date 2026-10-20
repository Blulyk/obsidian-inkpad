import { App, Modal } from "obsidian";
import { t } from "./i18n";

/** A mobile-friendly replacement for window.prompt, which Obsidian flags and iPadOS presents inconsistently. */
export class TextInputModal extends Modal {
	private resolved = false;

	constructor(app: App, private readonly label: string, private readonly initialValue: string, private readonly onSubmit: (value: string | null) => void) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.label);
		const input = this.contentEl.createEl("input", { type: "text", value: this.initialValue, cls: "inkpad-text-input" });
		input.addEventListener("keydown", event => {
			if (event.key === "Enter") { event.preventDefault(); this.submit(input.value); }
		});
		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = actions.createEl("button", { text: t("cancel") });
		cancel.addEventListener("click", () => this.submit(null));
		const confirm = actions.createEl("button", { cls: "mod-cta", text: t("confirm") });
		confirm.addEventListener("click", () => this.submit(input.value));
		window.setTimeout(() => input.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) this.onSubmit(null);
	}

	private submit(value: string | null): void {
		if (this.resolved) return;
		this.resolved = true;
		this.onSubmit(value);
		this.close();
	}
}

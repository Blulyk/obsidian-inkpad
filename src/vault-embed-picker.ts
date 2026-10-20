import { App, FuzzySuggestModal, TFile } from "obsidian";

export class VaultEmbedPickerModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private readonly onChoose: (file: TFile) => void) { super(app); }

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter(file => ["md", "pdf", "png", "jpg", "jpeg", "webp", "gif", "mp3", "m4a", "wav", "ogg"].includes(file.extension.toLowerCase()));
	}

	getItemText(file: TFile): string { return file.path; }

	onChooseItem(file: TFile): void { this.onChoose(file); }
}

import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { InkpadSettings, DEFAULT_SETTINGS, InkpadSettingsTab } from "./settings";
import { INKPAD_VIEW, InkpadView } from "./ink-view";
import { EMPTY_DOCUMENT } from "./types";
import { serializeInkDocument } from "./format";
import { t } from "./i18n";

export default class InkpadPlugin extends Plugin {
	settings: InkpadSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<InkpadSettings>);
		this.registerView(INKPAD_VIEW, (leaf: WorkspaceLeaf) => new InkpadView(leaf, this));
		this.registerExtensions(["ink"], INKPAD_VIEW);
		this.addSettingTab(new InkpadSettingsTab(this.app, this));
		this.addCommand({ id: "new-infinite-drawing", name: t("newInfiniteDrawing"), callback: () => void this.createDrawing() });
		this.addRibbonIcon("pen-line", t("createInkpadDrawing"), () => void this.createDrawing());
		this.registerEvent(this.app.vault.on("modify", file => {
			if (!(file instanceof TFile)) return;
			for (const leaf of this.app.workspace.getLeavesOfType(INKPAD_VIEW)) void (leaf.view as InkpadView).onVaultFileChange(file);
		}));
	}

	onunload(): void { this.app.workspace.detachLeavesOfType(INKPAD_VIEW); }

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(INKPAD_VIEW)) (leaf.view as InkpadView).refreshAppearance();
	}

	private async createDrawing(): Promise<void> {
		try {
			// Avoid FileManager helpers here: some mobile and older desktop builds do not
			// expose the same implementation. The active file's parent is enough.
			const activeFile = this.app.workspace.getActiveFile();
			const prefix = activeFile?.parent?.path ? `${activeFile.parent.path}/` : "";
			let suffix = ""; let counter = 2;
			while (this.app.vault.getAbstractFileByPath(`${prefix}Dibujo${suffix}.ink`)) suffix = ` ${counter++}`;
			const file = await this.app.vault.create(`${prefix}Dibujo${suffix}.ink`, serializeInkDocument({ ...EMPTY_DOCUMENT, strokes: [], shapes: [], elements: [] }));
			const leaf = this.app.workspace.getLeaf(true);
			// openFile selects the registered .ink view itself, which is more resilient
			// than constructing view state while a workspace is still settling.
			await leaf.openFile(file, { active: true });
			new Notice(t("drawingCreated", { name: file.basename }));
		} catch (error) {
			console.error("Inkpad no pudo crear el dibujo", error);
			new Notice(t("couldNotCreateDrawing"));
		}
	}
}

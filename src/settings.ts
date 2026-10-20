import { App, PluginSettingTab, Setting } from "obsidian";
import InkpadPlugin from "./main";
import { t } from "./i18n";

export interface InkpadSettings {
	autosaveDelayMs: number;
	defaultColor: string;
	defaultWidth: number;
	paperStyle: "grid" | "dots" | "lines" | "cornell" | "music" | "weekly" | "blank";
	pressureResponse: "fixed" | "subtle" | "natural";
}

export const DEFAULT_SETTINGS: InkpadSettings = {
	autosaveDelayMs: 2000,
	defaultColor: "#ffffff",
	defaultWidth: 3,
	paperStyle: "grid",
	pressureResponse: "subtle",
};

export class InkpadSettingsTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: InkpadPlugin) { super(app, plugin); }

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName(t("autosaveDelay")).setDesc(t("autosaveDelayDesc"))
			.addSlider(slider => slider.setLimits(1000, 5000, 250).setValue(Math.max(1000, this.plugin.settings.autosaveDelayMs)).setDynamicTooltip().onChange(async value => {
				this.plugin.settings.autosaveDelayMs = value;
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl).setName(t("defaultColor")).addColorPicker(picker => picker.setValue(this.plugin.settings.defaultColor).onChange(async value => {
			this.plugin.settings.defaultColor = value;
			await this.plugin.saveSettings();
		}));
		new Setting(containerEl).setName(t("canvasPaper")).addDropdown(dropdown => dropdown
			.addOption("grid", t("grid")).addOption("dots", t("dots")).addOption("lines", t("ruled")).addOption("cornell", "Cornell").addOption("music", t("pentagram")).addOption("weekly", t("weekly")).addOption("blank", t("blank"))
			.setValue(this.plugin.settings.paperStyle).onChange(async value => { this.plugin.settings.paperStyle = value as InkpadSettings["paperStyle"]; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName(t("pressureResponse")).setDesc(t("pressureResponseDesc"))
			.addDropdown(dropdown => dropdown.addOption("fixed", t("fixed")).addOption("subtle", t("subtle")).addOption("natural", t("natural"))
				.setValue(this.plugin.settings.pressureResponse).onChange(async value => { this.plugin.settings.pressureResponse = value as InkpadSettings["pressureResponse"]; await this.plugin.saveSettings(); }));
	}
}

import { App, PluginSettingTab, Setting } from "obsidian";
import InkpadPlugin from "./main";

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
		new Setting(containerEl).setName("Pausa antes de guardar").setDesc("Agrupa trazos terminados antes de escribir el archivo. Una pausa mayor protege la fluidez del Pencil en dibujos largos.")
			.addSlider(slider => slider.setLimits(1000, 5000, 250).setValue(Math.max(1000, this.plugin.settings.autosaveDelayMs)).setDynamicTooltip().onChange(async value => {
				this.plugin.settings.autosaveDelayMs = value;
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl).setName("Color predeterminado").addColorPicker(picker => picker.setValue(this.plugin.settings.defaultColor).onChange(async value => {
			this.plugin.settings.defaultColor = value;
			await this.plugin.saveSettings();
		}));
		new Setting(containerEl).setName("Papel del lienzo").addDropdown(dropdown => dropdown
			.addOption("grid", "Cuadrícula").addOption("dots", "Puntos").addOption("lines", "Rayado").addOption("cornell", "Cornell").addOption("music", "Pentagrama").addOption("weekly", "Plan semanal").addOption("blank", "Blanco")
			.setValue(this.plugin.settings.paperStyle).onChange(async value => { this.plugin.settings.paperStyle = value as InkpadSettings["paperStyle"]; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("Sensibilidad de presión").setDesc("Fija mantiene el mismo grosor; sutil es la recomendada para apuntes; natural responde más a la presión del Pencil.")
			.addDropdown(dropdown => dropdown.addOption("fixed", "Fija").addOption("subtle", "Sutil").addOption("natural", "Natural")
				.setValue(this.plugin.settings.pressureResponse).onChange(async value => { this.plugin.settings.pressureResponse = value as InkpadSettings["pressureResponse"]; await this.plugin.saveSettings(); }));
	}
}

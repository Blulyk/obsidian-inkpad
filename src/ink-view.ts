import { ItemView, MarkdownRenderer, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { isInkpadDocument, parseInkDocument, serializeInkDocument } from "./format";
import InkpadPlugin from "./main";
import { EMPTY_DOCUMENT, InkDocument, InkPoint, InkShape, InkStroke, Tool } from "./types";
import { InkElement } from "./types";
import { VaultEmbedPickerModal } from "./vault-embed-picker";
import { renderPdfPages } from "./pdf-renderer";

export const INKPAD_VIEW = "inkpad-canvas";

type Transform = { x: number; y: number; zoom: number };
type ElementGesture = { id: string; pointerId: number; startClientX: number; startClientY: number; startX: number; startY: number; startWidth: number; startHeight: number; mode: "move" | "resize" };
type PinchGesture = { distance: number; centerX: number; centerY: number; transform: Transform };
type InkRenderCache = { canvas: HTMLCanvasElement; width: number; height: number; padding: number; pixelRatio: number; transform: Transform };
type PendingMouseInk = { stroke: InkStroke; first: InkPoint; points: InkPoint[] };
const MAX_UNDO = 80;

export class InkpadView extends ItemView {
	private file: TFile | null = null;
	private document: InkDocument = { ...EMPTY_DOCUMENT, strokes: [], shapes: [], elements: [] };
	private canvas!: HTMLCanvasElement;
	private context!: CanvasRenderingContext2D;
	private viewportEl!: HTMLElement;
	private elementLayer!: HTMLElement;
	private transform: Transform = { x: 0, y: 0, zoom: 1 };
	private tool: Tool = "pen";
	private color: string;
	private width: number;
	private activeStroke: InkStroke | null = null;
	private activeShape: InkShape | null = null;
	private lassoPoints: InkPoint[] = [];
	private selectedStrokeIds = new Set<string>();
	private selectedShapeIds = new Set<string>();
	private selectionMove: { start: InkPoint; strokes: InkStroke[]; shapes: InkShape[] } | null = null;
	private activePointer: number | null = null;
	private panPointer: number | null = null;
	private pointers = new Map<number, PointerEvent>();
	private panStart: { x: number; y: number; transform: Transform } | null = null;
	private pinchStart: PinchGesture | null = null;
	private history: InkDocument[] = [];
	private redoStack: InkDocument[] = [];
	private resizeObserver: ResizeObserver | null = null;
	private saveTimer: number | null = null;
	private queuedWrite: Promise<void> = Promise.resolve();
	private writing = false;
	private lastWritten = "";
	private changedDuringEdit = false;
	private pixelRatio = 1;
	private inkRenderCache: InkRenderCache | null = null;
	private inkCacheDirty = true;
	private navigationRenderFrame: number | null = null;
	private mouseInkFrame: number | null = null;
	private pendingMouseInk: PendingMouseInk | null = null;
	private quickMenu: HTMLElement | null = null;
	private inkMenu: HTMLElement | null = null;
	private bookmarkMenu: HTMLElement | null = null;
	private elementRenderGeneration = 0;
	private elementGesture: ElementGesture | null = null;
	private zoomReadout: HTMLButtonElement | null = null;
	private saveReadout: HTMLElement | null = null;
	private toolbarEl: HTMLElement | null = null;
	private focusMode = false;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: InkpadPlugin) {
		super(leaf);
		this.color = plugin.settings.defaultColor;
		this.width = plugin.settings.defaultWidth;
	}

	getViewType(): string { return INKPAD_VIEW; }
	getDisplayText(): string { return this.file?.basename ?? "Inkpad"; }
	getIcon(): string { return "pen-line"; }

	async onOpen(): Promise<void> {
		this.containerEl.empty();
		this.containerEl.addClass("inkpad-view");
		this.buildToolbar();
		this.viewportEl = this.containerEl.createDiv({ cls: "inkpad-viewport" });
		this.elementLayer = this.viewportEl.createDiv({ cls: "inkpad-elements", attr: { "aria-hidden": "true" } });
		this.canvas = this.viewportEl.createEl("canvas", { cls: "inkpad-canvas", attr: { "aria-label": "Lienzo de dibujo Inkpad", tabindex: "0" } });
		const context = this.canvas.getContext("2d", { alpha: true, desynchronized: true });
		if (!context) throw new Error("Canvas 2D no disponible");
		this.context = context;
		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(this.viewportEl);
		this.registerDomEvent(this.canvas, "pointerdown", this.onPointerDown, { passive: false });
		this.registerDomEvent(this.canvas, "pointermove", this.onPointerMove, { passive: false });
		this.registerDomEvent(this.canvas, "pointerup", this.onPointerUp, { passive: false });
		this.registerDomEvent(this.canvas, "pointercancel", this.onPointerUp, { passive: false });
		this.registerDomEvent(this.canvas, "wheel", this.onWheel, { passive: false });
		this.registerDomEvent(this.canvas, "keydown", this.onKeyDown);
		this.buildViewportHud();
	}

	async onClose(): Promise<void> {
		await this.flushSave();
		if (this.navigationRenderFrame !== null) cancelAnimationFrame(this.navigationRenderFrame);
		if (this.mouseInkFrame !== null) cancelAnimationFrame(this.mouseInkFrame);
		this.quickMenu?.remove();
		this.resizeObserver?.disconnect();
	}

	async setState(state: { file?: string }, result: { history: boolean }): Promise<void> {
		await super.setState(state, result);
		const file = state.file ? this.app.vault.getAbstractFileByPath(state.file) : null;
		if (!(file instanceof TFile)) return;
		this.file = file;
		await this.loadFile();
	}

	getState(): { file: string | undefined } { return { file: this.file?.path }; }

	async onExternalFileChange(file: TFile): Promise<void> {
		if (!this.file || file.path !== this.file.path || this.writing) return;
		if (this.activeStroke || this.saveTimer !== null) { this.changedDuringEdit = true; return; }
		await this.loadFile();
	}

	async onVaultFileChange(file: TFile): Promise<void> {
		if (this.file?.path === file.path) { await this.onExternalFileChange(file); return; }
		if (this.document.elements.some(element => element.path === file.path)) await this.renderElements();
	}

	/** Applies visual-only settings without reloading the drawing or touching sync state. */
	refreshAppearance(): void { this.render(); }

	private async loadFile(): Promise<void> {
		if (!this.file) return;
		const raw = await this.app.vault.read(this.file);
		if (raw === this.lastWritten) return;
		if (!isInkpadDocument(raw)) {
			new Notice("Inkpad no cargó este archivo porque está incompleto o no es válido. No se ha sobrescrito.");
			return;
		}
		this.document = parseInkDocument(raw);
		this.invalidateInkCache();
		this.transform = this.document.viewport ?? { x: 0, y: 0, zoom: 1 };
		this.history = [];
		this.redoStack = [];
		this.requestNavigationRender();
		void this.renderElements();
	}

	private buildToolbar(): void {
		const toolbar = this.containerEl.createDiv({ cls: "inkpad-toolbar" });
		this.toolbarEl = toolbar;
		const toolGroup = toolbar.createDiv({ cls: "inkpad-toolbar-group inkpad-tool-group" });
		for (const [tool, label, icon] of [["pen", "Pluma", "pen-tool"], ["pencil", "Lápiz", "pencil-ruler"], ["marker", "Rotulador", "paintbrush"], ["highlighter", "Subrayador", "highlighter"], ["eraser", "Borrador", "eraser"], ["lasso", "Lazo", "lasso-select"]] as const) {
			const button = this.iconButton(toolGroup, icon, label, "inkpad-tool", { "data-tool": tool });
			button.addEventListener("click", () => { this.tool = tool; this.refreshToolbar(); });
		}
		const actionGroup = toolbar.createDiv({ cls: "inkpad-toolbar-group inkpad-action-group" });
		const undo = this.iconButton(actionGroup, "undo-2", "Deshacer");
		undo.addEventListener("click", () => this.undo());
		const redo = this.iconButton(actionGroup, "redo-2", "Rehacer");
		redo.addEventListener("click", () => this.redo());
		const save = this.iconButton(actionGroup, "save", "Guardar ahora");
		save.addEventListener("click", () => void this.saveNow());
		const tools = this.iconButton(actionGroup, "ellipsis", "Más herramientas");
		tools.addEventListener("click", () => this.openQuickMenu());
		const insert = this.iconButton(actionGroup, "plus", "Insertar archivo del vault");
		insert.addEventListener("click", () => new VaultEmbedPickerModal(this.app, file => this.insertFile(file)).open());
		const text = this.iconButton(actionGroup, "type", "Insertar texto");
		text.addEventListener("click", () => this.insertText());
		const deleteSelection = this.iconButton(actionGroup, "trash-2", "Eliminar selección", "inkpad-destructive");
		deleteSelection.addEventListener("click", () => this.deleteSelection());
		const exportButton = this.iconButton(actionGroup, "file-code-2", "Exportar tinta como SVG");
		exportButton.addEventListener("click", () => void this.exportSvg());
		const exportPngButton = this.iconButton(actionGroup, "image-down", "Exportar tinta como PNG");
		exportPngButton.addEventListener("click", () => void this.exportPng());
		const frame = this.iconButton(actionGroup, "scan", "Encuadrar todo el contenido");
		frame.addEventListener("click", () => this.frameContent());
		const focus = this.iconButton(actionGroup, "panel-top-close", "Alternar modo enfoque");
		focus.addEventListener("click", () => this.toggleFocusMode());
		this.refreshToolbar();
	}

	private buildViewportHud(): void {
		const dock = this.viewportEl.createDiv({ cls: "inkpad-bottom-dock" });
		const leftRail = this.viewportEl.createDiv({ cls: "inkpad-left-rail" });
		const bookmarkControls = this.viewportEl.createDiv({ cls: "inkpad-bookmark-controls" });
		const bookmarks = bookmarkControls.createEl("button", { cls: "inkpad-bottom-button", attr: { "aria-label": "Posiciones guardadas" } }); setIcon(bookmarks, "bookmark"); bookmarks.addEventListener("click", () => this.toggleBookmarkMenu(bookmarkControls));
		const hud = dock.createDiv({ cls: "inkpad-viewport-hud" });
		this.saveReadout = hud.createSpan({ cls: "inkpad-save-state", text: "Guardado" });
		this.zoomReadout = hud.createEl("button", { cls: "inkpad-zoom-readout", text: "100%", attr: { "aria-label": "Restablecer zoom al 100%" } });
		this.zoomReadout.addEventListener("click", () => this.resetZoom());
		const frame = hud.createDiv({ cls: "inkpad-hud-button inkpad-hud-control", attr: { role: "button", tabindex: "0", "aria-label": "Encuadrar contenido" } });
		setIcon(frame, "scan");
		let frameTouchHandledUntil = 0;
		frame.addEventListener("pointerup", event => {
			if (event.pointerType === "mouse") return;
			event.preventDefault();
			frameTouchHandledUntil = performance.now() + 600;
			this.frameContent();
		});
		frame.addEventListener("click", event => {
			if (performance.now() < frameTouchHandledUntil) { event.preventDefault(); return; }
			this.frameContent();
		});
		frame.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.frameContent(); } });
		const focus = leftRail.createDiv({ cls: "inkpad-rail-control", attr: { role: "button", tabindex: "0", "aria-label": "Alternar modo enfoque" } });
		setIcon(focus, "panel-top-close");
		focus.addEventListener("click", () => this.toggleFocusMode());
		focus.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.toggleFocusMode(); } });
		const ink = leftRail.createDiv({ cls: "inkpad-rail-control inkpad-ink-trigger", attr: { role: "button", tabindex: "0", "aria-label": "Color y grosor" } });
		setIcon(ink, "palette");
		ink.addEventListener("click", () => this.toggleInkMenu(leftRail));
		ink.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.toggleInkMenu(leftRail); } });
		this.updateViewportHud();
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, cls = "", attributes: Record<string, string> = {}): HTMLButtonElement {
		const button = parent.createEl("button", { cls: `inkpad-icon-button ${cls}`, attr: { "aria-label": label, "data-tooltip-position": "bottom", ...attributes } });
		setIcon(button, icon);
		return button;
	}

	private refreshToolbar(): void {
		this.containerEl.querySelectorAll<HTMLButtonElement>(".inkpad-tool").forEach(button => button.toggleClass("is-active", button.dataset.tool === this.tool));
	}

	private openQuickMenu(clientX?: number, clientY?: number): void {
		if (this.quickMenu) { this.closeQuickMenu(); return; }
		const menu = this.viewportEl.createDiv({ cls: "inkpad-quick-menu", attr: { role: "menu", "aria-label": "Herramientas de dibujo" } });
		const action = (icon: string, label: string, callback: () => void, active = false): void => {
			const button = menu.createEl("button", { cls: active ? "is-active" : "", attr: { "aria-label": label } });
			setIcon(button, icon); button.createSpan({ text: label });
			button.addEventListener("click", () => { callback(); this.closeQuickMenu(); });
		};
		action("undo-2", "Deshacer", () => this.undo());
		action("redo-2", "Rehacer", () => this.redo());
		menu.createDiv({ cls: "inkpad-menu-divider" });
		action("bookmark-plus", "Guardar posición actual", () => this.addBookmark());
		for (const bookmark of this.document.bookmarks ?? []) action("bookmark", bookmark.name, () => this.goToBookmark(bookmark.id));
		if (this.selectedStrokeIds.size || this.selectedShapeIds.size) {
			menu.createDiv({ cls: "inkpad-menu-divider" });
			action("copy-plus", "Duplicar selección", () => this.duplicateSelection());
			action("palette", "Aplicar color actual", () => this.colorSelection());
			action("link", "Vincular a nota o URL", () => this.linkSelection());
			action("image-down", "Exportar selección PNG", () => void this.exportSelectionPng());
			action("minus", "Convertir en línea", () => this.convertSelectionToShape("line"));
			action("square", "Convertir en rectángulo", () => this.convertSelectionToShape("rectangle"));
			action("circle", "Convertir en elipse", () => this.convertSelectionToShape("ellipse"));
			if (this.selectionLink()) action("external-link", "Abrir vínculo", () => void this.openSelectionLink());
		}
		menu.createDiv({ cls: "inkpad-menu-divider" });
		action("pen-tool", "Pluma", () => { this.tool = "pen"; this.refreshToolbar(); }, this.tool === "pen");
		action("pencil-ruler", "Lápiz", () => { this.tool = "pencil"; this.refreshToolbar(); }, this.tool === "pencil");
		action("paintbrush", "Rotulador", () => { this.tool = "marker"; this.refreshToolbar(); }, this.tool === "marker");
		action("highlighter", "Subrayador", () => { this.tool = "highlighter"; this.refreshToolbar(); }, this.tool === "highlighter");
		action("eraser", "Borrador", () => { this.tool = "eraser"; this.refreshToolbar(); }, this.tool === "eraser");
		action("lasso-select", "Lazo", () => { this.tool = "lasso"; this.refreshToolbar(); }, this.tool === "lasso");
		menu.createDiv({ cls: "inkpad-menu-divider" });
		action("minus", "Línea", () => { this.tool = "line"; this.refreshToolbar(); }, this.tool === "line");
		action("move-up-right", "Flecha", () => { this.tool = "arrow"; this.refreshToolbar(); }, this.tool === "arrow");
		action("square", "Rectángulo", () => { this.tool = "rectangle"; this.refreshToolbar(); }, this.tool === "rectangle");
		action("circle", "Elipse", () => { this.tool = "ellipse"; this.refreshToolbar(); }, this.tool === "ellipse");
		const viewport = this.viewportEl.getBoundingClientRect();
		const localX = clientX === undefined ? 12 : clientX - viewport.left;
		const localY = clientY === undefined ? 12 : clientY - viewport.top;
		menu.style.left = `${Math.max(8, Math.min(localX, viewport.width - 180))}px`;
		menu.style.top = `${Math.max(8, Math.min(localY, viewport.height - 190))}px`;
		this.quickMenu = menu;
	}

	private closeQuickMenu(): void {
		const menu = this.quickMenu; if (!menu) return;
		this.quickMenu = null; menu.addClass("is-closing"); window.setTimeout(() => menu.remove(), 150);
	}

	private closePopover(kind: "ink" | "bookmark"): void {
		const menu = kind === "ink" ? this.inkMenu : this.bookmarkMenu; if (!menu) return;
		if (kind === "ink") this.inkMenu = null; else this.bookmarkMenu = null;
		menu.addClass("is-closing"); window.setTimeout(() => menu.remove(), 150);
	}

	private toggleInkMenu(parent: HTMLElement): void {
		if (this.inkMenu) { this.closePopover("ink"); return; }
		this.closePopover("bookmark");
		const menu = parent.createDiv({ cls: "inkpad-bottom-menu inkpad-ink-menu" }); this.inkMenu = menu;
		const swatches = menu.createDiv({ cls: "inkpad-swatch-row" });
		const picker = swatches.createEl("button", { cls: "inkpad-color-picker", attr: { "aria-label": "Elegir color personalizado" } });
		picker.style.background = this.color;
		const color = menu.createEl("input", { cls: "inkpad-color-native", type: "color", value: this.color, attr: { "aria-label": "Color personalizado" } });
		color.addEventListener("input", () => { this.color = color.value; this.refreshInkMenu(menu, color); });
		picker.addEventListener("click", () => color.click());
		for (const value of ["#ffffff", "#111827", "#ef4444", "#2563eb", "#16a34a", "#f59e0b"]) { const swatch = swatches.createEl("button", { cls: "inkpad-swatch", attr: { "aria-label": `Color ${value}`, "data-color": value } }); swatch.style.background = value; swatch.addEventListener("click", () => { this.color = value; color.value = value; this.refreshInkMenu(menu, color); }); }
		const widthRow = menu.createDiv({ cls: "inkpad-width-row" }); widthRow.createSpan({ text: "Grosor" }); const width = widthRow.createDiv({ cls: "inkpad-width-control", attr: { role: "slider", "aria-label": "Grosor", "aria-valuemin": "1", "aria-valuemax": "16", "aria-valuenow": String(this.width), tabindex: "0" } }); const thumb = width.createDiv({ cls: "inkpad-width-thumb" }); const label = widthRow.createSpan({ cls: "inkpad-width-label", text: `${this.width}px` });
		const setWidthFromPointer = (clientX: number): void => { const rect = width.getBoundingClientRect(); const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width))); this.width = Math.round(1 + ratio * 15); thumb.style.left = `${((this.width - 1) / 15) * 100}%`; width.setAttr("aria-valuenow", String(this.width)); label.setText(`${this.width}px`); };
		thumb.style.left = `${((this.width - 1) / 15) * 100}%`;
		width.addEventListener("pointerdown", event => { event.preventDefault(); width.setPointerCapture(event.pointerId); setWidthFromPointer(event.clientX); });
		width.addEventListener("pointermove", event => { if (width.hasPointerCapture(event.pointerId)) setWidthFromPointer(event.clientX); });
		width.addEventListener("pointerup", event => { if (width.hasPointerCapture(event.pointerId)) width.releasePointerCapture(event.pointerId); });
		this.refreshInkMenu(menu, color);
	}

	private refreshInkMenu(menu: HTMLElement, color: HTMLInputElement): void { menu.querySelectorAll<HTMLButtonElement>(".inkpad-swatch").forEach(swatch => swatch.setAttr("aria-pressed", String(swatch.dataset.color === this.color))); const picker = menu.querySelector<HTMLButtonElement>(".inkpad-color-picker"); if (picker) picker.style.background = this.color; color.value = this.color; }

	private toggleBookmarkMenu(parent: HTMLElement): void {
		if (this.bookmarkMenu) { this.closePopover("bookmark"); return; }
		this.closePopover("ink"); const menu = parent.createDiv({ cls: "inkpad-bottom-menu inkpad-bookmark-menu" }); this.bookmarkMenu = menu;
		const add = menu.createEl("button", { cls: "inkpad-bookmark-add" }); setIcon(add, "bookmark-plus"); add.createSpan({ text: "Guardar posición actual" }); add.addEventListener("click", () => { this.addBookmark(); this.closePopover("bookmark"); });
		for (const bookmark of this.document.bookmarks ?? []) { const row = menu.createDiv({ cls: "inkpad-bookmark-row" }); const go = row.createEl("button", { text: bookmark.name }); go.addEventListener("click", () => { this.goToBookmark(bookmark.id); this.closePopover("bookmark"); }); const remove = row.createEl("button", { cls: "inkpad-bookmark-delete", attr: { "aria-label": `Eliminar ${bookmark.name}` } }); setIcon(remove, "trash-2"); remove.addEventListener("click", () => this.deleteBookmark(bookmark.id)); }
	}

	private addBookmark(): void {
		const name = window.prompt("Nombre del marcador", `Vista ${((this.document.bookmarks?.length ?? 0) + 1)}`)?.trim();
		if (!name) return;
		this.snapshot();
		this.document.bookmarks = [...(this.document.bookmarks ?? []), { id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, name, ...this.transform }];
		this.scheduleSave();
	}

	private goToBookmark(id: string): void {
		const bookmark = this.document.bookmarks?.find(item => item.id === id);
		if (!bookmark) return;
		this.transform = { x: bookmark.x, y: bookmark.y, zoom: bookmark.zoom };
		this.render(); this.scheduleSave();
	}

	private deleteBookmark(id: string): void {
		if (!this.document.bookmarks?.some(item => item.id === id)) return;
		this.snapshot(); this.document.bookmarks = this.document.bookmarks.filter(item => item.id !== id);
		this.scheduleSave();
		const parent = this.bookmarkMenu?.parentElement as HTMLElement | null;
		this.closePopover("bookmark"); if (parent) this.toggleBookmarkMenu(parent);
	}

	private resize(): void {
		if (!this.canvas || !this.viewportEl) return;
		const rect = this.viewportEl.getBoundingClientRect();
		this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2.5);
		this.canvas.width = Math.max(1, Math.floor(rect.width * this.pixelRatio));
		this.canvas.height = Math.max(1, Math.floor(rect.height * this.pixelRatio));
		this.canvas.style.width = `${rect.width}px`;
		this.canvas.style.height = `${rect.height}px`;
		this.context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
		this.render();
	}

	private onPointerDown = (event: PointerEvent): void => {
		// The pointer-events standard maps a pen barrel button to button/buttons 2.
		// iPadOS keeps Apple Pencil double-tap and Pro squeeze in the native API, so a
		// WebView plugin cannot receive those gestures directly. This is the standards-
		// based equivalent for styluses that expose a side button to the WebView.
		if (event.pointerType === "pen" && (event.button === 2 || (event.buttons & 2) !== 0)) {
			event.preventDefault();
			this.openQuickMenu(event.clientX, event.clientY);
			return;
		}
		event.preventDefault();
		this.canvas.focus({ preventScroll: true });
		this.closeQuickMenu();
		this.canvas.setPointerCapture(event.pointerId);
		this.pointers.set(event.pointerId, event);
		if (event.pointerType === "mouse" && event.button === 1) {
			this.activePointer = null;
			this.panPointer = event.pointerId;
			this.panStart = { x: event.clientX, y: event.clientY, transform: { ...this.transform } };
			return;
		}
		if (this.pointers.size >= 2 || event.pointerType === "touch") {
			this.activePointer = null;
			if (this.pointers.size >= 2) this.beginPinch();
			else { this.panPointer = event.pointerId; this.panStart = { x: event.clientX, y: event.clientY, transform: { ...this.transform } }; }
			return;
		}
		this.activePointer = event.pointerId;
		const first = this.toPoint(event);
		if (this.tool === "lasso") {
			if (this.pointInSelection(first)) {
				this.snapshot();
				this.selectionMove = {
					start: first,
					strokes: this.document.strokes.filter(stroke => this.selectedStrokeIds.has(stroke.id)).map(stroke => ({ ...stroke, points: stroke.points.map(point => ({ ...point })) })),
					shapes: this.document.shapes.filter(shape => this.selectedShapeIds.has(shape.id)).map(shape => ({ ...shape, start: { ...shape.start }, end: { ...shape.end } })),
				};
				return;
			}
			this.selectedStrokeIds.clear();
			this.selectedShapeIds.clear();
			this.lassoPoints = [first];
			this.render();
			return;
		}
		if (this.isShapeTool()) {
			this.snapshotForInkAppend();
			this.activeShape = { id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, type: this.tool as InkShape["type"], color: this.color, width: this.width, start: first, end: first };
			this.document.shapes.push(this.activeShape);
			this.render();
			return;
		}
		if (this.tool === "eraser") {
			this.snapshot();
			this.eraseAt(first);
			return;
		}
		this.snapshotForInkAppend();
		this.activeStroke = { id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, tool: this.tool, color: this.color, width: this.width, points: [first] };
		this.document.strokes.push(this.activeStroke);
		// Do not replay the whole drawing just to show the first mouse/Pencil dot.
		this.drawSegment(this.activeStroke, first, first);
	};

	private onKeyDown = (event: KeyboardEvent): void => {
		if (event.metaKey || event.ctrlKey) {
			if (event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? this.redo() : this.undo(); }
			else if (event.key.toLowerCase() === "y") { event.preventDefault(); this.redo(); }
			return;
		}
		const key = event.key.toLowerCase();
		if (key === "p") this.tool = "pen";
		else if (key === "b") this.tool = "pencil";
		else if (key === "m") this.tool = "marker";
		else if (key === "h") this.tool = "highlighter";
		else if (key === "e") this.tool = "eraser";
		else if (key === "l") this.tool = "lasso";
		else if (key === "f") { event.preventDefault(); this.frameContent(); return; }
		else if (key === "0") { event.preventDefault(); this.resetZoom(); return; }
		else return;
		event.preventDefault(); this.refreshToolbar();
	};

	private onPointerMove = (event: PointerEvent): void => {
		if (!this.pointers.has(event.pointerId)) return;
		event.preventDefault();
		this.pointers.set(event.pointerId, event);
		if (this.pinchStart && this.pointers.size >= 2) { this.updatePinch(); return; }
		if (this.activePointer === event.pointerId && this.selectionMove) {
			const point = this.toPoint(event);
			const dx = point.x - this.selectionMove.start.x; const dy = point.y - this.selectionMove.start.y;
			for (const original of this.selectionMove.strokes) {
				const stroke = this.document.strokes.find(item => item.id === original.id);
				if (stroke) stroke.points = original.points.map(item => ({ ...item, x: item.x + dx, y: item.y + dy }));
			}
			for (const original of this.selectionMove.shapes) {
				const shape = this.document.shapes.find(item => item.id === original.id);
				if (shape) { shape.start = { x: original.start.x + dx, y: original.start.y + dy }; shape.end = { x: original.end.x + dx, y: original.end.y + dy }; }
			}
			this.render(); return;
		}
		if (this.activePointer === event.pointerId && this.lassoPoints.length) { this.lassoPoints.push(this.toPoint(event)); this.render(); return; }
		if (this.activePointer === event.pointerId && this.activeShape) { this.activeShape.end = this.toPoint(event); this.render(); return; }
		if (this.activePointer === event.pointerId && this.tool === "eraser") {
			const samples = "getCoalescedEvents" in event ? event.getCoalescedEvents() : [event];
			let changed = false;
			for (const sample of samples) changed = this.eraseAt(this.toPoint(sample), false) || changed;
			if (changed) this.render();
			return;
		}
		if (this.activePointer === event.pointerId && this.activeStroke) {
			const samples = "getCoalescedEvents" in event ? event.getCoalescedEvents() : [event];
			let first: InkPoint | null = null;
			const added: InkPoint[] = [];
			for (const sample of samples) {
				const before = this.activeStroke.points.at(-1);
				const point = this.toPoint(sample);
				if (this.appendPoint(this.activeStroke, point) && before) { first ??= before; added.push(point); }
			}
			if (first && added.length) {
				if (event.pointerType === "mouse") this.queueMouseInk(this.activeStroke, first, added);
				else this.drawCoalescedSegment(this.activeStroke, first, added);
			}
			return;
		}
		if (this.panStart && this.panPointer === event.pointerId) {
			this.transform.x = this.panStart.transform.x + (event.clientX - this.panStart.x);
			this.transform.y = this.panStart.transform.y + (event.clientY - this.panStart.y);
			this.requestNavigationRender();
		}
	};

	private onPointerUp = (event: PointerEvent): void => {
		if (!this.pointers.has(event.pointerId)) return;
		event.preventDefault();
		const wasNavigating = event.pointerId === this.panPointer || this.pinchStart !== null;
		this.pointers.delete(event.pointerId);
		if (event.pointerId === this.panPointer) this.panPointer = null;
		if (event.pointerId === this.activePointer && this.selectionMove) {
			this.selectionMove = null; this.activePointer = null; this.invalidateInkCache(); this.scheduleSave();
		} else if (event.pointerId === this.activePointer && this.lassoPoints.length) {
			this.lassoPoints.push(this.toPoint(event));
			this.selectLasso(); this.lassoPoints = []; this.activePointer = null; this.render();
		} else if (event.pointerId === this.activePointer && this.activeShape) {
			this.activeShape.end = this.toPoint(event);
			const completedShape = this.activeShape;
			this.activeShape = null; this.activePointer = null;
			if (!this.commitInkToCache(undefined, completedShape)) this.invalidateInkCache();
			this.render(); this.scheduleSave();
		} else if (event.pointerId === this.activePointer && this.tool === "eraser") {
			this.eraseAt(this.toPoint(event));
			this.activePointer = null;
			this.invalidateInkCache(); this.scheduleSave();
		} else if (event.pointerId === this.activePointer && this.activeStroke) {
			this.flushMouseInk();
			const before = this.activeStroke.points.at(-1);
			const point = this.toPoint(event);
			if (this.appendPoint(this.activeStroke, point) && before) this.drawSegment(this.activeStroke, before, point);
			const completedStroke = this.activeStroke;
			this.activeStroke = null;
			this.activePointer = null;
			if (!this.commitInkToCache(completedStroke)) this.invalidateInkCache();
			this.scheduleSave();
		}
		if (this.pointers.size < 2) {
			this.pinchStart = null;
			const remaining = this.pointers.values().next().value as PointerEvent | undefined;
			if (remaining?.pointerType === "touch") {
				this.panPointer = remaining.pointerId;
				this.panStart = { x: remaining.clientX, y: remaining.clientY, transform: { ...this.transform } };
			} else this.panStart = null;
		}
		if (wasNavigating) this.scheduleSave();
	};

	private beginPinch(): void {
		const pair = [...this.pointers.values()].filter(pointer => pointer.pointerType === "touch").slice(0, 2);
		if (pair.length !== 2) return;
		const [first, second] = pair as [PointerEvent, PointerEvent];
		const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
		if (!distance) return;
		this.panStart = null;
		this.panPointer = null;
		this.pinchStart = { distance, centerX: (first.clientX + second.clientX) / 2, centerY: (first.clientY + second.clientY) / 2, transform: { ...this.transform } };
	}

	private updatePinch(): void {
		const start = this.pinchStart;
		const pair = [...this.pointers.values()].filter(pointer => pointer.pointerType === "touch").slice(0, 2);
		if (!start || pair.length !== 2) return;
		const [first, second] = pair as [PointerEvent, PointerEvent];
		const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
		const centerX = (first.clientX + second.clientX) / 2;
		const centerY = (first.clientY + second.clientY) / 2;
		const rect = this.canvas.getBoundingClientRect();
		const initialX = start.centerX - rect.left;
		const initialY = start.centerY - rect.top;
		const currentX = centerX - rect.left;
		const currentY = centerY - rect.top;
		const zoom = Math.min(6, Math.max(0.15, start.transform.zoom * distance / start.distance));
		const worldX = (initialX - start.transform.x) / start.transform.zoom;
		const worldY = (initialY - start.transform.y) / start.transform.zoom;
		this.transform = { x: currentX - worldX * zoom, y: currentY - worldY * zoom, zoom };
		this.requestNavigationRender();
	}

	private onWheel = (event: WheelEvent): void => {
		event.preventDefault();
		const rect = this.canvas.getBoundingClientRect();
		const factor = Math.exp(-event.deltaY * 0.0015);
		const zoom = Math.min(6, Math.max(0.15, this.transform.zoom * factor));
		const mx = event.clientX - rect.left;
		const my = event.clientY - rect.top;
		this.transform.x = mx - (mx - this.transform.x) * (zoom / this.transform.zoom);
		this.transform.y = my - (my - this.transform.y) * (zoom / this.transform.zoom);
		this.transform.zoom = zoom;
		this.requestNavigationRender();
		this.scheduleSave();
	};

	/** Coalesces high-rate wheel, trackpad and middle-button updates into display frames. */
	private requestNavigationRender(): void {
		if (this.navigationRenderFrame !== null) return;
		this.navigationRenderFrame = requestAnimationFrame(() => {
			this.navigationRenderFrame = null;
			this.render();
		});
	}

	/** Mouse hardware can emit hundreds of packets per frame; paint them once per frame. */
	private queueMouseInk(stroke: InkStroke, first: InkPoint, points: InkPoint[]): void {
		const pending = this.pendingMouseInk;
		if (pending && pending.stroke === stroke) pending.points.push(...points);
		else this.pendingMouseInk = { stroke, first, points: [...points] };
		if (this.mouseInkFrame !== null) return;
		this.mouseInkFrame = requestAnimationFrame(() => {
			this.mouseInkFrame = null;
			this.flushMouseInk();
		});
	}

	private flushMouseInk(): void {
		const pending = this.pendingMouseInk;
		this.pendingMouseInk = null;
		if (pending?.points.length) this.drawCoalescedSegment(pending.stroke, pending.first, pending.points);
	}

	private appendPoint(stroke: InkStroke, point: InkPoint): boolean {
		const previous = stroke.points.at(-1);
		// Keep the Pencil's high-frequency samples: they are what lets the curve
		// renderer remove angular corners without adding latency.  We only discard
		// effectively identical coordinates, not visible movement.
		const minimumDistance = 0.15 / this.transform.zoom;
		if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > minimumDistance) {
			// Pointer pressure is deliberately a little noisy, even for a steady hand.
			// A low-pass filter gives ink a stable Notes-like width while preserving
			// intentional pressure changes over several Pencil samples.
			const rawPressure = Math.max(0.2, Math.min(0.9, point.p));
			point.p = previous ? previous.p + (rawPressure - previous.p) * 0.18 : rawPressure;
			stroke.points.push(point);
			return true;
		}
		return false;
	}

	private toPoint(event: PointerEvent): InkPoint {
		const rect = this.canvas.getBoundingClientRect();
		return { x: (event.clientX - rect.left - this.transform.x) / this.transform.zoom, y: (event.clientY - rect.top - this.transform.y) / this.transform.zoom, p: event.pressure > 0 ? event.pressure : 0.5, t: event.timeStamp };
	}

	private render(): void {
		if (!this.context || !this.canvas) return;
		const rect = this.canvas.getBoundingClientRect();
		this.context.clearRect(0, 0, rect.width, rect.height);
		this.drawGrid(rect.width, rect.height);
		if (this.selectionMove) this.drawInkDirect();
		else if (!this.drawInkCache(rect)) this.rebuildInkCache(rect);
		this.drawActiveInk();
		this.drawLasso();
		this.drawSelection();
		this.positionElements();
		this.updateViewportHud();
	}

	/**
	 * Panning must not replay an entire lecture.  The cache is a slightly oversized
	 * raster of the current view; while it covers the screen, navigation costs one
	 * drawImage instead of one path replay per stroke.
	 */
	private drawInkCache(rect: DOMRect): boolean {
		const cache = this.inkRenderCache;
		if (!cache || this.inkCacheDirty || cache.width !== Math.ceil(rect.width) || cache.height !== Math.ceil(rect.height)) return false;
		const scale = this.transform.zoom / cache.transform.zoom;
		if (scale < .72 || scale > 1.38) return false;
		const left = this.transform.x - scale * cache.transform.x - scale * cache.padding;
		const top = this.transform.y - scale * cache.transform.y - scale * cache.padding;
		const width = (cache.width + cache.padding * 2) * scale;
		const height = (cache.height + cache.padding * 2) * scale;
		if (left > 0 || top > 0 || left + width < rect.width || top + height < rect.height) return false;
		this.context.drawImage(cache.canvas, left, top, width, height);
		return true;
	}

	private rebuildInkCache(rect: DOMRect): void {
		const width = Math.max(1, Math.ceil(rect.width)); const height = Math.max(1, Math.ceil(rect.height));
		const padding = Math.max(180, Math.min(360, Math.round(Math.max(width, height) * .28)));
		// A high-DPI desktop cache with overscan can exceed 100 MB.  Windows is
		// happiest with a 1x navigation bitmap; final ink remains vector sharp.
		const cachePixelRatio = /Windows/i.test(navigator.userAgent) ? 1 : this.pixelRatio;
		const cacheCanvas = document.createElement("canvas");
		cacheCanvas.width = Math.ceil((width + padding * 2) * cachePixelRatio);
		cacheCanvas.height = Math.ceil((height + padding * 2) * cachePixelRatio);
		const cacheContext = cacheCanvas.getContext("2d", { alpha: true, desynchronized: true });
		if (!cacheContext) { this.drawInkDirect(); return; }
		const visibleContext = this.context;
		try {
			this.context = cacheContext;
			cacheContext.setTransform(cachePixelRatio, 0, 0, cachePixelRatio, 0, 0);
			cacheContext.translate(padding + this.transform.x, padding + this.transform.y);
			cacheContext.scale(this.transform.zoom, this.transform.zoom);
			for (const stroke of this.document.strokes) if (stroke !== this.activeStroke) this.drawStroke(stroke);
			for (const shape of this.document.shapes) if (shape !== this.activeShape) this.drawShape(shape);
		} finally { this.context = visibleContext; }
		this.inkRenderCache = { canvas: cacheCanvas, width, height, padding, pixelRatio: cachePixelRatio, transform: { ...this.transform } };
		this.inkCacheDirty = false;
		this.context.drawImage(cacheCanvas, -padding, -padding, width + padding * 2, height + padding * 2);
	}

	private drawInkDirect(): void {
		this.context.save();
		this.context.translate(this.transform.x, this.transform.y);
		this.context.scale(this.transform.zoom, this.transform.zoom);
		for (const stroke of this.document.strokes) this.drawStroke(stroke);
		for (const shape of this.document.shapes) this.drawShape(shape);
		this.context.restore();
	}

	/** Active ink stays vector-based above the cache, so Pencil feedback is immediate. */
	private drawActiveInk(): void {
		if (!this.activeStroke && !this.activeShape) return;
		this.context.save();
		this.context.translate(this.transform.x, this.transform.y);
		this.context.scale(this.transform.zoom, this.transform.zoom);
		if (this.activeStroke) this.drawStroke(this.activeStroke);
		if (this.activeShape) this.drawShape(this.activeShape);
		this.context.restore();
	}

	private invalidateInkCache(): void { this.inkCacheDirty = true; }

	/** Adds completed ink to an unchanged cache so the next mouse/Pencil contact never rebuilds it. */
	private commitInkToCache(stroke?: InkStroke, shape?: InkShape): boolean {
		const cache = this.inkRenderCache;
		if (!cache || this.inkCacheDirty || cache.transform.x !== this.transform.x || cache.transform.y !== this.transform.y || cache.transform.zoom !== this.transform.zoom) return false;
		const cacheContext = cache.canvas.getContext("2d", { alpha: true, desynchronized: true });
		if (!cacheContext) return false;
		const visibleContext = this.context;
		try {
			this.context = cacheContext;
			cacheContext.setTransform(cache.pixelRatio, 0, 0, cache.pixelRatio, 0, 0);
			cacheContext.translate(cache.padding + cache.transform.x, cache.padding + cache.transform.y);
			cacheContext.scale(cache.transform.zoom, cache.transform.zoom);
			if (stroke) this.drawStroke(stroke);
			if (shape) this.drawShape(shape);
		} finally { this.context = visibleContext; }
		return true;
	}

	/** Restores a readable 1:1 scale without moving the current document location. */
	public resetZoom(): void {
		const rect = this.canvas.getBoundingClientRect();
		const worldX = (rect.width / 2 - this.transform.x) / this.transform.zoom;
		const worldY = (rect.height / 2 - this.transform.y) / this.transform.zoom;
		this.transform = { x: rect.width / 2 - worldX, y: rect.height / 2 - worldY, zoom: 1 };
		this.render(); this.scheduleSave();
	}

	/** Places every piece of ink and every imported item comfortably in view. */
	public frameContent(): void {
		const bounds = this.contentBounds();
		if (!bounds) { new Notice("Aún no hay contenido que encuadrar."); return; }
		const rect = this.canvas.getBoundingClientRect();
		const padding = 56;
		const zoom = Math.min(3, Math.max(0.15, Math.min((rect.width - padding * 2) / bounds.width, (rect.height - padding * 2) / bounds.height)));
		this.transform = { x: (rect.width - bounds.width * zoom) / 2 - bounds.left * zoom, y: (rect.height - bounds.height * zoom) / 2 - bounds.top * zoom, zoom };
		this.render(); this.scheduleSave();
	}

	private contentBounds(): { left: number; top: number; width: number; height: number } | null {
		let bounds: { left: number; top: number; right: number; bottom: number } | null = null;
		for (const stroke of this.document.strokes) bounds = this.mergeBounds(bounds, this.boundsOf(stroke.points));
		for (const shape of this.document.shapes) bounds = this.mergeBounds(bounds, this.boundsOf([shape.start, shape.end]));
		for (const element of this.document.elements) bounds = this.mergeBounds(bounds, this.boundsOf([{ x: element.x, y: element.y }, { x: element.x + element.width, y: element.y + element.height }]));
		return bounds ? { left: bounds.left, top: bounds.top, width: Math.max(1, bounds.right - bounds.left), height: Math.max(1, bounds.bottom - bounds.top) } : null;
	}

	/** Iterative bounds avoid passing a long lecture's worth of points as function arguments. */
	private boundsOf(points: Iterable<Pick<InkPoint, "x" | "y">>): { left: number; top: number; right: number; bottom: number } | null {
		let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
		for (const point of points) { if (point.x < left) left = point.x; if (point.x > right) right = point.x; if (point.y < top) top = point.y; if (point.y > bottom) bottom = point.y; }
		return left === Infinity ? null : { left, top, right, bottom };
	}

	private mergeBounds(base: { left: number; top: number; right: number; bottom: number } | null, next: { left: number; top: number; right: number; bottom: number } | null): { left: number; top: number; right: number; bottom: number } | null {
		if (!base) return next; if (!next) return base;
		return { left: Math.min(base.left, next.left), top: Math.min(base.top, next.top), right: Math.max(base.right, next.right), bottom: Math.max(base.bottom, next.bottom) };
	}

	private updateViewportHud(): void { if (this.zoomReadout) this.zoomReadout.setText(`${Math.round(this.transform.zoom * 100)}%`); }
	private setSaveState(text: string): void { this.saveReadout?.setText(text); }
	private toggleFocusMode(): void { this.focusMode = !this.focusMode; this.containerEl.toggleClass("inkpad-focus-mode", this.focusMode); }

	private insertFile(file: TFile): void {
		const viewport = this.viewportEl.getBoundingClientRect();
		const extension = file.extension.toLowerCase();
		const kind = extension === "pdf" ? "pdf" : ["png", "jpg", "jpeg", "webp", "gif"].includes(extension) ? "image" : ["mp3", "m4a", "wav", "ogg"].includes(extension) ? "audio" : "markdown";
		const element: InkElement = {
			id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
			path: file.path,
			kind,
			x: (viewport.width / 2 - this.transform.x) / this.transform.zoom,
			y: (viewport.height / 2 - this.transform.y) / this.transform.zoom,
			width: kind === "pdf" ? 560 : kind === "image" ? 480 : 440,
			height: kind === "pdf" ? 720 : kind === "audio" ? 100 : 360,
		};
		this.snapshot();
		this.document.elements.push(element);
		void this.renderElements();
		this.scheduleSave();
	}

	private insertText(): void {
		const text = window.prompt("Texto para el lienzo");
		if (!text?.trim()) return;
		const viewport = this.viewportEl.getBoundingClientRect();
		this.snapshot();
		this.document.elements.push({ id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, path: "", kind: "text", text, x: (viewport.width / 2 - this.transform.x) / this.transform.zoom, y: (viewport.height / 2 - this.transform.y) / this.transform.zoom, width: 320, height: 100 });
		void this.renderElements(); this.scheduleSave();
	}

	private editTextElement(id: string): void {
		const element = this.document.elements.find(item => item.id === id);
		if (!element || element.kind !== "text") return;
		const text = window.prompt("Texto para el lienzo", element.text ?? "");
		if (text === null || text === element.text) return;
		this.snapshot();
		element.text = text;
		void this.renderElements(); this.scheduleSave();
	}

	private async renderElements(): Promise<void> {
		if (!this.elementLayer) return;
		const generation = ++this.elementRenderGeneration;
		this.elementLayer.empty();
		for (const element of this.document.elements) {
			const card = this.elementLayer.createDiv({ cls: "inkpad-element", attr: { "data-element-id": element.id } });
			if (element.kind === "image") card.addClass("inkpad-element-image");
			if (element.kind === "text") {
				const header = card.createDiv({ cls: "inkpad-element-header" });
				const edit = header.createEl("button", { cls: "inkpad-element-action", attr: { "aria-label": "Editar texto" } }); setIcon(edit, "pencil"); edit.addEventListener("click", () => this.editTextElement(element.id));
				const lock = header.createEl("button", { cls: "inkpad-element-action", attr: { "aria-label": element.locked ? "Desbloquear texto" : "Bloquear texto" } }); setIcon(lock, element.locked ? "lock" : "unlock"); lock.addEventListener("click", () => this.toggleElementLock(element.id));
				const remove = header.createEl("button", { cls: "inkpad-element-action inkpad-element-delete", attr: { "aria-label": "Eliminar texto" } }); setIcon(remove, "trash-2"); remove.addEventListener("click", () => this.removeElement(element.id));
				header.addEventListener("pointerdown", event => { if (!element.locked && !(event.target as HTMLElement).closest("button")) this.startElementGesture(event, element, "move", header); });
				card.createDiv({ cls: "inkpad-element-text", text: element.text ?? "" });
				if (!element.locked) { const resize = card.createDiv({ cls: "inkpad-element-resize" }); resize.addEventListener("pointerdown", event => this.startElementGesture(event, element, "resize", resize)); }
				continue;
			}
			const header = card.createDiv({ cls: "inkpad-element-header" });
			if (element.kind === "pdf") {
				const pages = header.createEl("button", { cls: "inkpad-element-action", attr: { "aria-label": "Alternar altura por páginas" } }); setIcon(pages, "unfold-vertical");
				pages.toggleClass("is-active", element.fitPdfPages === true);
				pages.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.togglePdfPageHeight(element.id); });
			}
			const front = header.createEl("button", { cls: "inkpad-element-action", attr: { "aria-label": "Traer al frente" } }); setIcon(front, "bring-to-front");
			front.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.bringElementToFront(element.id); });
			const back = header.createEl("button", { cls: "inkpad-element-action", attr: { "aria-label": "Enviar al fondo" } }); setIcon(back, "send-to-back");
			back.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.sendElementToBack(element.id); });
			const lock = header.createEl("button", { cls: "inkpad-element-action", attr: { "aria-label": element.locked ? "Desbloquear elemento" : "Bloquear elemento" } }); setIcon(lock, element.locked ? "lock" : "unlock");
			lock.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.toggleElementLock(element.id); });
			const remove = header.createEl("button", { cls: "inkpad-element-action inkpad-element-delete", attr: { "aria-label": "Eliminar del lienzo" } }); setIcon(remove, "trash-2");
			remove.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.removeElement(element.id); });
			header.addEventListener("pointerdown", event => {
				if ((event.target as HTMLElement).closest("button")) return;
				if (!element.locked) this.startElementGesture(event, element, "move", header);
			});
			const source = this.app.vault.getAbstractFileByPath(element.path);
			if (!(source instanceof TFile)) {
				card.createDiv({ cls: "inkpad-element-missing", text: `Archivo no encontrado: ${element.path}` });
				continue;
			}
			const body = card.createDiv({ cls: "inkpad-element-body" });
			if (element.kind === "pdf") {
				body.addClass("inkpad-pdf-body");
				await this.renderPdfCanvases(body, source, element, generation);
			} else if (element.kind === "image") {
				body.addClass("inkpad-media-body");
				const image = body.createEl("img", { attr: { src: this.app.vault.getResourcePath(source), alt: source.basename } });
				image.addEventListener("load", () => this.syncImageAspect(element.id, image.naturalWidth / image.naturalHeight));
			} else if (element.kind === "audio") {
				body.createEl("audio", { attr: { src: this.app.vault.getResourcePath(source), controls: "true" } });
			} else {
				try { await MarkdownRenderer.renderMarkdown(await this.app.vault.cachedRead(source), body, source.path, this); }
				catch { body.setText("No se pudo previsualizar esta nota."); }
			}
			if (!element.locked) { const resize = card.createDiv({ cls: "inkpad-element-resize", attr: { "aria-label": "Cambiar tamaño" } }); resize.addEventListener("pointerdown", event => this.startElementGesture(event, element, "resize", resize)); }
			if (generation !== this.elementRenderGeneration) return;
		}
		this.positionElements();
	}

	private positionElements(): void {
		if (!this.elementLayer) return;
		for (const element of this.document.elements) {
			const card = this.elementLayer.querySelector<HTMLElement>(`[data-element-id="${element.id}"]`);
			if (!card) continue;
			card.style.left = `${this.transform.x + element.x * this.transform.zoom}px`;
			card.style.top = `${this.transform.y + element.y * this.transform.zoom}px`;
			card.style.width = `${element.width * this.transform.zoom}px`;
			card.style.height = `${element.height * this.transform.zoom}px`;
		}
	}

	private async renderPdfCanvases(body: HTMLElement, file: TFile, element: InkElement, generation: number): Promise<void> {
		const loading = body.createDiv({ cls: "inkpad-pdf-loading", text: "Cargando PDF…" });
		try {
			const info = await renderPdfPages(this.app.vault, file, body, element.width, element.fitPdfPages === true, () => generation === this.elementRenderGeneration);
			loading.remove();
			if (generation !== this.elementRenderGeneration) return;
			const changed = element.pageCount !== info.pageCount || element.pageAspect !== info.pageAspect;
			element.pageCount = info.pageCount;
			element.pageAspect = info.pageAspect;
			if (element.fitPdfPages) element.height = Math.max(160, info.pageCount * element.width * info.pageAspect + 30);
			this.positionElements();
			if (changed) this.scheduleSave();
		} catch (error) {
			loading.setText("No se pudo cargar este PDF.");
			console.error("Inkpad PDF render error", error);
		}
	}

	private startElementGesture(event: PointerEvent, element: InkElement, mode: "move" | "resize", target: HTMLElement): void {
		event.preventDefault(); event.stopPropagation();
		this.snapshot();
		target.setPointerCapture(event.pointerId);
		this.elementGesture = { id: element.id, pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY, startX: element.x, startY: element.y, startWidth: element.width, startHeight: element.height, mode };
		const move = (moveEvent: PointerEvent): void => this.moveElementGesture(moveEvent);
		const end = (endEvent: PointerEvent): void => {
			if (endEvent.pointerId !== event.pointerId) return;
			target.removeEventListener("pointermove", move);
			target.removeEventListener("pointerup", end);
			target.removeEventListener("pointercancel", end);
			this.elementGesture = null;
			this.scheduleSave();
		};
		target.addEventListener("pointermove", move);
		target.addEventListener("pointerup", end);
		target.addEventListener("pointercancel", end);
	}

	private moveElementGesture(event: PointerEvent): void {
		const gesture = this.elementGesture;
		if (!gesture || event.pointerId !== gesture.pointerId) return;
		event.preventDefault(); event.stopPropagation();
		const element = this.document.elements.find(item => item.id === gesture.id);
		if (!element) return;
		const dx = (event.clientX - gesture.startClientX) / this.transform.zoom;
		const dy = (event.clientY - gesture.startClientY) / this.transform.zoom;
		if (gesture.mode === "move") { element.x = gesture.startX + dx; element.y = gesture.startY + dy; }
		else if (element.kind === "image") {
			const aspect = element.aspectRatio ?? gesture.startWidth / gesture.startHeight;
			const widthDelta = Math.abs(dx) >= Math.abs(dy * aspect) ? dx : dy * aspect;
			element.width = Math.max(100, gesture.startWidth + widthDelta);
			element.height = element.width / aspect;
		} else { element.width = Math.max(160, gesture.startWidth + dx); element.height = Math.max(120, gesture.startHeight + dy); element.fitPdfPages = false; }
		this.positionElements();
	}

	/** Locks image cards to their intrinsic ratio as soon as the vault resource loads. */
	private syncImageAspect(id: string, aspect: number): void {
		if (!Number.isFinite(aspect) || aspect <= 0) return;
		const element = this.document.elements.find(item => item.id === id);
		if (!element || element.kind !== "image" || element.aspectRatio === aspect) return;
		element.aspectRatio = aspect;
		element.height = element.width / aspect;
		this.positionElements();
		this.scheduleSave();
	}

	private togglePdfPageHeight(id: string): void {
		const element = this.document.elements.find(item => item.id === id);
		if (!element || element.kind !== "pdf") return;
		this.snapshot();
		element.fitPdfPages = !element.fitPdfPages;
		if (element.fitPdfPages) element.height = Math.max(160, (element.pageCount ?? 1) * element.width * (element.pageAspect ?? 1.414) + 30);
		void this.renderElements();
		this.scheduleSave();
	}

	private removeElement(id: string): void {
		this.snapshot();
		this.document.elements = this.document.elements.filter(element => element.id !== id);
		void this.renderElements();
		this.scheduleSave();
	}

	private toggleElementLock(id: string): void {
		const element = this.document.elements.find(item => item.id === id);
		if (!element) return;
		this.snapshot(); element.locked = !element.locked;
		void this.renderElements(); this.scheduleSave();
	}

	private bringElementToFront(id: string): void {
		const index = this.document.elements.findIndex(item => item.id === id);
		if (index < 0 || index === this.document.elements.length - 1) return;
		this.snapshot();
		const [element] = this.document.elements.splice(index, 1);
		if (!element) return;
		this.document.elements.push(element);
		void this.renderElements(); this.scheduleSave();
	}

	private sendElementToBack(id: string): void {
		const index = this.document.elements.findIndex(item => item.id === id);
		if (index <= 0) return;
		this.snapshot();
		const [element] = this.document.elements.splice(index, 1);
		if (!element) return;
		this.document.elements.unshift(element);
		void this.renderElements(); this.scheduleSave();
	}

	private drawGrid(width: number, height: number): void {
		if (this.plugin.settings.paperStyle === "blank") return;
		const step = 40 * this.transform.zoom;
		if (step < 14) return;
		const offsetX = ((this.transform.x % step) + step) % step;
		const offsetY = ((this.transform.y % step) + step) % step;
		this.context.save(); this.context.strokeStyle = "rgba(127, 140, 160, 0.16)"; this.context.fillStyle = "rgba(127, 140, 160, 0.22)"; this.context.lineWidth = 1;
		this.context.beginPath();
		if (this.plugin.settings.paperStyle === "dots") { for (let x = offsetX; x < width; x += step) for (let y = offsetY; y < height; y += step) { this.context.moveTo(x + 1, y); this.context.arc(x, y, 1, 0, Math.PI * 2); } this.context.fill(); }
		else if (this.plugin.settings.paperStyle === "weekly") {
			const column = 240 * this.transform.zoom; const row = 190 * this.transform.zoom;
			const weekOffsetX = ((this.transform.x % column) + column) % column;
			const weekOffsetY = ((this.transform.y % row) + row) % row;
			for (let x = weekOffsetX; x < width; x += column) { this.context.moveTo(x, 0); this.context.lineTo(x, height); }
			for (let y = weekOffsetY; y < height; y += row) { this.context.moveTo(0, y); this.context.lineTo(width, y); }
			this.context.stroke();
		} else if (this.plugin.settings.paperStyle === "music") {
			const staff = 220 * this.transform.zoom;
			const staffOffset = ((this.transform.y % staff) + staff) % staff;
			for (let y = staffOffset; y < height; y += staff) for (let line = 0; line < 5; line++) { const staffY = y + line * step; this.context.moveTo(0, staffY); this.context.lineTo(width, staffY); }
			this.context.stroke();
		} else {
			for (let x = offsetX; x < width && this.plugin.settings.paperStyle === "grid"; x += step) { this.context.moveTo(x, 0); this.context.lineTo(x, height); }
			for (let y = offsetY; y < height; y += step) { this.context.moveTo(0, y); this.context.lineTo(width, y); }
			if (this.plugin.settings.paperStyle === "cornell") { const margin = this.transform.x + 145 * this.transform.zoom; this.context.moveTo(margin, 0); this.context.lineTo(margin, height); }
			this.context.stroke();
		}
		this.context.restore();
	}

	private drawStroke(stroke: InkStroke): void {
		const points = stroke.points;
		if (!points.length) return;
		const context = this.context;
		context.save();
		context.lineCap = "round"; context.lineJoin = "round";
		context.globalCompositeOperation = "source-over";
		context.globalAlpha = this.strokeAlpha(stroke);
		context.strokeStyle = stroke.color;
		if (points.length === 1) {
			context.fillStyle = stroke.color;
			context.beginPath(); context.arc(points[0]!.x, points[0]!.y, this.strokeWidth(stroke, points[0]!) / 2, 0, Math.PI * 2); context.fill(); context.restore(); return;
		}
		context.lineWidth = this.strokeWidth(stroke, points.at(-1)!);
		this.traceSmoothInkPath(context, points);
		context.stroke();
		context.restore();
	}

	private drawShape(shape: InkShape): void {
		const context = this.context; const { start, end } = shape;
		context.save(); context.strokeStyle = shape.color; context.lineWidth = shape.width; context.lineCap = "round"; context.lineJoin = "round";
		if (shape.type === "line" || shape.type === "arrow") {
			context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(end.x, end.y); context.stroke();
			if (shape.type === "arrow") {
				const angle = Math.atan2(end.y - start.y, end.x - start.x); const size = Math.max(10, shape.width * 4);
				context.beginPath(); context.moveTo(end.x, end.y); context.lineTo(end.x - size * Math.cos(angle - Math.PI / 6), end.y - size * Math.sin(angle - Math.PI / 6)); context.moveTo(end.x, end.y); context.lineTo(end.x - size * Math.cos(angle + Math.PI / 6), end.y - size * Math.sin(angle + Math.PI / 6)); context.stroke();
			}
		} else if (shape.type === "rectangle") { context.strokeRect(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y)); }
		else { context.beginPath(); context.ellipse((start.x + end.x) / 2, (start.y + end.y) / 2, Math.abs(end.x - start.x) / 2, Math.abs(end.y - start.y) / 2, 0, 0, Math.PI * 2); context.stroke(); }
		context.restore();
	}

	private drawLasso(): void {
		if (this.lassoPoints.length < 2) return;
		const context = this.context; context.save(); context.translate(this.transform.x, this.transform.y); context.scale(this.transform.zoom, this.transform.zoom); context.strokeStyle = "#8b5cf6"; context.lineWidth = 1.5 / this.transform.zoom; context.setLineDash([5 / this.transform.zoom, 5 / this.transform.zoom]); context.beginPath(); context.moveTo(this.lassoPoints[0]!.x, this.lassoPoints[0]!.y);
		for (const point of this.lassoPoints.slice(1)) context.lineTo(point.x, point.y);
		context.stroke(); context.restore();
	}

	private selectedBounds(): { left: number; top: number; right: number; bottom: number } | null {
		let bounds: { left: number; top: number; right: number; bottom: number } | null = null;
		for (const stroke of this.document.strokes) if (this.selectedStrokeIds.has(stroke.id)) bounds = this.mergeBounds(bounds, this.boundsOf(stroke.points));
		for (const shape of this.document.shapes) if (this.selectedShapeIds.has(shape.id)) bounds = this.mergeBounds(bounds, this.boundsOf([shape.start, shape.end]));
		return bounds;
	}

	private drawSelection(): void {
		const bounds = this.selectedBounds(); if (!bounds) return;
		this.context.save(); this.context.translate(this.transform.x, this.transform.y); this.context.scale(this.transform.zoom, this.transform.zoom); this.context.strokeStyle = "#8b5cf6"; this.context.lineWidth = 1.5 / this.transform.zoom; this.context.setLineDash([6 / this.transform.zoom, 4 / this.transform.zoom]); this.context.strokeRect(bounds.left - 8, bounds.top - 8, bounds.right - bounds.left + 16, bounds.bottom - bounds.top + 16); this.context.restore();
	}

	private isShapeTool(): boolean { return this.tool === "line" || this.tool === "arrow" || this.tool === "rectangle" || this.tool === "ellipse"; }

	private pointInSelection(point: InkPoint): boolean { const b = this.selectedBounds(); return !!b && point.x >= b.left - 12 && point.x <= b.right + 12 && point.y >= b.top - 12 && point.y <= b.bottom + 12; }

	private selectLasso(): void {
		if (this.lassoPoints.length < 3) return;
		const stride = Math.max(1, Math.ceil(this.lassoPoints.length / 180));
		const polygon = this.lassoPoints.filter((_, index) => index % stride === 0 || index === this.lassoPoints.length - 1);
		const lassoBounds = this.boundsOf(polygon)!;
		const intersectsLasso = (point: Pick<InkPoint, "x" | "y">): boolean => point.x >= lassoBounds.left && point.x <= lassoBounds.right && point.y >= lassoBounds.top && point.y <= lassoBounds.bottom && this.pointInPolygon(point, polygon);
		this.selectedStrokeIds = new Set(this.document.strokes.filter(stroke => {
			const bounds = this.boundsOf(stroke.points);
			if (!bounds || bounds.right < lassoBounds.left || bounds.left > lassoBounds.right || bounds.bottom < lassoBounds.top || bounds.top > lassoBounds.bottom) return false;
			const pointStride = Math.max(1, Math.floor(stroke.points.length / 600));
			for (let index = 0; index < stroke.points.length; index += pointStride) if (intersectsLasso(stroke.points[index]!)) return true;
			return intersectsLasso(stroke.points.at(-1)!);
		}).map(stroke => stroke.id));
		this.selectedShapeIds = new Set(this.document.shapes.filter(shape => intersectsLasso(shape.start) || intersectsLasso(shape.end) || intersectsLasso({ x: (shape.start.x + shape.end.x) / 2, y: (shape.start.y + shape.end.y) / 2 })).map(shape => shape.id));
	}

	private deleteSelection(): void {
		if (!this.selectedStrokeIds.size && !this.selectedShapeIds.size) return;
		this.snapshot();
		this.document.strokes = this.document.strokes.filter(stroke => !this.selectedStrokeIds.has(stroke.id));
		this.document.shapes = this.document.shapes.filter(shape => !this.selectedShapeIds.has(shape.id));
		this.selectedStrokeIds.clear(); this.selectedShapeIds.clear(); this.invalidateInkCache(); this.render(); this.scheduleSave();
	}

	private duplicateSelection(): void {
		if (!this.selectedStrokeIds.size && !this.selectedShapeIds.size) return;
		this.snapshot();
		const offset = 24;
		const copies = this.document.strokes.filter(stroke => this.selectedStrokeIds.has(stroke.id)).map(stroke => ({ ...stroke, id: crypto.randomUUID?.() ?? `${stroke.id}-${Date.now()}`, points: stroke.points.map(point => ({ ...point, x: point.x + offset, y: point.y + offset })) }));
		const shapeCopies = this.document.shapes.filter(shape => this.selectedShapeIds.has(shape.id)).map(shape => ({ ...shape, id: crypto.randomUUID?.() ?? `${shape.id}-${Date.now()}`, start: { x: shape.start.x + offset, y: shape.start.y + offset }, end: { x: shape.end.x + offset, y: shape.end.y + offset } }));
		this.document.strokes.push(...copies); this.document.shapes.push(...shapeCopies);
		this.selectedStrokeIds = new Set(copies.map(stroke => stroke.id)); this.selectedShapeIds = new Set(shapeCopies.map(shape => shape.id));
		this.invalidateInkCache(); this.render(); this.scheduleSave();
	}

	private colorSelection(): void {
		if (!this.selectedStrokeIds.size && !this.selectedShapeIds.size) return;
		this.snapshot();
		this.document.strokes = this.document.strokes.map(stroke => this.selectedStrokeIds.has(stroke.id) ? { ...stroke, color: this.color } : stroke);
		this.document.shapes = this.document.shapes.map(shape => this.selectedShapeIds.has(shape.id) ? { ...shape, color: this.color } : shape);
		this.invalidateInkCache(); this.render(); this.scheduleSave();
	}

	private convertSelectionToShape(type: InkShape["type"]): void {
		const selected = this.document.strokes.filter(stroke => this.selectedStrokeIds.has(stroke.id));
		if (!selected.length) { new Notice("Selecciona al menos un trazo para convertirlo."); return; }
		this.snapshot();
		const shapes = selected.map(stroke => {
			const points = stroke.points;
			const bounds = this.boundsOf(points)!;
			return type === "line"
				? { id: crypto.randomUUID?.() ?? `${stroke.id}-line`, type, color: stroke.color, width: stroke.width, link: stroke.link, start: { x: points[0]!.x, y: points[0]!.y }, end: { x: points.at(-1)!.x, y: points.at(-1)!.y } }
				: { id: crypto.randomUUID?.() ?? `${stroke.id}-${type}`, type, color: stroke.color, width: stroke.width, link: stroke.link, start: { x: bounds.left, y: bounds.top }, end: { x: bounds.right, y: bounds.bottom } };
		});
		this.document.strokes = this.document.strokes.filter(stroke => !this.selectedStrokeIds.has(stroke.id));
		this.document.shapes.push(...shapes);
		this.selectedStrokeIds.clear(); this.selectedShapeIds = new Set([...this.selectedShapeIds, ...shapes.map(shape => shape.id)]);
		this.invalidateInkCache(); this.render(); this.scheduleSave();
	}

	private selectionLink(): string | null {
		const stroke = this.document.strokes.find(item => this.selectedStrokeIds.has(item.id) && item.link);
		return stroke?.link ?? this.document.shapes.find(item => this.selectedShapeIds.has(item.id) && item.link)?.link ?? null;
	}

	private linkSelection(): void {
		if (!this.selectedStrokeIds.size && !this.selectedShapeIds.size) return;
		const link = window.prompt("Ruta de nota del vault o URL", this.selectionLink() ?? "")?.trim();
		if (link === undefined) return;
		this.snapshot();
		this.document.strokes = this.document.strokes.map(stroke => this.selectedStrokeIds.has(stroke.id) ? { ...stroke, link: link || undefined } : stroke);
		this.document.shapes = this.document.shapes.map(shape => this.selectedShapeIds.has(shape.id) ? { ...shape, link: link || undefined } : shape);
		this.scheduleSave();
	}

	private async openSelectionLink(): Promise<void> {
		const link = this.selectionLink();
		if (!link) return;
		if (/^https?:\/\//i.test(link)) { window.open(link, "_blank", "noopener"); return; }
		await this.app.workspace.openLinkText(link, this.file?.path ?? "", true);
	}

	private async exportSvg(): Promise<void> {
		if (!this.file) return;
		const strokeMarkup = this.document.strokes.map(stroke => `<path d="${this.strokeSvgPath(stroke.points)}" fill="none" stroke="${stroke.color}" stroke-width="${this.strokeWidth(stroke, stroke.points.at(-1) ?? { x: 0, y: 0, p: .5, t: 0 })}" stroke-linecap="round" stroke-linejoin="round" opacity="${stroke.tool === "highlighter" ? "0.32" : "1"}"/>`).join("");
		const shapeMarkup = this.document.shapes.map(shape => {
			if (shape.type === "rectangle") return `<rect x="${Math.min(shape.start.x, shape.end.x)}" y="${Math.min(shape.start.y, shape.end.y)}" width="${Math.abs(shape.end.x - shape.start.x)}" height="${Math.abs(shape.end.y - shape.start.y)}" fill="none" stroke="${shape.color}" stroke-width="${shape.width}"/>`;
			if (shape.type === "ellipse") return `<ellipse cx="${(shape.start.x + shape.end.x) / 2}" cy="${(shape.start.y + shape.end.y) / 2}" rx="${Math.abs(shape.end.x - shape.start.x) / 2}" ry="${Math.abs(shape.end.y - shape.start.y) / 2}" fill="none" stroke="${shape.color}" stroke-width="${shape.width}"/>`;
			return `<line x1="${shape.start.x}" y1="${shape.start.y}" x2="${shape.end.x}" y2="${shape.end.y}" stroke="${shape.color}" stroke-width="${shape.width}" stroke-linecap="round"/>`;
		}).join("");
		const bounds = this.inkBounds();
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.left} ${bounds.top} ${bounds.width} ${bounds.height}">${strokeMarkup}${shapeMarkup}</svg>`;
		const path = this.nextExportPath("svg");
		await this.app.vault.create(path, svg); new Notice(`SVG exportado: ${path}`);
	}

	private strokeSvgPath(points: InkPoint[]): string {
		if (!points.length) return "";
		let path = `M ${points[0]!.x} ${points[0]!.y}`;
		for (let index = 1; index < points.length - 1; index++) {
			const control = points[index]!; const next = points[index + 1]!;
			path += ` Q ${control.x} ${control.y} ${(control.x + next.x) / 2} ${(control.y + next.y) / 2}`;
		}
		if (points.length > 1) { const last = points.at(-1)!; path += ` L ${last.x} ${last.y}`; }
		return path;
	}

	private async exportPng(): Promise<void> {
		if (!this.file) return;
		const bounds = this.inkBounds();
		const scale = 2;
		const exportCanvas = document.createElement("canvas");
		exportCanvas.width = Math.ceil(bounds.width * scale); exportCanvas.height = Math.ceil(bounds.height * scale);
		const exportContext = exportCanvas.getContext("2d");
		if (!exportContext) return;
		exportContext.scale(scale, scale); exportContext.translate(-bounds.left, -bounds.top);
		const visibleContext = this.context;
		try {
			this.context = exportContext;
			for (const stroke of this.document.strokes) this.drawStroke(stroke);
			for (const shape of this.document.shapes) this.drawShape(shape);
		} finally { this.context = visibleContext; }
		const blob = await new Promise<Blob | null>(resolve => exportCanvas.toBlob(resolve, "image/png"));
		if (!blob) { new Notice("Inkpad no pudo crear el PNG."); return; }
		await this.app.vault.createBinary(this.nextExportPath("png"), await blob.arrayBuffer());
		new Notice("PNG de tinta exportado.");
	}

	private async exportSelectionPng(): Promise<void> {
		if (!this.file) return;
		const selected = this.selectedBounds();
		if (!selected) { new Notice("Selecciona tinta o formas antes de exportar."); return; }
		const padding = 24; const width = selected.right - selected.left + padding * 2; const height = selected.bottom - selected.top + padding * 2;
		const exportCanvas = document.createElement("canvas"); const scale = 2;
		exportCanvas.width = Math.ceil(width * scale); exportCanvas.height = Math.ceil(height * scale);
		const exportContext = exportCanvas.getContext("2d"); if (!exportContext) return;
		exportContext.scale(scale, scale); exportContext.translate(-selected.left + padding, -selected.top + padding);
		const visibleContext = this.context;
		try {
			this.context = exportContext;
			for (const stroke of this.document.strokes) if (this.selectedStrokeIds.has(stroke.id)) this.drawStroke(stroke);
			for (const shape of this.document.shapes) if (this.selectedShapeIds.has(shape.id)) this.drawShape(shape);
		} finally { this.context = visibleContext; }
		const blob = await new Promise<Blob | null>(resolve => exportCanvas.toBlob(resolve, "image/png"));
		if (!blob) { new Notice("Inkpad no pudo crear el PNG de la selección."); return; }
		await this.app.vault.createBinary(this.nextExportPath("png", "selección"), await blob.arrayBuffer());
		new Notice("Selección exportada como PNG.");
	}

	private inkBounds(): { left: number; top: number; width: number; height: number } {
		let bounds: { left: number; top: number; right: number; bottom: number } | null = null;
		for (const stroke of this.document.strokes) bounds = this.mergeBounds(bounds, this.boundsOf(stroke.points));
		for (const shape of this.document.shapes) bounds = this.mergeBounds(bounds, this.boundsOf([shape.start, shape.end]));
		if (!bounds) return { left: 0, top: 0, width: 1, height: 1 };
		const padding = 24;
		const left = bounds.left - padding; const top = bounds.top - padding;
		return { left, top, width: Math.max(1, bounds.right - left + padding), height: Math.max(1, bounds.bottom - top + padding) };
	}

	private nextExportPath(extension: "svg" | "png", label = "tinta"): string {
		if (!this.file) return `Inkpad-tinta.${extension}`;
		const parent = this.file.parent?.path ? `${this.file.parent.path}/` : "";
		let path = `${parent}${this.file.basename}-${label}.${extension}`; let index = 2;
		while (this.app.vault.getAbstractFileByPath(path)) path = `${parent}${this.file.basename}-${label} ${index++}.${extension}`;
		return path;
	}

	private pointInPolygon(point: Pick<InkPoint, "x" | "y">, polygon: InkPoint[]): boolean {
		let inside = false;
		for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
			const a = polygon[index]!; const b = polygon[previous]!;
			if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
		}
		return inside;
	}

	/** Draw only the fresh segment. Full replay is reserved for resize, pan, zoom and erase. */
	private drawSegment(stroke: InkStroke, a: InkPoint, b: InkPoint): void {
		const context = this.context;
		context.save();
		context.translate(this.transform.x, this.transform.y);
		context.scale(this.transform.zoom, this.transform.zoom);
		context.lineCap = "round"; context.lineJoin = "round";
		context.globalCompositeOperation = "source-over";
		context.globalAlpha = this.strokeAlpha(stroke);
		context.strokeStyle = stroke.color;
		context.lineWidth = this.strokeWidth(stroke, b);
		context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
		context.restore();
	}

	/** Draw a browser-coalesced Pencil packet in one Canvas stroke, not N strokes. */
	private drawCoalescedSegment(stroke: InkStroke, first: InkPoint, points: InkPoint[]): void {
		const context = this.context;
		const last = points.at(-1)!;
		context.save();
		context.translate(this.transform.x, this.transform.y);
		context.scale(this.transform.zoom, this.transform.zoom);
		context.lineCap = "round"; context.lineJoin = "round";
		context.globalCompositeOperation = "source-over";
		context.globalAlpha = this.strokeAlpha(stroke);
		context.strokeStyle = stroke.color;
		context.lineWidth = this.strokeWidth(stroke, last);
		this.traceSmoothInkPath(context, [first, ...points]);
		context.stroke();
		context.restore();
	}

	/**
	 * Converts Pencil samples into midpoint quadratic curves. lineJoin="round"
	 * only rounds a corner after it exists; this removes the corner geometrically.
	 * It is one Canvas path per browser packet, so it retains the fast input path.
	 */
	private traceSmoothInkPath(context: CanvasRenderingContext2D, points: InkPoint[]): void {
		context.beginPath();
		context.moveTo(points[0]!.x, points[0]!.y);
		if (points.length === 2) {
			context.lineTo(points[1]!.x, points[1]!.y);
			return;
		}
		for (let index = 1; index < points.length - 1; index++) {
			const control = points[index]!;
			const next = points[index + 1]!;
			context.quadraticCurveTo(control.x, control.y, (control.x + next.x) / 2, (control.y + next.y) / 2);
		}
		const last = points.at(-1)!;
		context.lineTo(last.x, last.y);
	}

	private strokeWidth(stroke: InkStroke, point: InkPoint): number {
		// Tool variation is deliberately arithmetic-only: the Pencil hot path never
		// needs a texture, a filter, or an extra raster pass.
		const base = stroke.tool === "highlighter" ? stroke.width * 4 : stroke.tool === "marker" ? stroke.width * 1.7 : stroke.tool === "pencil" ? stroke.width * 0.82 : stroke.width;
		// Native note apps attenuate raw pressure substantially. A narrow range avoids
		// the saw-tooth thickness that raw PointerEvent.pressure can otherwise cause.
		if (this.plugin.settings.pressureResponse === "fixed") return base;
		if (this.plugin.settings.pressureResponse === "natural") return base * (stroke.tool === "pencil" ? 0.55 + point.p * 0.45 : 0.62 + point.p * 0.38);
		return base * (stroke.tool === "pencil" ? 0.72 + point.p * 0.28 : 0.86 + point.p * 0.14);
	}

	private strokeAlpha(stroke: InkStroke): number { return stroke.tool === "highlighter" ? 0.32 : stroke.tool === "pencil" ? 0.78 : 1; }

	/** Splits strokes around the eraser tip, preserving ink outside the erased area. */
	private eraseAt(point: InkPoint, redraw = true): boolean {
		const radius = Math.max(10, this.width * 3);
		let changed = false; const result: InkStroke[] = [];
		for (const stroke of this.document.strokes) {
			let fragment: InkPoint[] = [];
			for (const sample of stroke.points) {
				if (Math.hypot(sample.x - point.x, sample.y - point.y) > radius + stroke.width / 2) fragment.push(sample);
				else { if (fragment.length) result.push({ ...stroke, id: `${stroke.id}-${result.length}`, points: fragment }); fragment = []; changed = true; }
			}
			if (fragment.length) result.push({ ...stroke, points: fragment });
		}
		if (changed) { this.document.strokes = result; this.invalidateInkCache(); if (redraw) this.render(); }
		return changed;
	}

	private strokeTouchesCircle(stroke: InkStroke, x: number, y: number, radius: number): boolean {
		const points = stroke.points;
		if (points.length === 1) return Math.hypot(points[0]!.x - x, points[0]!.y - y) <= radius;
		for (let index = 1; index < points.length; index++) {
			const a = points[index - 1]!; const b = points[index]!;
			const dx = b.x - a.x; const dy = b.y - a.y;
			const lengthSquared = dx * dx + dy * dy;
			const projection = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared)) : 0;
			if (Math.hypot(x - (a.x + projection * dx), y - (a.y + projection * dy)) <= radius + this.strokeWidth(stroke, b) / 2) return true;
		}
		return false;
	}

	private snapshot(): void {
		this.history.push(this.cloneDocument());
		if (this.history.length > MAX_UNDO) this.history.shift();
		this.redoStack = [];
	}

	/** Appending a new stroke never mutates existing document items. */
	private snapshotForInkAppend(): void {
		this.history.push({
			...this.document,
			viewport: this.document.viewport ? { ...this.document.viewport } : undefined,
			strokes: this.document.strokes.slice(), shapes: this.document.shapes.slice(),
			elements: this.document.elements.slice(), bookmarks: this.document.bookmarks?.slice(),
		});
		if (this.history.length > MAX_UNDO) this.history.shift();
		this.redoStack = [];
	}

	/**
	 * Operations replace stroke point arrays instead of mutating existing samples.
	 * Keeping those immutable arrays by reference makes an undo snapshot O(strokes),
	 * rather than O(all pencil samples); JSON cloning a long lecture note here makes
	 * the next Pencil contact visibly stall on iPad.
	 */
	private cloneDocument(): InkDocument {
		return {
			...this.document,
			viewport: this.document.viewport ? { ...this.document.viewport } : undefined,
			strokes: this.document.strokes.map(stroke => ({ ...stroke, points: stroke.points })),
			shapes: this.document.shapes.map(shape => ({ ...shape, start: { ...shape.start }, end: { ...shape.end } })),
			elements: this.document.elements.map(element => ({ ...element })),
			bookmarks: this.document.bookmarks?.map(bookmark => ({ ...bookmark })),
		};
	}
	private undo(): void { const previous = this.history.pop(); if (!previous) return; this.redoStack.push(this.cloneDocument()); this.document = previous; this.invalidateInkCache(); this.render(); void this.renderElements(); this.scheduleSave(); }
	private redo(): void { const next = this.redoStack.pop(); if (!next) return; this.history.push(this.cloneDocument()); this.document = next; this.invalidateInkCache(); this.render(); void this.renderElements(); this.scheduleSave(); }

	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.setSaveState("Cambios pendientes");
		// Serialising every point in a long note is main-thread work. Never let an
		// old 800 ms setting compete with normal pauses between handwritten words.
		const delay = Math.max(1800, this.plugin.settings.autosaveDelayMs);
		this.saveTimer = window.setTimeout(() => { this.saveTimer = null; void this.persist(); }, delay);
	}

	private async flushSave(): Promise<void> {
		if (this.saveTimer !== null) { window.clearTimeout(this.saveTimer); this.saveTimer = null; await this.persist(); }
	}

	private async saveNow(): Promise<void> {
		await this.flushSave();
		await this.queuedWrite;
		if (!this.changedDuringEdit) new Notice("Inkpad: guardado en el vault.");
	}

	private async persist(): Promise<void> {
		if (!this.file) return;
		if (this.changedDuringEdit) { this.changedDuringEdit = false; new Notice("Inkpad: el archivo cambió en otro dispositivo. Recarga antes de seguir para no sobrescribirlo."); return; }
		this.setSaveState("Guardando…");
		this.document.viewport = { ...this.transform };
		let content: string;
		try { content = serializeInkDocument(this.document); }
		catch { this.setSaveState("Error al guardar"); new Notice("Inkpad no pudo preparar el archivo para guardarlo. Tu dibujo sigue abierto y no se ha sobrescrito."); return; }
		this.queuedWrite = this.queuedWrite.catch(() => undefined).then(async () => {
			if (!this.file) return;
			this.writing = true;
			try { await this.app.vault.modify(this.file, content); this.lastWritten = content; this.setSaveState("Guardado"); }
			finally { this.writing = false; }
		});
		try { await this.queuedWrite; }
		catch { this.setSaveState("Error al guardar"); new Notice("Inkpad no pudo guardar todavía. Reinténtalo cuando vuelva la sincronización."); }
	}
}

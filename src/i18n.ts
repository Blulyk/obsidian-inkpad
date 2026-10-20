type TranslationValues = Record<string, string | number>;

const EN = {
	newInfiniteDrawing: "Create infinite drawing",
	createInkpadDrawing: "Create Inkpad drawing",
	drawingCreated: "Inkpad drawing created: {name}",
	couldNotCreateDrawing: "Inkpad could not create the drawing. Open the developer console to see the error.",
	canvas: "Inkpad drawing canvas",
	invalidFile: "Inkpad did not load this file because it is incomplete or invalid. It has not been overwritten.",
	pen: "Pen", pencil: "Pencil", marker: "Marker", highlighter: "Highlighter", eraser: "Eraser", lasso: "Lasso",
	undo: "Undo", redo: "Redo", saveNow: "Save now", moreTools: "More tools", insertVaultFile: "Insert vault file", insertText: "Insert text",
	deleteSelection: "Delete selection", exportSvg: "Export ink as SVG", exportPng: "Export ink as PNG", frameContent: "Frame all content", toggleFocus: "Toggle focus mode",
	savedPositions: "Saved positions", saved: "Saved", resetZoom: "Reset zoom to 100%", drawingTools: "Drawing tools", colorAndWidth: "Color and stroke width",
	chooseCustomColor: "Choose custom color", customColor: "Custom color", color: "Color {value}", strokeWidth: "Stroke width",
	saveCurrentPosition: "Save current position", deletePosition: "Delete {name}", bookmarkName: "Bookmark name", viewNumber: "View {number}",
	noContentToFrame: "There is no content to frame yet.", textForCanvas: "Text for canvas", editText: "Edit text", unlockText: "Unlock text", lockText: "Lock text", deleteText: "Delete text",
	togglePdfHeight: "Toggle height by pages", bringToFront: "Bring to front", sendToBack: "Send to back", unlockElement: "Unlock element", lockElement: "Lock element", removeFromCanvas: "Remove from canvas",
	fileNotFound: "File not found: {path}", resize: "Resize", couldNotPreviewNote: "Could not preview this note.", loadingPdf: "Loading PDF…", couldNotLoadPdf: "Could not load this PDF.",
	selectStrokeToConvert: "Select at least one stroke to convert it.", vaultNoteOrUrl: "Vault note path or URL", svgExported: "SVG exported: {path}", couldNotCreatePng: "Inkpad could not create the PNG.", pngExported: "Ink PNG exported.",
	selectInkToExport: "Select ink or shapes before exporting.", couldNotCreateSelectionPng: "Inkpad could not create the selection PNG.", selectionExported: "Selection exported as PNG.",
	pendingChanges: "Pending changes", savedToVault: "Inkpad: saved to the vault.", changedElsewhere: "Inkpad: the file changed on another device. Reload before continuing so it is not overwritten.", saving: "Saving…", saveError: "Save error",
	couldNotPrepareSave: "Inkpad could not prepare the file for saving. Your drawing remains open and has not been overwritten.", couldNotSave: "Inkpad could not save yet. Try again when sync is available.",
	duplicateSelection: "Duplicate selection", applyCurrentColor: "Apply current color", linkToNote: "Link to note or URL", exportSelectionPng: "Export selection as PNG", convertToLine: "Convert to line", convertToRectangle: "Convert to rectangle", convertToEllipse: "Convert to ellipse", openLink: "Open link",
	line: "Line", arrow: "Arrow", rectangle: "Rectangle", ellipse: "Ellipse",
	autosaveDelay: "Pause before saving", autosaveDelayDesc: "Groups finished strokes before writing the file. A longer pause protects Pencil responsiveness in long drawings.", defaultColor: "Default color", canvasPaper: "Canvas paper", pressureResponse: "Pressure response", pressureResponseDesc: "Fixed keeps the same width; subtle is recommended for notes; natural responds more to Pencil pressure.",
	grid: "Grid", dots: "Dots", ruled: "Ruled", pentagram: "Music staff", weekly: "Weekly planner", blank: "Blank", fixed: "Fixed", subtle: "Subtle", natural: "Natural",
	page: "page",
} as const;

const ES: Record<keyof typeof EN, string> = {
	newInfiniteDrawing: "Crear dibujo infinito", createInkpadDrawing: "Crear dibujo Inkpad", drawingCreated: "Dibujo Inkpad creado: {name}", couldNotCreateDrawing: "Inkpad no pudo crear el dibujo. Abre la consola de desarrollador para ver el error.",
	canvas: "Lienzo de dibujo Inkpad", invalidFile: "Inkpad no cargó este archivo porque está incompleto o no es válido. No se ha sobrescrito.",
	pen: "Pluma", pencil: "Lápiz", marker: "Rotulador", highlighter: "Subrayador", eraser: "Borrador", lasso: "Lazo",
	undo: "Deshacer", redo: "Rehacer", saveNow: "Guardar ahora", moreTools: "Más herramientas", insertVaultFile: "Insertar archivo del vault", insertText: "Insertar texto",
	deleteSelection: "Eliminar selección", exportSvg: "Exportar tinta como SVG", exportPng: "Exportar tinta como PNG", frameContent: "Encuadrar todo el contenido", toggleFocus: "Alternar modo enfoque",
	savedPositions: "Posiciones guardadas", saved: "Guardado", resetZoom: "Restablecer zoom al 100%", drawingTools: "Herramientas de dibujo", colorAndWidth: "Color y grosor",
	chooseCustomColor: "Elegir color personalizado", customColor: "Color personalizado", color: "Color {value}", strokeWidth: "Grosor",
	saveCurrentPosition: "Guardar posición actual", deletePosition: "Eliminar {name}", bookmarkName: "Nombre del marcador", viewNumber: "Vista {number}",
	noContentToFrame: "Aún no hay contenido que encuadrar.", textForCanvas: "Texto para el lienzo", editText: "Editar texto", unlockText: "Desbloquear texto", lockText: "Bloquear texto", deleteText: "Eliminar texto",
	togglePdfHeight: "Alternar altura por páginas", bringToFront: "Traer al frente", sendToBack: "Enviar al fondo", unlockElement: "Desbloquear elemento", lockElement: "Bloquear elemento", removeFromCanvas: "Eliminar del lienzo",
	fileNotFound: "Archivo no encontrado: {path}", resize: "Cambiar tamaño", couldNotPreviewNote: "No se pudo previsualizar esta nota.", loadingPdf: "Cargando PDF…", couldNotLoadPdf: "No se pudo cargar este PDF.",
	selectStrokeToConvert: "Selecciona al menos un trazo para convertirlo.", vaultNoteOrUrl: "Ruta de nota del vault o URL", svgExported: "SVG exportado: {path}", couldNotCreatePng: "Inkpad no pudo crear el PNG.", pngExported: "PNG de tinta exportado.",
	selectInkToExport: "Selecciona tinta o formas antes de exportar.", couldNotCreateSelectionPng: "Inkpad no pudo crear el PNG de la selección.", selectionExported: "Selección exportada como PNG.",
	pendingChanges: "Cambios pendientes", savedToVault: "Inkpad: guardado en el vault.", changedElsewhere: "Inkpad: el archivo cambió en otro dispositivo. Recarga antes de seguir para no sobrescribirlo.", saving: "Guardando…", saveError: "Error al guardar",
	couldNotPrepareSave: "Inkpad no pudo preparar el archivo para guardarlo. Tu dibujo sigue abierto y no se ha sobrescrito.", couldNotSave: "Inkpad no pudo guardar todavía. Reinténtalo cuando vuelva la sincronización.",
	duplicateSelection: "Duplicar selección", applyCurrentColor: "Aplicar color actual", linkToNote: "Vincular a nota o URL", exportSelectionPng: "Exportar selección PNG", convertToLine: "Convertir en línea", convertToRectangle: "Convertir en rectángulo", convertToEllipse: "Convertir en elipse", openLink: "Abrir vínculo",
	line: "Línea", arrow: "Flecha", rectangle: "Rectángulo", ellipse: "Elipse",
	autosaveDelay: "Pausa antes de guardar", autosaveDelayDesc: "Agrupa trazos terminados antes de escribir el archivo. Una pausa mayor protege la fluidez del Pencil en dibujos largos.", defaultColor: "Color predeterminado", canvasPaper: "Papel del lienzo", pressureResponse: "Sensibilidad de presión", pressureResponseDesc: "Fija mantiene el mismo grosor; sutil es la recomendada para apuntes; natural responde más a la presión del Pencil.",
	grid: "Cuadrícula", dots: "Puntos", ruled: "Rayado", pentagram: "Pentagrama", weekly: "Plan semanal", blank: "Blanco", fixed: "Fija", subtle: "Sutil", natural: "Natural",
	page: "página",
};

export type TranslationKey = keyof typeof EN;

/** Obsidian exposes its selected UI locale on the document; the browser locale is a safe fallback on older mobile builds. */
function selectedLanguage(): string {
	return (document.documentElement.lang || navigator.languages?.[0] || navigator.language || "en").toLowerCase();
}

export function t(key: TranslationKey, values: TranslationValues = {}): string {
	const dictionary = selectedLanguage().startsWith("es") ? ES : EN;
	return dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
}

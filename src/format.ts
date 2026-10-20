import { EMPTY_DOCUMENT, InkBookmark, InkDocument, InkElement, InkPoint, InkShape, InkStroke, Tool } from "./types";

const tools: ReadonlySet<string> = new Set<Tool>(["pen", "pencil", "marker", "highlighter", "eraser", "lasso", "line", "arrow", "rectangle", "ellipse"]);

/** Checks the envelope before a view replaces its in-memory drawing with disk data. */
export function isInkpadDocument(raw: string): boolean {
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object") return false;
		const candidate = value as Partial<InkDocument>;
		return candidate.format === "inkpad" && candidate.version === 1 && Array.isArray(candidate.strokes);
	} catch { return false; }
}

function point(value: unknown): InkPoint | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<InkPoint>;
	if (typeof candidate.x !== "number" || typeof candidate.y !== "number") return null;
	return {
		x: candidate.x,
		y: candidate.y,
		p: typeof candidate.p === "number" ? candidate.p : 0.5,
		t: typeof candidate.t === "number" ? candidate.t : 0,
	};
}

function stroke(value: unknown): InkStroke | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<InkStroke>;
	if (typeof candidate.id !== "string" || !tools.has(candidate.tool ?? "") || typeof candidate.color !== "string" || typeof candidate.width !== "number" || !Array.isArray(candidate.points)) return null;
	const points = candidate.points.map(point).filter((item): item is InkPoint => item !== null);
	return points.length ? { id: candidate.id, tool: candidate.tool as Tool, color: candidate.color, width: candidate.width, points, link: typeof candidate.link === "string" ? candidate.link : undefined } : null;
}

function element(value: unknown): InkElement | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<InkElement>;
	if (typeof candidate.id !== "string" || typeof candidate.path !== "string" || !["markdown", "pdf", "image", "audio", "text"].includes(candidate.kind ?? "")) return null;
	if (typeof candidate.x !== "number" || typeof candidate.y !== "number" || typeof candidate.width !== "number" || typeof candidate.height !== "number") return null;
	return {
		id: candidate.id, path: candidate.path, kind: candidate.kind as InkElement["kind"], x: candidate.x, y: candidate.y,
		width: Math.max(120, candidate.width), height: Math.max(100, candidate.height),
		aspectRatio: typeof candidate.aspectRatio === "number" ? Math.max(0.1, candidate.aspectRatio) : undefined,
		locked: candidate.locked === true,
		pageCount: typeof candidate.pageCount === "number" ? Math.max(1, Math.round(candidate.pageCount)) : undefined,
		pageAspect: typeof candidate.pageAspect === "number" ? Math.max(0.1, candidate.pageAspect) : undefined,
		fitPdfPages: candidate.fitPdfPages === true,
		text: typeof candidate.text === "string" ? candidate.text : undefined,
		url: typeof candidate.url === "string" ? candidate.url : undefined,
	};
}

function shape(value: unknown): InkShape | null {
	if (!value || typeof value !== "object") return null;
	const item = value as Partial<InkShape>;
	if (typeof item.id !== "string" || !["line", "arrow", "rectangle", "ellipse"].includes(item.type ?? "") || typeof item.color !== "string" || typeof item.width !== "number") return null;
	if (!item.start || !item.end || typeof item.start.x !== "number" || typeof item.start.y !== "number" || typeof item.end.x !== "number" || typeof item.end.y !== "number") return null;
	return { id: item.id, type: item.type as InkShape["type"], color: item.color, width: item.width, start: item.start, end: item.end, link: typeof item.link === "string" ? item.link : undefined };
}

function bookmark(value: unknown): InkBookmark | null {
	if (!value || typeof value !== "object") return null;
	const item = value as Partial<InkBookmark>;
	if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.x !== "number" || typeof item.y !== "number" || typeof item.zoom !== "number") return null;
	return { id: item.id, name: item.name.slice(0, 80), x: item.x, y: item.y, zoom: Math.min(6, Math.max(.15, item.zoom)) };
}

/** Parses only our portable, versioned document shape. Invalid data never reaches the renderer. */
export function parseInkDocument(raw: string): InkDocument {
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object") return { ...EMPTY_DOCUMENT, strokes: [], shapes: [], elements: [] };
		const candidate = value as Partial<InkDocument>;
		if (candidate.format !== "inkpad" || candidate.version !== 1 || !Array.isArray(candidate.strokes)) return { ...EMPTY_DOCUMENT, strokes: [], shapes: [], elements: [] };
		const viewport = candidate.viewport;
		return {
			format: "inkpad",
			version: 1,
			strokes: candidate.strokes.map(stroke).filter((item): item is InkStroke => item !== null),
			shapes: Array.isArray(candidate.shapes) ? candidate.shapes.map(shape).filter((item): item is InkShape => item !== null) : [],
			elements: Array.isArray(candidate.elements) ? candidate.elements.map(element).filter((item): item is InkElement => item !== null) : [],
			bookmarks: Array.isArray(candidate.bookmarks) ? candidate.bookmarks.map(bookmark).filter((item): item is InkBookmark => item !== null) : [],
			viewport: viewport && typeof viewport.x === "number" && typeof viewport.y === "number" && typeof viewport.zoom === "number" ? viewport : undefined,
		};
	} catch {
		return { ...EMPTY_DOCUMENT, strokes: [], shapes: [], elements: [] };
	}
}

export function serializeInkDocument(document: InkDocument): string {
	return JSON.stringify(document);
}

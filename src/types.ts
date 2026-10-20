export type Tool = "pen" | "pencil" | "marker" | "highlighter" | "eraser" | "lasso" | "line" | "arrow" | "rectangle" | "ellipse";

export interface InkPoint {
	x: number;
	y: number;
	p: number;
	t: number;
}

export interface InkStroke {
	id: string;
	tool: Tool;
	color: string;
	width: number;
	points: InkPoint[];
	/** Optional vault path or https URL attached through the lasso menu. */
	link?: string;
}

export interface InkShape {
	id: string;
	type: "line" | "arrow" | "rectangle" | "ellipse";
	color: string;
	width: number;
	start: { x: number; y: number };
	end: { x: number; y: number };
	link?: string;
}

export interface InkElement {
	id: string;
	/** Vault-relative path. The source file remains the single source of truth. */
	path: string;
	kind: "markdown" | "pdf" | "image" | "audio" | "text";
	text?: string;
	url?: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Intrinsic image width / height. Keeps image cards free of letterboxing. */
	aspectRatio?: number;
	/** Locked cards stay readable but cannot be moved or resized accidentally. */
	locked?: boolean;
	/** Optional PDF page estimate used by the full-document-height layout. */
	pageCount?: number;
	pageAspect?: number;
	fitPdfPages?: boolean;
}

export interface InkBookmark {
	id: string;
	name: string;
	x: number;
	y: number;
	zoom: number;
}

export interface InkDocument {
	format: "inkpad";
	version: 1;
	strokes: InkStroke[];
	shapes: InkShape[];
	elements: InkElement[];
	bookmarks?: InkBookmark[];
	viewport?: { x: number; y: number; zoom: number };
}

export const EMPTY_DOCUMENT: InkDocument = {
	format: "inkpad",
	version: 1,
	strokes: [],
	shapes: [],
	elements: [],
};

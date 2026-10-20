import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TFile, Vault } from "obsidian";
import workerSource from "inkpad-pdf-worker-source";
import { t } from "./i18n";


// PDF.js workers share the `pdfjsWorker` global when they run in the page.
// Giving Inkpad a Blob-backed module worker keeps parsing off the UI thread and
// leaves Obsidian's viewer (and its worker) completely untouched.
let workerUrl: string | null = null;

function getInkpadWorkerUrl(): string {
	if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
	return workerUrl;
}

function openInkpadPdf(bytes: Uint8Array): ReturnType<typeof pdfjs.getDocument> {
	pdfjs.GlobalWorkerOptions.workerSrc = getInkpadWorkerUrl();
	return pdfjs.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false });
}

export interface PdfRenderInfo {
	pageCount: number;
	pageAspect: number;
}

export async function renderPdfPages(vault: Vault, file: TFile, container: HTMLElement, width: number, allPages: boolean, isCurrent: () => boolean): Promise<PdfRenderInfo> {
	const bytes = new Uint8Array(await vault.readBinary(file));
	const loadingTask = openInkpadPdf(bytes);
	try {
		const document = await loadingTask.promise;
		const firstPage = await document.getPage(1);
		const natural = firstPage.getViewport({ scale: 1 });
		const pageAspect = natural.height / natural.width;
		const count = allPages ? document.numPages : 1;
		// A long deck can otherwise leave tens of 2× canvases resident (hundreds of
		// MB on an iPad). One physical pixel per CSS pixel is legible at the normal
		// canvas scale and keeps pencil input responsive while all pages are shown.
		const requestedPixelRatio = allPages ? 0.8 : Math.min(window.devicePixelRatio || 1, 1.5);
		// Bound the entire long-document preview as well as individual pages. A
		// 30-slide PDF must not create 30 full-size GPU textures behind the ink.
		const totalPreviewPixelBudget = 4_000_000;
		const maxPixelsPerPage = allPages ? Math.max(120_000, Math.min(350_000, Math.floor(totalPreviewPixelBudget / count))) : 1_600_000;
		for (let index = 1; index <= count; index++) {
			if (!isCurrent()) break;
			const page = index === 1 ? firstPage : await document.getPage(index);
			const cssScale = Math.max(0.2, width / natural.width);
			const pixelRatio = Math.min(requestedPixelRatio, Math.sqrt(maxPixelsPerPage / (natural.width * natural.height * cssScale * cssScale)));
			const viewport = page.getViewport({ scale: cssScale * pixelRatio });
			const canvas = container.createEl("canvas", { cls: "inkpad-pdf-page", attr: { "aria-label": `${file.basename}, ${t("page")} ${index}` } });
			canvas.width = Math.ceil(viewport.width);
			canvas.height = Math.ceil(viewport.height);
			// The bitmap keeps its intrinsic aspect ratio; CSS makes it inherit the
			// element's world-space width, so it zooms exactly with the canvas.
			const context = canvas.getContext("2d", { alpha: false });
			if (context) await page.render({ canvasContext: context, viewport }).promise;
			page.cleanup();
			// Return to the UI queue between pages, so importing a long slide deck
			// never monopolises touch and Pencil events.
			if (index < count) await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
		}
		return { pageCount: document.numPages, pageAspect };
	} finally {
		await loadingTask.destroy();
	}
}

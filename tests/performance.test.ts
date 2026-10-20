import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseInkDocument, serializeInkDocument } from "../src/format";
import { InkDocument } from "../src/types";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A lecture-sized document must remain cheap to validate and save after the
// debounce. This does not model iPad GPU time; it protects the data path from
// regressions that would otherwise steal time from the next Pencil contact.
const points = Array.from({ length: 30_000 }, (_, index) => ({ x: index % 900, y: Math.floor(index / 900), p: 0.5, t: index }));
const document: InkDocument = {
	format: "inkpad", version: 1,
	strokes: [{ id: "benchmark", tool: "pen", color: "#ffffff", width: 3, points }],
	shapes: [], elements: [], viewport: { x: 0, y: 0, zoom: 1 },
};
const start = performance.now();
const encoded = serializeInkDocument(document);
const decoded = parseInkDocument(encoded);
const elapsed = performance.now() - start;
assert(decoded.strokes[0]?.points.length === points.length, "El documento de referencia perdió puntos.");
// Generous enough for shared CI/slow desktops, while catching accidental deep
// copying or repeated parsing on the save path.
assert(elapsed < 1_500, `La ruta de serialización tardó ${elapsed.toFixed(0)} ms (límite: 1500 ms).`);

// The Pencil handlers are a hard real-time boundary. Features belong behind a
// debounce, requestAnimationFrame, or an explicit user action — never here.
const source = readFileSync(new URL("../src/ink-view.ts", import.meta.url), "utf8");
const hotPath = source.slice(source.indexOf("private onPointerDown"), source.indexOf("private beginPinch"));
for (const forbidden of ["await ", "JSON.", "vault.", "renderElements(", "cachedRead("]) {
	assert(!hotPath.includes(forbidden), `La ruta de entrada del Pencil contiene trabajo bloqueante: ${forbidden}`);
}

console.log(`performance guard passed (${elapsed.toFixed(1)} ms for 30k points)`);

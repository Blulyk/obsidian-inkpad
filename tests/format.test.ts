import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isInkpadDocument, parseInkDocument, serializeInkDocument } from "../src/format";

const valid = parseInkDocument('{"format":"inkpad","version":1,"strokes":[{"id":"a","tool":"pen","color":"#000","width":2,"points":[{"x":1,"y":2,"p":0.7,"t":5}]}]}');
assert.equal(valid.strokes.length, 1);
assert.equal(parseInkDocument('{"format":"inkpad","version":1,"strokes":[{"id":"p","tool":"pencil","color":"#000","width":2,"points":[{"x":1,"y":2,"p":0.5,"t":0}]}]}').strokes[0]?.tool, "pencil");
assert.equal(parseInkDocument("not json").strokes.length, 0);
assert.equal(isInkpadDocument("not json"), false);
assert.equal(isInkpadDocument('{"format":"inkpad","version":1,"strokes":[]}'), true);
assert.equal(parseInkDocument('{"format":"wrong","version":1,"strokes":[]}').strokes.length, 0);
assert.equal(parseInkDocument(serializeInkDocument(valid)).strokes[0]?.points[0]?.p, 0.7);
assert.equal(parseInkDocument('{"format":"inkpad","version":1,"strokes":[]}').elements.length, 0);
const withElement = parseInkDocument('{"format":"inkpad","version":1,"strokes":[],"elements":[{"id":"pdf","path":"lectura.pdf","kind":"pdf","x":10,"y":20,"width":560,"height":720}]}');
assert.equal(parseInkDocument(serializeInkDocument(withElement)).elements[0]?.path, "lectura.pdf");
const lockedImage = parseInkDocument('{"format":"inkpad","version":1,"strokes":[],"elements":[{"id":"img","path":"esquema.png","kind":"image","x":10,"y":20,"width":560,"height":320,"aspectRatio":1.75,"locked":true}]}');
assert.equal(parseInkDocument(serializeInkDocument(lockedImage)).elements[0]?.locked, true);
const linkedInk = parseInkDocument('{"format":"inkpad","version":1,"strokes":[{"id":"a","tool":"pen","color":"#000","width":2,"link":"tema.md","points":[{"x":1,"y":2,"p":0.7,"t":5}]}],"shapes":[{"id":"s","type":"line","color":"#fff","width":2,"link":"https://example.com","start":{"x":1,"y":2},"end":{"x":3,"y":4}}]}');
assert.equal(parseInkDocument(serializeInkDocument(linkedInk)).strokes[0]?.link, "tema.md");
assert.equal(parseInkDocument(serializeInkDocument(linkedInk)).shapes[0]?.link, "https://example.com");
const withBookmark = parseInkDocument('{"format":"inkpad","version":1,"strokes":[],"bookmarks":[{"id":"b","name":"Tema 1","x":10,"y":20,"zoom":1.5}]}');
assert.equal(parseInkDocument(serializeInkDocument(withBookmark)).bookmarks?.[0]?.name, "Tema 1");
const richDocument = parseInkDocument('{"format":"inkpad","version":1,"strokes":[],"shapes":[{"id":"shape","type":"rectangle","color":"#fff","width":3,"start":{"x":1,"y":2},"end":{"x":30,"y":40}}],"elements":[{"id":"note","path":"","kind":"text","text":"Repasar","x":1,"y":2,"width":320,"height":100}]}');
assert.equal(richDocument.shapes[0]?.type, "rectangle");
assert.equal(parseInkDocument(serializeInkDocument(richDocument)).elements[0]?.text, "Repasar");

// Inkpad must not replace Obsidian's global PDF worker merely by being enabled.
const pdfRenderer = readFileSync(new URL("../src/pdf-renderer.ts", import.meta.url), "utf8");
assert.doesNotMatch(pdfRenderer, /^import\s+.*pdf\.worker/m);
assert.doesNotMatch(pdfRenderer, /(?:globalThis|host)\.pdfjsWorker/);
assert.match(pdfRenderer, /URL\.createObjectURL\(new Blob\(\[workerSource\]/);
assert.match(pdfRenderer, /GlobalWorkerOptions\.workerSrc = getInkpadWorkerUrl\(\)/);
console.log("format tests passed");

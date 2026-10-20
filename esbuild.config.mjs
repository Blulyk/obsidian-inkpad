import esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";

const production = process.argv[2] === "production";
const workerModule = path.resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs");
const workerSourcePlugin = {
	name: "inkpad-pdf-worker-source",
	setup(build) {
		build.onResolve({ filter: /^inkpad-pdf-worker-source$/ }, () => ({ path: workerModule, namespace: "inkpad-worker" }));
		build.onLoad({ filter: /.*/, namespace: "inkpad-worker" }, async args => ({
			contents: `export default ${JSON.stringify((await esbuild.transform(await readFile(args.path, "utf8"), { loader: "js", format: "esm", target: "es2021", minify: production })).code)};`,
			loader: "js",
		}));
	},
};

await esbuild.build({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian"],
	format: "cjs",
	target: "es2021",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	minify: production,
	outfile: "main.js",
	plugins: [workerSourcePlugin],
});


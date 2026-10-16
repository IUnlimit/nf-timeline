/**
 * Build plugin UI into a single IIFE and stage package files under dist/.
 */

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const dist = path.join(root, "dist");
const uiOut = path.join(dist, "ui");

await rm(dist, { recursive: true, force: true });
await mkdir(uiOut, { recursive: true });

const result = await Bun.build({
	entrypoints: [path.join(root, "src/index.ts")],
	outdir: uiOut,
	target: "browser",
	format: "iife",
	minify: true,
	naming: "timeline.iife.js",
	sourcemap: "none",
});

if (!result.success) {
	console.error("[build] failed");
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

await cp(path.join(root, "ui/timeline.css"), path.join(uiOut, "timeline.css"));
await cp(path.join(root, "manifest.json"), path.join(dist, "manifest.json"));
await cp(path.join(root, "README.md"), path.join(dist, "README.md"));
await cp(path.join(root, "LICENSE"), path.join(dist, "LICENSE"));
await cp(path.join(root, "NOTICE"), path.join(dist, "NOTICE"));

const pkg = {
	name: "narrafork-dsh-timeline",
	version: JSON.parse(await Bun.file(path.join(root, "package.json")).text()).version,
	license: "MIT",
	private: true,
};
await writeFile(path.join(dist, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

const js = await Bun.file(path.join(uiOut, "timeline.iife.js")).text();
const css = await Bun.file(path.join(uiOut, "timeline.css")).text();
console.log(`[build] ok  js=${js.length}B  css=${css.length}B  dist=${path.relative(root, dist)}`);

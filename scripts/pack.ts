/**
 * Create the distributable `.nfplugin` archive from `dist/`.
 *
 * The archive is written by `scripts/zip.ts` (no `zip` binary required) and lands in
 * `release/`, so the repository root stays clean and CI can pick up a stable path.
 */

import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { createZip, type ZipEntry } from "./zip";

const root = path.resolve(import.meta.dir, "..");
const dist = path.join(root, "dist");
const releaseDir = path.join(root, "release");
const version = JSON.parse(await Bun.file(path.join(root, "package.json")).text())
	.version as string;
const out = path.join(releaseDir, `narrafork-dsh-timeline-${version}.nfplugin`);

async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await walk(full)));
		else files.push(full);
	}
	return files;
}

const files = await walk(dist);
if (files.length === 0) {
	console.error("[pack] dist is empty; run `bun run build` first");
	process.exit(1);
}

const entries: ZipEntry[] = [];
for (const file of files) {
	const rel = path.relative(dist, file).split(path.sep).join("/");
	entries.push({ path: rel, data: new Uint8Array(await Bun.file(file).arrayBuffer()) });
}

await mkdir(releaseDir, { recursive: true });
await Bun.write(out, createZip(entries));

console.log(
	`[pack] wrote ${path.relative(root, out)} (${entries.length} files, ${
		(await Bun.file(out).size) ?? 0
	} bytes)`,
);

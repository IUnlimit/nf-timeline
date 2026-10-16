/**
 * Package integrity checks for the .nfplugin layout (dist/ or a zip root).
 * Mirrors NarraFork server/lib/plugins/manifest.ts constraints for the fields we ship.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "dist");

const MAX_JS = 512 * 1024;
const MAX_CSS = 128 * 1024;
const FORBIDDEN = [
	/\beval\s*\(/,
	/new\s+Function\s*\(/,
	/https?:\/\/cdn\./,
	/require\s*\(\s*["']node:/,
];

const FORBIDDEN_ROOT_KEYS = ["name", "minHostVersion", "contributions"];

function fail(msg: string): never {
	console.error(`[validate] FAIL ${msg}`);
	process.exit(1);
}

async function walk(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else out.push(full);
	}
	return out;
}

const manifestPath = path.join(dist, "manifest.json");
const manifestStat = await stat(manifestPath).catch(() => null);
if (!manifestStat) fail("missing manifest.json");

const manifest = JSON.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>;

for (const key of FORBIDDEN_ROOT_KEYS) {
	if (key in manifest) fail(`forbidden root key: ${key}`);
}

if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1");
if (manifest.pluginId !== "dev.illtamer.narrafork-dsh-timeline") fail("unexpected pluginId");
if (typeof manifest.displayName !== "string" || !manifest.displayName) {
	fail("displayName required");
}
if (typeof manifest.version !== "string") fail("version required");
// The release asset is named after package.json, and the release workflow refuses a
// tag that disagrees with it; keep all three in step.
const packageVersion = JSON.parse(await Bun.file(path.join(root, "package.json")).text())
	.version as string;
if (manifest.version !== packageVersion) {
	fail(`manifest version ${manifest.version} does not match package.json ${packageVersion}`);
}

const publisher = manifest.publisher;
if (!publisher || typeof publisher !== "object" || Array.isArray(publisher)) {
	fail("publisher must be an object");
}

const engine = manifest.engine;
if (!engine || typeof engine !== "object" || Array.isArray(engine)) {
	fail("engine must be an object");
}
const engineObj = engine as Record<string, unknown>;
if (engineObj.rpc !== "narrafork.rpc/1") fail("engine.rpc must be narrafork.rpc/1");
if (typeof engineObj.hostApi !== "string" || !engineObj.hostApi) fail("engine.hostApi required");
if (!["bun", "node", "python", "binary"].includes(String(engineObj.runtime))) {
	fail("engine.runtime invalid");
}

const permissions = manifest.permissions;
if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
	fail("permissions must be an object");
}
const hostPerms = (permissions as { host?: unknown }).host;
if (!Array.isArray(hostPerms)) fail("permissions.host must be an array");
if (hostPerms.includes("secrets.get") || hostPerms.includes("secret.get")) {
	fail("unexpected secret permissions");
}
// Capabilities the panel genuinely needs: the bridge itself, the message query, the
// event channel, and host plugin storage for the accumulated observation.
const ALLOWED_HOST_PERMS = new Set([
	"ui.panel",
	"query.read.narrators",
	"event.subscribe",
	"storage.read_self",
	"storage.write_self",
]);
for (const cap of hostPerms) {
	if (typeof cap !== "string") fail("permissions.host entries must be strings");
	if (!ALLOWED_HOST_PERMS.has(cap)) fail(`unexpected host capability: ${cap}`);
}

const contributes = manifest.contributes;
if (!contributes || typeof contributes !== "object") fail("contributes required");
const views = (contributes as { views?: unknown[] }).views;
if (!Array.isArray(views) || views.length === 0) fail("contributes.views required");

const ui = manifest.ui as { entry?: string; format?: string; style?: string } | undefined;
if (!ui?.entry || ui.format !== "iife") fail("ui.entry iife required");

for (const raw of views) {
	const view = raw as Record<string, unknown>;
	if (view.id !== "dsh-timeline") fail("unexpected view id");
	if (view.scope !== "narrator") fail("timeline view must be narrator-scoped");
	if (view.instance !== "singleton-per-narrator") fail("instance must be singleton-per-narrator");
	if (view.defaultPosition !== "bottom") fail("defaultPosition must be bottom");
	// A narrator-scoped panel on the workspace surface only resolves when the host can
	// build a `workspace-narrator` binding, which needs a live narrator context. A fresh
	// window has none, so the host renders its recovery placeholder before the iframe
	// loads and no plugin-side fallback can run. `focus` implies `graph`.
	const surfaces = view.surfaces as string[] | undefined;
	if (!Array.isArray(surfaces) || !surfaces.includes("focus")) {
		fail("narrator-scoped timeline must declare the focus surface");
	}
	for (const banned of ["workspace", "director", "settings", "provider-settings"]) {
		if (Array.isArray(surfaces) && surfaces.includes(banned)) {
			fail(`narrator-scoped timeline must not declare the ${banned} surface`);
		}
	}
	for (const key of ["entry", "style"]) {
		const value = view[key];
		if (typeof value !== "string" || !value || value.includes("..") || path.isAbsolute(value)) {
			fail(`bad view ${key} path`);
		}
	}
	// view schema is strict — reject known extras that the host will refuse
	for (const banned of [
		"autoOpen",
		"desktopOnly",
		"titleZh",
		"defaultHeight",
		"minHeight",
		"maxHeight",
		"protocol",
	]) {
		if (banned in view) fail(`view must not declare ${banned}`);
	}
}

const files = await walk(dist);
for (const file of files) {
	const rel = path.relative(dist, file);
	if (rel.includes("..")) fail(`path traversal: ${rel}`);
	const size = (await stat(file)).size;
	if (rel.endsWith(".js") && size > MAX_JS) fail(`js too large: ${rel} ${size}`);
	if (rel.endsWith(".css") && size > MAX_CSS) fail(`css too large: ${rel} ${size}`);
	if (rel.endsWith(".js") || rel.endsWith(".css") || rel.endsWith(".json")) {
		const text = await Bun.file(file).text();
		for (const re of FORBIDDEN) {
			if (re.test(text)) fail(`forbidden pattern ${re} in ${rel}`);
		}
	}
}

for (const required of [
	"manifest.json",
	"ui/timeline.iife.js",
	"ui/timeline.css",
	"README.md",
	"LICENSE",
	"NOTICE",
]) {
	if (!files.some((f) => path.relative(dist, f) === required)) fail(`missing ${required}`);
}

// The bundle must not reference APIs the host does not implement, and every host id
// it does reference must be one we have verified.
const bundle = await Bun.file(path.join(dist, "ui/timeline.iife.js")).text();
for (const ghost of [
	"narrafork.narrator.timeline.list",
	"narrafork.narrator.subagent.",
	"narrafork.narrator.background_task.",
	"narrafork.narrator.status.changed",
]) {
	if (bundle.includes(ghost)) fail(`bundle references non-existent host API: ${ghost}`);
}

const KNOWN_HOST_IDS = new Set([
	"narrafork.narrator.messages.list",
	"narrafork.narrator.tool.changed",
	"narrafork.narrator.message.changed",
	"narrafork.narrator.lifecycle",
	"narrafork.narrator.attention",
	"narrafork.narrator.permission.changed",
	"narrafork.events.resync_required",
]);
for (const match of bundle.matchAll(/narrafork\.[a-z][a-z0-9._]*/g)) {
	const id = match[0].replace(/\.$/, "");
	if (!KNOWN_HOST_IDS.has(id)) fail(`bundle references an unverified host id: ${id}`);
}

// Declared capabilities must cover what the code actually calls, and nothing may be
// declared that the code never uses — both directions have shipped as bugs before
// (a capability the manifest forgot, and a capability the code never exercised).
const requiredByFeature: Array<[string, string[]]> = [
	["narrafork.narrator.messages.list", ["query.read.narrators"]],
	["events.subscribe", ["event.subscribe"]],
	["narrafork.narrator.tool.changed", ["event.subscribe"]],
	["storage.get", ["storage.read_self"]],
	["storage.set", ["storage.write_self"]],
];
for (const [needle, capabilities] of requiredByFeature) {
	if (!bundle.includes(needle)) continue;
	for (const capability of capabilities) {
		if (!hostPerms.includes(capability)) {
			fail(`bundle calls ${needle} but the manifest does not request ${capability}`);
		}
	}
}
const usedCapabilities = new Set(
	requiredByFeature.flatMap(([needle, capabilities]) =>
		bundle.includes(needle) ? capabilities : [],
	),
);
for (const capability of hostPerms) {
	if (capability === "ui.panel" || usedCapabilities.has(capability)) continue;
	fail(`manifest declares ${capability} but the bundle never uses it`);
}

console.log(`[validate] ok  files=${files.length}  root=${dist}`);

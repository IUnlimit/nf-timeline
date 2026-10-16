/**
 * Dependency-free ZIP writer.
 *
 * The plugin package (`.nfplugin`) is a plain ZIP. Writing it here instead of
 * shelling out to `zip` keeps `bun run pack` working on every platform and makes the
 * archive byte-for-byte reproducible: entry order is sorted and timestamps are fixed.
 *
 * The output is the classic non-streaming layout (sizes and CRC in the local header,
 * no data descriptor), which is what the host's own reader — `server/lib/zip-archive.ts`
 * in NarraFork, which verifies CRC-32 and the uncompressed size per entry — expects.
 */

import { deflateRawSync } from "node:zlib";

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

const VERSION_NEEDED = 20;
const FLAG_UTF8_NAME = 0x800;
const METHOD_DEFLATE = 8;

const EOCD_SIZE = 22;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_ENTRY_SIZE = 46;

/** ZIP has no way to express a date before 1980; the default keeps builds reproducible. */
const DEFAULT_MODIFIED_AT = new Date("2026-01-01T00:00:00Z");

export interface ZipEntry {
	/** Archive-relative path with forward slashes, e.g. `ui/timeline.iife.js`. */
	path: string;
	data: Uint8Array;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

export function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date: Date): { time: number; date: number } {
	const year = Math.max(1980, date.getUTCFullYear());
	return {
		time:
			(date.getUTCHours() << 11) |
			(date.getUTCMinutes() << 5) |
			Math.floor(date.getUTCSeconds() / 2),
		date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
	};
}

/**
 * Build a ZIP archive. Entries are written in sorted path order so identical inputs
 * always produce an identical archive. The comparison is by UTF-16 code unit rather
 * than `localeCompare`, because locale collation differs between machines.
 */
export function createZip(
	entries: readonly ZipEntry[],
	options: { modifiedAt?: Date } = {},
): Uint8Array {
	if (entries.length > 0xffff) {
		throw new Error("createZip supports at most 65535 entries");
	}
	const { time, date } = toDosDateTime(options.modifiedAt ?? DEFAULT_MODIFIED_AT);
	const encoder = new TextEncoder();
	const ordered = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	type Prepared = {
		name: Uint8Array;
		compressed: Uint8Array;
		size: number;
		crc: number;
		offset: number;
	};
	const prepared: Prepared[] = [];
	const chunks: Uint8Array[] = [];
	let offset = 0;

	for (const entry of ordered) {
		const name = encoder.encode(entry.path);
		const compressed = new Uint8Array(deflateRawSync(entry.data));
		const crc = crc32(entry.data);
		const header = Buffer.alloc(LOCAL_HEADER_SIZE);
		header.writeUInt32LE(LOCAL_SIGNATURE, 0);
		header.writeUInt16LE(VERSION_NEEDED, 4);
		header.writeUInt16LE(FLAG_UTF8_NAME, 6);
		header.writeUInt16LE(METHOD_DEFLATE, 8);
		header.writeUInt16LE(time, 10);
		header.writeUInt16LE(date, 12);
		header.writeUInt32LE(crc, 14);
		header.writeUInt32LE(compressed.length, 18);
		header.writeUInt32LE(entry.data.length, 22);
		header.writeUInt16LE(name.length, 26);
		header.writeUInt16LE(0, 28);

		prepared.push({ name, compressed, size: entry.data.length, crc, offset });
		chunks.push(header, name, compressed);
		offset += LOCAL_HEADER_SIZE + name.length + compressed.length;
	}

	const centralStart = offset;
	for (const entry of prepared) {
		const header = Buffer.alloc(CENTRAL_ENTRY_SIZE);
		header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
		header.writeUInt16LE(VERSION_NEEDED, 4);
		header.writeUInt16LE(VERSION_NEEDED, 6);
		header.writeUInt16LE(FLAG_UTF8_NAME, 8);
		header.writeUInt16LE(METHOD_DEFLATE, 10);
		header.writeUInt16LE(time, 12);
		header.writeUInt16LE(date, 14);
		header.writeUInt32LE(entry.crc, 16);
		header.writeUInt32LE(entry.compressed.length, 20);
		header.writeUInt32LE(entry.size, 24);
		header.writeUInt16LE(entry.name.length, 28);
		header.writeUInt16LE(0, 30);
		header.writeUInt16LE(0, 32);
		header.writeUInt16LE(0, 34);
		header.writeUInt16LE(0, 36);
		header.writeUInt32LE(0, 38);
		header.writeUInt32LE(entry.offset, 42);
		chunks.push(header, entry.name);
		offset += CENTRAL_ENTRY_SIZE + entry.name.length;
	}

	const eocd = Buffer.alloc(EOCD_SIZE);
	eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(prepared.length, 8);
	eocd.writeUInt16LE(prepared.length, 10);
	eocd.writeUInt32LE(offset - centralStart, 12);
	eocd.writeUInt32LE(centralStart, 16);
	eocd.writeUInt16LE(0, 20);
	chunks.push(eocd);

	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const archive = new Uint8Array(total);
	let cursor = 0;
	for (const chunk of chunks) {
		archive.set(chunk, cursor);
		cursor += chunk.length;
	}
	return archive;
}

/**
 * Round-trip test for the ZIP writer used by `bun run pack`.
 *
 * The reader below is deliberately a second, independent implementation: it walks the
 * central directory and verifies CRC-32 plus the uncompressed size per entry, the same
 * way NarraFork's own `server/lib/zip-archive.ts` does when installing a plugin.
 */

import { describe, expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";
import { crc32, createZip } from "../scripts/zip";

interface ReadEntry {
	path: string;
	data: Uint8Array;
	crc: number;
	method: number;
	offset: number;
	/** Uncompressed size as declared in the central directory. */
	declaredSize: number;
	/** Compressed size as declared in the central directory. */
	compressedSize: number;
}

function readZip(archive: Uint8Array): ReadEntry[] {
	const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
	let eocd = -1;
	for (let i = archive.length - 22; i >= 0; i -= 1) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("no end of central directory record");
	const count = view.getUint16(eocd + 10, true);
	let cursor = view.getUint32(eocd + 16, true);

	const entries: ReadEntry[] = [];
	for (let i = 0; i < count; i += 1) {
		if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("bad central directory entry");
		const method = view.getUint16(cursor + 10, true);
		const crc = view.getUint32(cursor + 16, true);
		const nameLength = view.getUint16(cursor + 28, true);
		const extraLength = view.getUint16(cursor + 30, true);
		const commentLength = view.getUint16(cursor + 32, true);
		const localOffset = view.getUint32(cursor + 42, true);
		const name = new TextDecoder().decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));

		if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("bad local header");
		const localNameLength = view.getUint16(localOffset + 26, true);
		const localExtraLength = view.getUint16(localOffset + 28, true);
		const compressedSize = view.getUint32(localOffset + 18, true);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const raw = archive.subarray(dataStart, dataStart + compressedSize);

		entries.push({
			path: name,
			data: method === 0 ? raw : new Uint8Array(inflateRawSync(raw)),
			crc,
			method,
			offset: localOffset,
			// The host's reader validates these two central-directory fields per entry.
			declaredSize: view.getUint32(cursor + 24, true),
			compressedSize: view.getUint32(cursor + 20, true),
		});
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

const encoder = new TextEncoder();

describe("createZip", () => {
	test("an archive survives an independent read-back with CRCs intact", () => {
		const entries = [
			{ path: "manifest.json", data: encoder.encode('{"schemaVersion":1}') },
			{ path: "ui/timeline.iife.js", data: encoder.encode("console.log('中文 ok')") },
			{ path: "README.md", data: encoder.encode("# Title\n\nbody\n") },
		];
		const read = readZip(createZip(entries));
		expect(read.map((entry) => entry.path)).toEqual([
			"README.md",
			"manifest.json",
			"ui/timeline.iife.js",
		]);
		const expectedByPath = new Map(entries.map((entry) => [entry.path, entry.data]));
		for (const entry of read) {
			const expected = expectedByPath.get(entry.path);
			expect(expected).toBeDefined();
			if (!expected) continue;
			expect(new TextDecoder().decode(entry.data)).toBe(new TextDecoder().decode(expected));
			expect(entry.crc).toBe(crc32(expected));
			expect(entry.method).toBe(8);
			// The declared uncompressed size must describe the real payload: the host
			// verifies it after inflating each entry.
			expect(entry.declaredSize).toBe(expected.length);
			expect(entry.data.length).toBe(entry.declaredSize);
		}
	});

	test("nested paths and non-ASCII content round-trip", () => {
		const data = encoder.encode("叙事时间线 / timeline");
		const read = readZip(createZip([{ path: "ui/timeline.css", data }]));
		expect(read[0]?.path).toBe("ui/timeline.css");
		expect(crc32(read[0]?.data as Uint8Array)).toBe(crc32(data));
	});

	test("identical input produces identical bytes", () => {
		const entries = [{ path: "a.txt", data: encoder.encode("same") }];
		const first = createZip(entries);
		const second = createZip([...entries].reverse());
		expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
	});

	test("an empty payload is still a valid archive", () => {
		expect(readZip(createZip([]))).toEqual([]);
	});

	test("crc32 matches the canonical value for a known vector", () => {
		// "123456789" → 0xCBF43926 (the standard CRC-32 check value).
		expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
	});
});

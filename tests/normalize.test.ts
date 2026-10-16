import { describe, expect, test } from "bun:test";
import {
	isOpenEnded,
	mergeItem,
	normalizeStatus,
	parseTime,
	resolveDurationMs,
	toIso,
} from "../src/normalize";
import type { TimelineItem } from "../src/types";

function item(partial: Partial<TimelineItem> = {}): TimelineItem {
	return {
		id: "n1",
		kind: "tool",
		label: "tool",
		status: "success",
		startedAt: "2026-10-16T10:00:00.000Z",
		...partial,
	};
}

describe("parseTime", () => {
	test("parses ISO timestamps and rejects the rest", () => {
		expect(parseTime("2026-10-16T10:00:00.000Z")).toBe(Date.parse("2026-10-16T10:00:00.000Z"));
		expect(Number.isNaN(parseTime(undefined))).toBe(true);
		expect(Number.isNaN(parseTime("not-a-date"))).toBe(true);
	});

	test("toIso round-trips", () => {
		const ms = Date.parse("2026-10-16T10:00:00.000Z");
		expect(parseTime(toIso(ms))).toBe(ms);
	});
});

describe("resolveDurationMs", () => {
	test("an explicit duration wins", () => {
		expect(resolveDurationMs(item({ durationMs: 1234 }), 0)).toBe(1234);
	});

	test("falls back to end - start", () => {
		expect(
			resolveDurationMs(
				item({ endedAt: "2026-10-16T10:00:05.000Z", startedAt: "2026-10-16T10:00:00.000Z" }),
				0,
			),
		).toBe(5000);
	});

	test("open-ended nodes grow towards now", () => {
		const start = Date.parse("2026-10-16T10:00:00.000Z");
		expect(resolveDurationMs(item({ status: "waiting" }), start + 2000)).toBe(2000);
	});

	test("a terminal node without a duration stays at zero", () => {
		expect(resolveDurationMs(item({ status: "success" }), Date.now())).toBe(0);
	});
});

describe("isOpenEnded", () => {
	test("terminal statuses are closed even without endedAt", () => {
		expect(isOpenEnded(item({ status: "success" }))).toBe(false);
		expect(isOpenEnded(item({ status: "fail" }))).toBe(false);
		expect(isOpenEnded(item({ status: "waiting" }))).toBe(true);
		expect(isOpenEnded(item({ status: "running" }))).toBe(true);
		expect(isOpenEnded(item({ status: "waiting", endedAt: "2026-10-16T10:00:01.000Z" }))).toBe(
			false,
		);
	});
});

describe("normalizeStatus", () => {
	test("maps the host's terminal vocabulary, unknown otherwise", () => {
		expect(normalizeStatus("success")).toBe("success");
		expect(normalizeStatus("fail")).toBe("fail");
		expect(normalizeStatus("pending")).toBe("running");
		expect(normalizeStatus("waiting")).toBe("waiting");
		// `cancelled` is not part of any public tool payload; it must not be invented.
		expect(normalizeStatus("cancelled")).toBe("unknown");
		expect(normalizeStatus(undefined)).toBe("unknown");
	});
});

describe("mergeItem", () => {
	test("inserts a new node untouched", () => {
		const map = new Map<string, TimelineItem>();
		mergeItem(map, item({ durationMs: 10 }));
		expect(map.get("n1")?.durationMs).toBe(10);
	});

	test("a terminal revision wins over an open one", () => {
		const map = new Map<string, TimelineItem>();
		mergeItem(map, item({ status: "waiting" }));
		mergeItem(map, item({ status: "success", endedAt: "2026-10-16T10:00:02.000Z" }));
		expect(map.get("n1")?.status).toBe("success");
		expect(map.get("n1")?.endedAt).toBe("2026-10-16T10:00:02.000Z");
	});

	test("an out-of-order older non-terminal frame cannot clobber a terminal state", () => {
		const map = new Map<string, TimelineItem>();
		mergeItem(
			map,
			item({ status: "success", startedAt: "2026-10-16T10:00:10.000Z", durationMs: 5 }),
		);
		mergeItem(map, item({ status: "waiting", startedAt: "2026-10-16T10:00:00.000Z" }));
		expect(map.get("n1")?.status).toBe("success");
	});

	test("keeps the earliest known start and never drops a detail", () => {
		const map = new Map<string, TimelineItem>();
		mergeItem(map, item({ startedAt: "2026-10-16T10:00:05.000Z", detail: "first" }));
		mergeItem(map, item({ startedAt: "2026-10-16T10:00:00.000Z" }));
		expect(map.get("n1")?.startedAt).toBe("2026-10-16T10:00:00.000Z");
		expect(map.get("n1")?.detail).toBe("first");
	});
});

import { describe, expect, test } from "bun:test";
import {
	computeWindow,
	fitView,
	followEndMs,
	geometryForItem,
	MAX_ROWS,
	packRows,
	resolveView,
	rowCount,
	scaleFor,
	ticksForScale,
	xForTime,
	zoomViewAt,
} from "../src/layout";
import type { TimelineItem } from "../src/types";

function node(partial: Partial<TimelineItem> & { id: string }): TimelineItem {
	return {
		kind: "tool",
		label: partial.id,
		status: "success",
		startedAt: "2026-10-16T10:00:00.000Z",
		...partial,
	};
}

const T0 = Date.parse("2026-10-16T10:00:00.000Z");

describe("scaleFor", () => {
	test("canvas width equals the viewport, never the time span", () => {
		for (const span of [1_000, 60_000, 3_600_000, 24 * 3_600_000]) {
			const scale = scaleFor({ spanMs: span, endMs: T0 }, 900);
			expect(scale.viewportWidth).toBe(900);
			expect(scale.pxPerMs * span).toBeCloseTo(900, 6);
		}
	});

	test("offset is the left edge of the visible window", () => {
		const scale = scaleFor({ spanMs: 60_000, endMs: T0 }, 600);
		expect(scale.offsetMs).toBe(T0 - 60_000);
		expect(xForTime(scale, T0)).toBeCloseTo(600, 6);
	});
});

describe("zoomViewAt", () => {
	test("zooming changes the span and keeps the right edge stable", () => {
		const view = { spanMs: 60_000, endMs: T0 };
		const zoomed = zoomViewAt(view, 2, 600, 600);
		expect(zoomed.spanMs).toBe(120_000);
		expect(zoomed.endMs).toBeCloseTo(T0, 6);
		const closer = zoomViewAt(view, 0.5, 600, 600);
		expect(closer.spanMs).toBe(30_000);
		expect(closer.endMs).toBeCloseTo(T0, 6);
	});

	test("the time under the cursor stays put", () => {
		const view = { spanMs: 60_000, endMs: T0 };
		const before = scaleFor(view, 600);
		const anchorX = 150;
		const anchorTime = before.offsetMs + anchorX / before.pxPerMs;
		const zoomed = zoomViewAt(view, 0.5, 600, anchorX);
		const after = scaleFor(zoomed, 600);
		const anchorTimeAfter = after.offsetMs + anchorX / after.pxPerMs;
		expect(anchorTimeAfter).toBeCloseTo(anchorTime, 0);
	});

	test("span never collapses below the floor", () => {
		let view = { spanMs: 2_000, endMs: T0 };
		for (let i = 0; i < 10; i += 1) view = zoomViewAt(view, 0.5, 600, 300);
		expect(view.spanMs).toBe(1_000);
	});
});

describe("content driven view", () => {
	const items = [
		node({ id: "a", startedAt: "2026-10-16T10:00:00.000Z", endedAt: "2026-10-16T10:00:02.000Z" }),
		node({ id: "b", startedAt: "2026-10-16T10:05:00.000Z", endedAt: "2026-10-16T10:05:01.000Z" }),
	];

	test("followEndMs pins to the newest activity, not to now", () => {
		const now = Date.parse("2026-10-16T10:20:00.000Z");
		expect(followEndMs(items, now)).toBe(now);
		const recent = Date.parse("2026-10-16T10:05:30.000Z");
		expect(followEndMs(items, recent)).toBe(recent);
	});

	test("resolveView adapts the span to the content until the user zooms", () => {
		const now = Date.parse("2026-10-16T10:06:00.000Z");
		const first = resolveView(items, now, null, true);
		const grown = resolveView(
			[...items, node({ id: "c", startedAt: "2026-10-16T10:05:50.000Z" })],
			now,
			first,
			true,
		);
		expect(grown.spanMs).toBeGreaterThan(first.spanMs);
	});

	test("a user zoom pins the span", () => {
		const now = Date.parse("2026-10-16T10:06:00.000Z");
		const pinned = { spanMs: 15_000, endMs: now };
		const next = resolveView(items, now, pinned, true, { userAdjusted: true });
		expect(next.spanMs).toBe(15_000);
	});

	test("fitView covers every node", () => {
		const win = computeWindow(items, T0);
		const fitted = fitView(items, T0);
		expect(fitted.spanMs).toBe(win.spanMs);
		for (const item of items) {
			const start = Date.parse(item.startedAt);
			expect(xForTime(scaleFor(fitted, 600), start)).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("geometry", () => {
	test("a tool node is as wide as its duration", () => {
		const scale = scaleFor({ spanMs: 10_000, endMs: T0 + 10_000 }, 1000);
		const geom = geometryForItem(node({ id: "t", durationMs: 2_000 }), scale, T0 + 10_000, 3);
		expect(geom.width).toBeCloseTo(200, 6);
		expect(geom.marker).toBe(false);
	});

	test("an instant node keeps the minimum width", () => {
		const scale = scaleFor({ spanMs: 10_000, endMs: T0 + 10_000 }, 1000);
		const geom = geometryForItem(
			node({ id: "m", kind: "message", durationMs: 0, endedAt: "2026-10-16T10:00:00.000Z" }),
			scale,
			T0 + 10_000,
			3,
		);
		expect(geom.width).toBe(3);
		expect(geom.marker).toBe(true);
	});

	test("a waiting node never grows with time — no fake duration", () => {
		const scale = scaleFor({ spanMs: 10_000, endMs: T0 + 10_000 }, 1000);
		const geom = geometryForItem(node({ id: "p", status: "waiting" }), scale, T0 + 10_000, 3);
		expect(geom.marker).toBe(true);
		expect(geom.width).toBe(8);
	});
});

describe("packRows", () => {
	test("overlapping nodes land on separate rows", () => {
		const packed = packRows([
			{ id: "a", x: 0, width: 10, marker: false },
			{ id: "b", x: 5, width: 10, marker: false },
		]);
		const rows = new Map(packed.map((node) => [node.id, node.row]));
		expect(rows.get("a")).not.toBe(rows.get("b"));
		expect(rowCount(packed)).toBe(2);
	});

	test("non-overlapping nodes share one row", () => {
		const packed = packRows([
			{ id: "a", x: 0, width: 10, marker: false },
			{ id: "b", x: 20, width: 10, marker: false },
		]);
		expect(rowCount(packed)).toBe(1);
	});

	test("row growth is clamped so the panel cannot become a wall of rows", () => {
		const geoms = Array.from({ length: 12 }, (_, i) => ({
			id: `n${i}`,
			x: 0,
			width: 10,
			marker: false,
		}));
		const packed = packRows(geoms);
		expect(rowCount(packed)).toBe(MAX_ROWS);
		expect(packed).toHaveLength(12);
	});
});

describe("ticks", () => {
	test("ticks are aligned to a nice step and bounded", () => {
		const view = { spanMs: 60_000, endMs: T0 };
		const scale = scaleFor(view, 600);
		const ticks = ticksForScale(scale, {
			startMs: view.endMs - view.spanMs,
			endMs: view.endMs,
			spanMs: view.spanMs,
		});
		expect(ticks.length).toBeGreaterThan(1);
		expect(ticks[0]! % 5_000).toBe(0);
	});
});

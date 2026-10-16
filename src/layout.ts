import { isOpenEnded, parseTime, resolveDurationMs } from "./normalize";
import type { LayoutScale, TimelineItem, TimelineWindow } from "./types";

/**
 * Visible time range. Zoom changes `spanMs` instead of widening the canvas, so the
 * drawing surface stays exactly as wide as the panel and never scrolls sideways.
 * `endMs` is the right-hand anchor the view follows.
 */
export interface TimelineView {
	spanMs: number;
	endMs: number;
}

export const MIN_SPAN_MS = 1_000;
export const MAX_SPAN_MS = 24 * 60 * 60 * 1_000;

/** Height of one packed sub-row inside the single track. */
export const ROW_HEIGHT_PX = 26;
/** Sub-rows allowed before extra nodes share the last one instead of growing the panel. */
export const MAX_ROWS = 3;
/** Minimum on-screen width of an instant node. */
export const MIN_NODE_PX = 3;
/** Width of an open ended wait marker (never grows with time — no fake duration). */
export const WAIT_MARKER_PX = 8;

/** Right edge that keeps every node plus in-flight work visible. */
export function followEndMs(items: TimelineItem[], nowMs: number): number {
	let max = nowMs;
	for (const item of items) {
		const start = parseTime(item.startedAt);
		if (!Number.isFinite(start)) continue;
		const end = isOpenEnded(item) ? nowMs : start + resolveDurationMs(item, nowMs);
		if (end > max) max = end;
	}
	return max;
}

/** Width is always the panel width; density follows from the visible span. */
export function scaleFor(view: TimelineView, viewportWidth: number): LayoutScale {
	const span = Math.min(MAX_SPAN_MS, Math.max(MIN_SPAN_MS, view.spanMs));
	const width = Math.max(1, viewportWidth);
	return {
		pxPerMs: width / span,
		offsetMs: view.endMs - span,
		viewportWidth: width,
	};
}

/** Zoom around a pixel position so the time under the cursor stays put. */
export function zoomViewAt(
	view: TimelineView,
	factor: number,
	viewportWidth: number,
	anchorX: number,
): TimelineView {
	const scale = scaleFor(view, viewportWidth);
	const anchorTime = scale.offsetMs + anchorX / Math.max(1e-9, scale.pxPerMs);
	const span = Math.min(MAX_SPAN_MS, Math.max(MIN_SPAN_MS, view.spanMs * factor));
	const ratio = (view.endMs - anchorTime) / Math.max(1, view.spanMs);
	return { spanMs: span, endMs: anchorTime + span * ratio };
}

/** Span that covers every node, with a little breathing room. */
export function fitView(items: TimelineItem[], nowMs: number): TimelineView {
	const win = computeWindow(items, nowMs);
	return { spanMs: win.spanMs, endMs: win.endMs };
}

/**
 * Window for the current items.
 *
 * While the user has not zoomed, the span is content driven: it always covers every
 * node, so history loaded after boot is on screen instead of stranded to the left of
 * a stale window. Once the user zooms, the span is pinned until `Fit` hands control back.
 */
export function resolveView(
	items: TimelineItem[],
	nowMs: number,
	previous: TimelineView | null,
	follow: boolean,
	opts: { userAdjusted?: boolean } = {},
): TimelineView {
	const endMs = follow ? followEndMs(items, nowMs) : (previous?.endMs ?? followEndMs(items, nowMs));
	if (!previous) return fitView(items, nowMs);
	if (opts.userAdjusted) return { spanMs: previous.spanMs, endMs };
	return { spanMs: fitView(items, nowMs).spanMs, endMs };
}

export function computeWindow(items: TimelineItem[], nowMs: number): TimelineWindow {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const item of items) {
		const start = parseTime(item.startedAt);
		if (!Number.isFinite(start)) continue;
		min = Math.min(min, start);
		max = Math.max(max, start + resolveDurationMs(item, nowMs));
	}
	if (!Number.isFinite(min) || !Number.isFinite(max)) {
		return { startMs: nowMs - 60_000, endMs: nowMs, spanMs: 60_000 };
	}
	const span = Math.max(1_000, max - min);
	const pad = Math.max(250, span * 0.04);
	return { startMs: min - pad, endMs: max + pad, spanMs: span + pad * 2 };
}

export function xForTime(scale: LayoutScale, timeMs: number): number {
	return (timeMs - scale.offsetMs) * scale.pxPerMs;
}

export interface NodeGeometry {
	id: string;
	x: number;
	width: number;
	/** Open ended wait marker: pulse, and keep a fixed width. */
	marker: boolean;
}

export function geometryForItem(
	item: TimelineItem,
	scale: LayoutScale,
	nowMs: number,
	minWidth = MIN_NODE_PX,
): NodeGeometry {
	const start = parseTime(item.startedAt);
	if (!Number.isFinite(start)) return { id: item.id, x: 0, width: minWidth, marker: false };

	if (item.status === "waiting") {
		return {
			id: item.id,
			x: xForTime(scale, start),
			width: Math.max(minWidth, WAIT_MARKER_PX),
			marker: true,
		};
	}
	const duration = resolveDurationMs(item, nowMs);
	const width = Math.max(minWidth, duration * scale.pxPerMs);
	return { id: item.id, x: xForTime(scale, start), width, marker: duration === 0 };
}

export interface PackedNode extends NodeGeometry {
	/** Sub-row inside the track; overlapping nodes never share one. */
	row: number;
}

/**
 * Greedy interval packing so nodes that overlap in time occupy separate sub-rows
 * instead of hiding each other. Without it a compressed auto-fit view stacks every
 * zero-width message on the same few pixels.
 */
export function packRows(geoms: NodeGeometry[], gapPx = 2, maxRows = MAX_ROWS): PackedNode[] {
	const sorted = [...geoms].sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
	const rowEnds: number[] = [];
	const packed: PackedNode[] = [];
	for (const geom of sorted) {
		let row = rowEnds.findIndex((end) => geom.x >= end + gapPx);
		if (row < 0) {
			row = rowEnds.length < maxRows ? rowEnds.length : maxRows - 1;
			rowEnds[row] = Number.NEGATIVE_INFINITY;
		}
		rowEnds[row] = Math.max(rowEnds[row] ?? Number.NEGATIVE_INFINITY, geom.x + geom.width);
		packed.push({ ...geom, row });
	}
	return packed;
}

/** Rows needed by a packed set, clamped to `MAX_ROWS`. */
export function rowCount(packed: PackedNode[]): number {
	return packed.reduce((max, node) => Math.max(max, node.row + 1), 1);
}

/** Nice tick step (ms) for the current scale. */
export function tickStepMs(scale: LayoutScale): number {
	const targetPx = 90;
	const raw = targetPx / Math.max(1e-9, scale.pxPerMs);
	const steps = [
		100, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
		900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000,
	];
	for (const step of steps) {
		if (step >= raw) return step;
	}
	return 21_600_000;
}

export function ticksForScale(scale: LayoutScale, window: TimelineWindow): number[] {
	const step = tickStepMs(scale);
	const first = Math.ceil(window.startMs / step) * step;
	const out: number[] = [];
	for (let t = first; t <= window.endMs; t += step) {
		out.push(t);
		if (out.length > 200) break;
	}
	return out;
}

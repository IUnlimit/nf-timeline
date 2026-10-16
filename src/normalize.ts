/**
 * Small pure helpers shared by derivation, layout and rendering.
 */

import type { TimelineItem, TimelineStatus } from "./types";

/** Parse an ISO timestamp to ms; invalid → NaN. */
export function parseTime(iso: string | undefined): number {
	if (!iso) return Number.NaN;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : Number.NaN;
}

export function toIso(ms: number): string {
	return new Date(ms).toISOString();
}

/**
 * Effective duration: an explicit `durationMs` wins, otherwise end−start, otherwise
 * an in-flight node grows towards `nowMs`.
 */
export function resolveDurationMs(item: TimelineItem, nowMs: number): number {
	if (
		typeof item.durationMs === "number" &&
		Number.isFinite(item.durationMs) &&
		item.durationMs >= 0
	) {
		return item.durationMs;
	}
	const start = parseTime(item.startedAt);
	const end = parseTime(item.endedAt);
	if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, end - start);
	if (Number.isFinite(start) && isOpenEnded(item)) return Math.max(0, nowMs - start);
	return 0;
}

/** Whether a node is still in flight (terminal statuses are closed even without endedAt). */
export function isOpenEnded(item: TimelineItem): boolean {
	if (item.endedAt) return false;
	return item.status === "running" || item.status === "waiting" || item.status === "unknown";
}

export function normalizeStatus(raw: string | null | undefined): TimelineStatus {
	switch (raw) {
		case "success":
		case "completed":
		case "ok":
			return "success";
		case "fail":
		case "failed":
		case "error":
			return "fail";
		case "running":
		case "pending":
		case "initializing":
			return "running";
		case "waiting":
		case "paused":
			return "waiting";
		default:
			return "unknown";
	}
}

/**
 * Merge a derived item into the stable item map by id.
 * Idempotent: a later terminal revision wins over an earlier open one, and an
 * out-of-order older non-terminal frame never clobbers a terminal state.
 */
export function mergeItem(map: Map<string, TimelineItem>, next: TimelineItem): void {
	const prev = map.get(next.id);
	if (!prev) {
		map.set(next.id, { ...next });
		return;
	}
	const prevStart = parseTime(prev.startedAt);
	const nextStart = parseTime(next.startedAt);
	const terminal: TimelineStatus[] = ["success", "fail"];
	const nextTerminal = terminal.includes(next.status);
	const prevTerminal = terminal.includes(prev.status);
	if (
		Number.isFinite(prevStart) &&
		Number.isFinite(nextStart) &&
		nextStart <= prevStart &&
		!nextTerminal &&
		prevTerminal
	) {
		return;
	}

	const merged: TimelineItem = {
		...prev,
		...next,
	};
	// Earliest known start wins: it is the closest thing to a real start time.
	if (Number.isFinite(prevStart) && (!Number.isFinite(nextStart) || prevStart <= nextStart)) {
		merged.startedAt = prev.startedAt;
	}
	if (!merged.endedAt && prev.endedAt) merged.endedAt = prev.endedAt;
	if (typeof merged.durationMs !== "number" && typeof prev.durationMs === "number") {
		merged.durationMs = prev.durationMs;
	}
	if (!merged.errorMessage && prev.errorMessage) merged.errorMessage = prev.errorMessage;
	if (!merged.detail && prev.detail) merged.detail = prev.detail;
	if (!merged.toolName && prev.toolName) merged.toolName = prev.toolName;
	map.set(merged.id, merged);
}

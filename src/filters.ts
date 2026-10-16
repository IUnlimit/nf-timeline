/**
 * Filtering for the single-track timeline.
 *
 * The four category chips are a **union** ("show X"): any lit chip admits its own
 * nodes, so selecting several stitches them together instead of intersecting them
 * into an empty track. `currentTurn` is a separate *scope* switch applied on top.
 *
 * Turn markers and lifecycle transitions are structural context — they are exempt
 * from the category union (but still obey the current-turn scope), otherwise the
 * track would lose its time anchors as soon as a chip is toggled.
 */

import { parseTime } from "./normalize";
import type { TimelineItem } from "./types";

export interface TimelineFilter {
	tools: boolean;
	failures: boolean;
	waits: boolean;
	messages: boolean;
	/** Scope switch: intersected with the category union. */
	currentTurn: boolean;
}

export type CategoryKey = "tools" | "failures" | "waits" | "messages";
export type MatchKey = CategoryKey | "turn" | "lifecycle";

export const CATEGORY_KEYS: readonly CategoryKey[] = ["tools", "failures", "waits", "messages"];

/**
 * Shown when no category chip is lit. The message stream is the panel's backbone, so
 * it is visible by default: the track reads as turns, assistant replies and the
 * activity bands between them, with tool/wait nodes appearing as soon as they exist.
 */
export const DEFAULT_CATEGORIES: readonly CategoryKey[] = ["tools", "waits", "messages"];

export function defaultFilter(): TimelineFilter {
	return { tools: false, failures: false, waits: false, messages: false, currentTurn: false };
}

/** Lit categories, or the default set when none is lit. Never includes the context keys. */
export function activeCategories(filter: TimelineFilter): CategoryKey[] {
	const lit = CATEGORY_KEYS.filter((key) => filter[key]);
	return lit.length > 0 ? [...lit] : [...DEFAULT_CATEGORIES];
}

export function matchesCategory(item: TimelineItem, key: MatchKey): boolean {
	switch (key) {
		case "tools":
			return item.kind === "tool";
		case "waits":
			return item.kind === "permission" || item.kind === "attention" || item.status === "waiting";
		case "messages":
			return item.kind === "message";
		case "failures":
			return item.status === "fail";
		case "turn":
			return item.kind === "turn";
		case "lifecycle":
			return item.kind === "lifecycle";
	}
}

/** Context keys that survive every category selection. */
function isContext(item: TimelineItem): boolean {
	return item.kind === "turn" || item.kind === "lifecycle";
}

/** Time boundary of "the current turn": the newest turn marker in the window. */
export interface TurnScope {
	turnId?: string;
	since?: string;
}

export function detectCurrentTurn(items: TimelineItem[]): TurnScope {
	let latest: TimelineItem | undefined;
	for (const item of items) {
		if (item.kind !== "turn") continue;
		if (!latest || parseTime(item.startedAt) >= parseTime(latest.startedAt)) latest = item;
	}
	return latest ? { turnId: latest.id, since: latest.startedAt } : {};
}

/** Membership test with a 1s tolerance so ISO millisecond rounding cannot drop the boundary node. */
export function inCurrentTurn(item: TimelineItem, scope: TurnScope): boolean {
	if (!scope.since) return true;
	const since = parseTime(scope.since);
	const at = parseTime(item.startedAt);
	if (!Number.isFinite(since) || !Number.isFinite(at)) return true;
	return at >= since - 1_000;
}

export function isFilterActive(filter: TimelineFilter): boolean {
	return CATEGORY_KEYS.some((key) => filter[key]) || filter.currentTurn;
}

export function applyFilter(
	items: TimelineItem[],
	filter: TimelineFilter,
	scope: TurnScope = {},
): TimelineItem[] {
	const categories = activeCategories(filter);
	return items.filter((item) => {
		if (!isContext(item) && !categories.some((key) => matchesCategory(item, key))) return false;
		if (filter.currentTurn && !inCurrentTurn(item, scope)) return false;
		return true;
	});
}

export interface KindCounts {
	messages: number;
	tools: number;
	waits: number;
	failures: number;
	turns: number;
	total: number;
}

/** Counts for the status line and the per-chip counters. */
export function countByKind(items: TimelineItem[]): KindCounts {
	const counts: KindCounts = {
		messages: 0,
		tools: 0,
		waits: 0,
		failures: 0,
		turns: 0,
		total: items.length,
	};
	for (const item of items) {
		if (matchesCategory(item, "messages")) counts.messages += 1;
		if (matchesCategory(item, "tools")) counts.tools += 1;
		if (matchesCategory(item, "waits")) counts.waits += 1;
		if (matchesCategory(item, "failures")) counts.failures += 1;
		if (matchesCategory(item, "turn")) counts.turns += 1;
	}
	return counts;
}

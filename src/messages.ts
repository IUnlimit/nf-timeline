/**
 * Message stream → turn structure.
 *
 * The host protocol has no turn concept, so a turn is derived: a `user` message
 * opens one, everything after it (until the next `user` message) belongs to it.
 * Between two consecutive messages inside a turn the elapsed time is an *activity
 * gap* — the only honest way to show "work happened here" while the host exposes
 * neither tool history nor tool start times.
 */

import { parseTime } from "./normalize";
import type { ActivityGap, TimelineItem } from "./types";

/** Gaps shorter than this are noise from batching, not observable work. */
export const MIN_GAP_MS = 2_000;

/** Turn id used for messages that precede the first user message in the window. */
export const HEAD_TURN_ID = "turn:head";

export interface TurnBlock {
	id: string;
	/** 1-based position in the window; the head block is 0. */
	index: number;
	startedAt: string;
	endedAt?: string;
	messageCount: number;
	gapCount: number;
	gapMs: number;
	/** The 50-row window cut this turn's beginning off. */
	truncated: boolean;
}

export function timeSorted(items: TimelineItem[]): TimelineItem[] {
	return [...items].sort((a, b) => {
		const at = parseTime(a.startedAt);
		const bt = parseTime(b.startedAt);
		if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
		if (Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(at) ? -1 : 1;
		return a.id.localeCompare(b.id);
	});
}

/** Messages and turn markers in chronological order — the panel's spine. */
export function spineItems(items: TimelineItem[]): TimelineItem[] {
	return timeSorted(items).filter((item) => item.kind === "message" || item.kind === "turn");
}

export interface BuildTurnsOptions {
	/** True when `messages.list` likely returned a full page, cutting the head off. */
	windowTruncated?: boolean;
}

/**
 * Group the message spine into turns. `index` counts user messages, so the label of
 * the newest turn is exactly the number of prompts in the visible window.
 */
export function buildTurns(items: TimelineItem[], options: BuildTurnsOptions = {}): TurnBlock[] {
	const spine = spineItems(items);
	const turns: TurnBlock[] = [];
	let current: TurnBlock | null = null;

	for (const item of spine) {
		if (item.kind === "turn") {
			current = {
				id: item.id,
				// Renumbered below; the head block keeps index 0.
				index: 0,
				startedAt: item.startedAt,
				messageCount: 1,
				gapCount: 0,
				gapMs: 0,
				truncated: options.windowTruncated === true && turns.length === 0,
			};
			turns.push(current);
			continue;
		}
		if (!current) {
			current = {
				id: HEAD_TURN_ID,
				index: 0,
				startedAt: item.startedAt,
				messageCount: 0,
				gapCount: 0,
				gapMs: 0,
				truncated: options.windowTruncated === true,
			};
			turns.push(current);
		}
		current.messageCount += 1;
		current.endedAt = item.startedAt;
	}

	// Turn numbering is presentation-facing: 1..n for real turns, 0 for the head.
	let real = 0;
	for (const turn of turns) {
		if (turn.id === HEAD_TURN_ID) {
			turn.index = 0;
			continue;
		}
		real += 1;
		turn.index = real;
	}

	const gaps = activityGaps(spine);
	for (const gap of gaps) {
		const owner = turns.find((turn) => turn.id === gap.turnId);
		if (!owner) continue;
		owner.gapCount += 1;
		owner.gapMs += gap.toMs - gap.fromMs;
	}
	return turns;
}

/**
 * Activity bands between consecutive messages of the same turn.
 * Turn markers themselves are not boundaries, so a user message followed by an
 * assistant message yields one band covering the model's first response.
 */
export function activityGaps(items: TimelineItem[], minGapMs = MIN_GAP_MS): ActivityGap[] {
	const spine = spineItems(items);
	const gaps: ActivityGap[] = [];
	let turnId: string | null = null;
	let previousMs = Number.NaN;

	for (const item of spine) {
		if (item.kind === "turn") turnId = item.id;
		const at = parseTime(item.startedAt);
		if (
			turnId &&
			Number.isFinite(previousMs) &&
			Number.isFinite(at) &&
			at - previousMs >= minGapMs
		) {
			gaps.push({
				id: `gap:${turnId}:${previousMs}`,
				turnId,
				fromMs: previousMs,
				toMs: at,
			});
		}
		if (Number.isFinite(at)) previousMs = at;
	}
	return gaps;
}

/** Newest timestamp across every node — used to decide whether the session is active. */
export function latestActivityMs(items: TimelineItem[]): number {
	let latest = Number.NaN;
	for (const item of items) {
		const end = parseTime(item.endedAt) || parseTime(item.startedAt);
		if (Number.isFinite(end) && (!Number.isFinite(latest) || end > latest)) latest = end;
	}
	return latest;
}

/** Turn containing `timeMs`, if any turn does. */
export function turnAt(turns: TurnBlock[], timeMs: number): TurnBlock | undefined {
	let found: TurnBlock | undefined;
	for (const turn of turns) {
		const start = parseTime(turn.startedAt);
		if (Number.isFinite(start) && start <= timeMs) found = turn;
	}
	return found;
}

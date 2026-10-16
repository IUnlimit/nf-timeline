/**
 * Observation store.
 *
 * The host exposes no tool-call history query and delivers no tool events in 0.9.1,
 * so anything this panel ever learns lives only as long as the iframe. Persisting the
 * *derived* observation (labels, statuses, timestamps, durations — never message text)
 * into host plugin storage is what makes the timeline survive a panel reopen.
 *
 * Budget: the host caps a single value at 64 KiB and a scope at 1 MiB, so the payload
 * is kept under `MAX_VALUE_BYTES` and shrunk by halving when it does not fit.
 */

import type { TimelineItem } from "./types";

export const STORE_VERSION = 1 as const;
export const MAX_TOOLS = 200;
export const MAX_TURNS = 40;
/** Serialized payload budget, comfortably under the host's 64 KiB per-value cap. */
export const MAX_VALUE_BYTES = 48 * 1024;

export interface PersistedTool {
	id: string;
	toolUseId?: string;
	toolName: string;
	status: string;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	executionDeviceId?: string;
	error?: string;
}

export interface PersistedTurn {
	id: string;
	index: number;
	startedAt: string;
	endedAt?: string;
	messageCount: number;
	gapMs: number;
}

export interface PersistedChannel {
	subscribedAt?: string;
	delivered: number;
	lastEventAt?: string;
	lastPollAt?: string;
	lastError?: string;
}

export interface PersistedTimeline {
	version: typeof STORE_VERSION;
	narratorId: string;
	updatedAt: string;
	tools: PersistedTool[];
	turns: PersistedTurn[];
	channel: PersistedChannel;
}

export function emptyPersisted(
	narratorId: string,
	now = new Date().toISOString(),
): PersistedTimeline {
	return {
		version: STORE_VERSION,
		narratorId,
		updatedAt: now,
		tools: [],
		turns: [],
		channel: { delivered: 0 },
	};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Decode a stored value defensively: anything unreadable collapses into an empty
 * observation for this narrator rather than throwing at boot.
 */
export function decodeStored(value: unknown, narratorId: string): PersistedTimeline {
	if (!value || typeof value !== "object") return emptyPersisted(narratorId);
	const raw = value as Record<string, unknown>;
	if (raw.version !== STORE_VERSION) return emptyPersisted(narratorId);
	if (asString(raw.narratorId) !== narratorId) return emptyPersisted(narratorId);

	const tools: PersistedTool[] = [];
	if (Array.isArray(raw.tools)) {
		for (const entry of raw.tools) {
			if (!entry || typeof entry !== "object") continue;
			const tool = entry as Record<string, unknown>;
			const id = asString(tool.id);
			const startedAt = asString(tool.startedAt);
			if (!id || !startedAt) continue;
			tools.push({
				id,
				...(asString(tool.toolUseId) ? { toolUseId: asString(tool.toolUseId) } : {}),
				toolName: asString(tool.toolName) ?? "tool",
				status: asString(tool.status) ?? "unknown",
				startedAt,
				...(asString(tool.endedAt) ? { endedAt: asString(tool.endedAt) } : {}),
				...(asNumber(tool.durationMs) !== undefined
					? { durationMs: asNumber(tool.durationMs) }
					: {}),
				...(asString(tool.executionDeviceId)
					? { executionDeviceId: asString(tool.executionDeviceId) }
					: {}),
				...(asString(tool.error) ? { error: asString(tool.error) } : {}),
			});
		}
	}

	const turns: PersistedTurn[] = [];
	if (Array.isArray(raw.turns)) {
		for (const entry of raw.turns) {
			if (!entry || typeof entry !== "object") continue;
			const turn = entry as Record<string, unknown>;
			const id = asString(turn.id);
			const startedAt = asString(turn.startedAt);
			if (!id || !startedAt) continue;
			turns.push({
				id,
				index: asNumber(turn.index) ?? 0,
				startedAt,
				...(asString(turn.endedAt) ? { endedAt: asString(turn.endedAt) } : {}),
				messageCount: asNumber(turn.messageCount) ?? 0,
				gapMs: asNumber(turn.gapMs) ?? 0,
			});
		}
	}

	const channelRaw =
		raw.channel && typeof raw.channel === "object" ? (raw.channel as Record<string, unknown>) : {};
	const channel: PersistedChannel = { delivered: asNumber(channelRaw.delivered) ?? 0 };
	if (asString(channelRaw.subscribedAt)) channel.subscribedAt = asString(channelRaw.subscribedAt);
	if (asString(channelRaw.lastEventAt)) channel.lastEventAt = asString(channelRaw.lastEventAt);
	if (asString(channelRaw.lastPollAt)) channel.lastPollAt = asString(channelRaw.lastPollAt);
	if (asString(channelRaw.lastError)) channel.lastError = asString(channelRaw.lastError);

	return {
		version: STORE_VERSION,
		narratorId,
		updatedAt: asString(raw.updatedAt) ?? new Date().toISOString(),
		tools: tools.slice(-MAX_TOOLS),
		turns: turns.slice(-MAX_TURNS),
		channel,
	};
}

/** Tool nodes worth persisting: real tool calls only, oldest first, capped. */
export function persistedTools(items: TimelineItem[]): PersistedTool[] {
	const tools: PersistedTool[] = [];
	for (const item of items) {
		if (item.kind !== "tool") continue;
		tools.push({
			id: item.id,
			...(item.toolUseId ? { toolUseId: item.toolUseId } : {}),
			toolName: item.toolName ?? item.label,
			status: item.status,
			startedAt: item.startedAt,
			...(item.endedAt ? { endedAt: item.endedAt } : {}),
			...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
			...(item.executionDeviceId ? { executionDeviceId: item.executionDeviceId } : {}),
			...(item.errorMessage ? { error: item.errorMessage.slice(0, 200) } : {}),
		});
	}
	return tools.sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-MAX_TOOLS);
}

export function utf8Bytes(value: unknown): number {
	const text = JSON.stringify(value) ?? "";
	return new TextEncoder().encode(text).length;
}

/**
 * Recover absolute turn numbering: storage remembers turns from earlier windows, so a
 * reopened panel keeps counting instead of restarting at 1.
 *
 * Two cases:
 *   - the window and the stored turns overlap → the offset that aligns them wins;
 *   - nothing overlaps and the stored window ends before ours starts → counting
 *     continues from the newest stored turn;
 *   - otherwise the numbering stays window relative (0).
 */
export function turnOffsetFor(
	turns: Array<{ id: string; index: number; startedAt: string }>,
	persisted: PersistedTimeline,
): number {
	const byId = new Map(persisted.turns.map((turn) => [turn.id, turn.index]));
	let matched = 0;
	let overlapped = false;
	for (const turn of turns) {
		const absolute = byId.get(turn.id);
		if (absolute === undefined) continue;
		overlapped = true;
		matched = Math.max(matched, absolute - turn.index);
	}
	if (overlapped) return matched;

	const storedNewest = persisted.turns[persisted.turns.length - 1];
	const windowOldest = turns[0];
	if (!storedNewest || !windowOldest) return 0;
	const storedEnd = Date.parse(storedNewest.endedAt ?? storedNewest.startedAt);
	const windowStart = Date.parse(windowOldest.startedAt);
	if (Number.isFinite(storedEnd) && Number.isFinite(windowStart) && storedEnd <= windowStart) {
		return storedNewest.index;
	}
	return 0;
}

/**
 * Shrink the payload until it fits the budget: oldest tools and turns are dropped
 * first, and the round-trip stops as soon as the encoded size is acceptable.
 */
export function trimToBudget(
	state: PersistedTimeline,
	maxBytes = MAX_VALUE_BYTES,
	measure: (value: PersistedTimeline) => number = utf8Bytes,
): { state: PersistedTimeline; fits: boolean } {
	let current = state;
	for (let attempt = 0; attempt < 4; attempt += 1) {
		if (measure(current) <= maxBytes) return { state: current, fits: true };
		const toolCount = Math.floor(current.tools.length / 2);
		const turnCount = Math.floor(current.turns.length / 2);
		current = {
			...current,
			tools: toolCount > 0 ? current.tools.slice(-toolCount) : [],
			turns: turnCount > 0 ? current.turns.slice(-turnCount) : [],
		};
	}
	return { state: current, fits: measure(current) <= maxBytes };
}

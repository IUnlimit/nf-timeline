/**
 * Public event → timeline node derivation.
 *
 * Every field read here is part of the verified host contract
 * (`server/services/plugin-event-gateway.ts`, default mapper):
 *
 *   tool.changed       { narratorId, toolUseId, toolName, status: "success"|"fail",
 *                        durationMs?, executionDeviceId?, errorMessage? }
 *   message.changed    { narratorId, role }
 *   lifecycle          { narratorId, status, substatus? } | { narratorId, changeKind, status? }
 *   attention          { narratorId, reason, state: "raised"|"resolved", detail? }
 *   permission.changed { narratorId, requestId, state: "pending" }
 *
 * The host emits tool frames **once, at terminal state** and never sends a start
 * timestamp: a real `startedAt` has to be back-computed from `durationMs`.
 */

import { mergeItem, normalizeStatus, parseTime, toIso } from "./normalize";
import type {
	AttentionData,
	LifecycleData,
	MessageChangedData,
	MessageSummary,
	PermissionChangedData,
	PublicEvent,
	TimelineItem,
	TimelineStatus,
	ToolChangedData,
} from "./types";

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Narrator an event belongs to, preferring the resource binding over the payload. */
export function eventNarratorId(event: PublicEvent): string | undefined {
	return asString(event.resource?.narratorId) ?? asString(event.data.narratorId);
}

/** Control frames that only ask the client to rebuild its window. */
export function isResyncEvent(event: PublicEvent): boolean {
	return event.topic === "narrafork.events.resync_required" || Boolean(event.resyncHint);
}

function toolData(event: PublicEvent): ToolChangedData {
	const data = event.data;
	return {
		narratorId: asString(data.narratorId),
		toolUseId: asString(data.toolUseId),
		toolName: asString(data.toolName),
		status: asString(data.status),
		durationMs: asFiniteNumber(data.durationMs),
		executionDeviceId: asString(data.executionDeviceId),
		errorMessage: asString(data.errorMessage),
	};
}

/**
 * Stable node id for a tool frame. `toolUseId` is the host's anchor and is present in
 * practice; a frame without it still gets its own node instead of collapsing every
 * call into one shared placeholder.
 */
export function toolNodeId(event: PublicEvent): string {
	const id = toolData(event).toolUseId;
	return id ? `tool:${id}` : `tool:evt-${event.eventId}`;
}

export function toolItemFromEvent(event: PublicEvent): TimelineItem {
	const data = toolData(event);
	const status = normalizeStatus(data.status);
	const occurredMs = parseTime(event.occurredAt);
	const item: TimelineItem = {
		id: toolNodeId(event),
		kind: "tool",
		label: data.toolName ?? "tool",
		status,
		startedAt: event.occurredAt,
		toolName: data.toolName,
	};
	if (data.toolUseId) item.toolUseId = data.toolUseId;
	if (data.executionDeviceId) item.executionDeviceId = data.executionDeviceId;
	if (data.errorMessage) item.errorMessage = data.errorMessage;

	// The host sends no start time. With a duration the start can be reconstructed
	// exactly; without one the frame's own timestamp is the only honest anchor.
	if (typeof data.durationMs === "number" && Number.isFinite(occurredMs)) {
		item.durationMs = data.durationMs;
		item.startedAt = toIso(Math.max(0, occurredMs - data.durationMs));
	}
	if (status === "success" || status === "fail") item.endedAt = event.occurredAt;
	return item;
}

function baseMarker(
	event: PublicEvent,
	id: string,
	kind: TimelineItem["kind"],
	label: string,
	status: TimelineStatus,
): TimelineItem {
	return {
		id,
		kind,
		label,
		status,
		startedAt: event.occurredAt,
		endedAt: event.occurredAt,
		durationMs: 0,
	};
}

/** Permission requests stay `pending` forever: the host never publishes a resolution. */
export function permissionItemFromEvent(event: PublicEvent): TimelineItem {
	const data = event.data as PermissionChangedData;
	const requestId = asString(data.requestId) ?? event.eventId;
	const item = baseMarker(event, `perm:${requestId}`, "permission", "permission", "waiting");
	item.durationMs = undefined;
	item.endedAt = undefined;
	item.detail = "pending";
	return item;
}

/**
 * Attention markers are keyed by reason so a `resolved` frame merges into the
 * `raised` one instead of leaving a permanent waiting node behind.
 */
export function attentionItemFromEvent(event: PublicEvent): TimelineItem {
	const data = event.data as AttentionData;
	const reason = asString(data.reason) ?? "attention";
	const state = asString(data.state) ?? "raised";
	const narratorId = eventNarratorId(event) ?? "unknown";
	const resolved = state === "resolved";
	const item: TimelineItem = {
		id: `attn:${narratorId}:${reason}`,
		kind: "attention",
		label: reason,
		status: resolved ? "success" : "waiting",
		startedAt: event.occurredAt,
		detail: asString(data.detail) ?? reason,
	};
	if (resolved) {
		item.endedAt = event.occurredAt;
		item.durationMs = 0;
	}
	return item;
}

/**
 * Lifecycle transitions become zero-width markers: one marker per transition.
 * An earlier version kept a single rolling node per narrator, which grew into a bar
 * spanning the whole session and dwarfed everything else on the track.
 */
export function lifecycleItemFromEvent(event: PublicEvent): TimelineItem {
	const data = event.data as LifecycleData;
	const change = asString(data.changeKind) ?? asString(data.status) ?? "unknown";
	const status = normalizeStatus(asString(data.status) ?? change);
	const item = baseMarker(
		event,
		`life:${event.eventId}`,
		"lifecycle",
		change,
		status === "unknown" ? "success" : status,
	);
	if (data.substatus && data.substatus.length > 0) item.detail = data.substatus.join(", ");
	return item;
}

/**
 * `message.changed` carries no message id, so it never becomes a node here: the
 * caller re-reads `messages.list` instead (see index.ts), which yields real ids and
 * text and cannot double a message up.
 */
export function messageChangedNarrator(event: PublicEvent): string | undefined {
	const data = event.data as MessageChangedData;
	return eventNarratorId(event) ?? asString(data.narratorId);
}

export function messageItemFromSummary(row: MessageSummary): TimelineItem {
	// A user message *is* the turn boundary; everything else is a message inside it.
	const kind: TimelineItem["kind"] = row.role === "user" ? "turn" : "message";
	const item: TimelineItem = {
		id: `msg:${row.id}`,
		kind,
		label: row.role,
		role: row.role,
		status: "success",
		startedAt: row.createdAt,
		endedAt: row.createdAt,
		durationMs: 0,
		messageId: row.id,
	};
	if (row.text) item.detail = row.text;
	return item;
}

/** Map one public event to zero or more timeline items. */
export function itemsFromEvent(event: PublicEvent): TimelineItem[] {
	switch (event.topic) {
		case "narrafork.narrator.tool.changed":
			return [toolItemFromEvent(event)];
		case "narrafork.narrator.permission.changed":
			return [permissionItemFromEvent(event)];
		case "narrafork.narrator.attention":
			return [attentionItemFromEvent(event)];
		case "narrafork.narrator.lifecycle":
			return [lifecycleItemFromEvent(event)];
		default:
			return [];
	}
}

/** Merge a batch of derived items into the panel's item map. */
export function mergeItems(map: Map<string, TimelineItem>, items: TimelineItem[]): boolean {
	let changed = false;
	for (const item of items) {
		mergeItem(map, item);
		changed = true;
	}
	return changed;
}

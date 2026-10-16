/**
 * Contract guard for public-event → node derivation.
 *
 * Every field read here is the host's real payload
 * (`server/services/plugin-event-gateway.ts`, default mapper). The previous
 * implementation resolved fields through an alias table because the payload shape
 * had never been verified; that guessing is gone, and these cases pin the real names
 * so a silent re-introduction of guessing fails loudly.
 */

import { describe, expect, test } from "bun:test";
import {
	attentionItemFromEvent,
	eventNarratorId,
	isResyncEvent,
	itemsFromEvent,
	lifecycleItemFromEvent,
	mergeItems,
	messageChangedNarrator,
	messageItemFromSummary,
	permissionItemFromEvent,
	toolItemFromEvent,
	toolNodeId,
} from "../src/derive";
import type { PublicEvent, TimelineItem } from "../src/types";

function event(partial: Partial<PublicEvent> & { topic: PublicEvent["topic"] }): PublicEvent {
	return {
		schema: "narrafork.public-event",
		schemaVersion: 1,
		eventId: "evt_1",
		eventClass: "state",
		occurredAt: "2026-10-16T10:00:10.000Z",
		data: {},
		redaction: "user_scoped",
		...partial,
	};
}

function toolEvent(partial: Partial<PublicEvent> & { data: Record<string, unknown> }): PublicEvent {
	return event({
		topic: "narrafork.narrator.tool.changed",
		resource: { type: "narrator", id: "nr1", narratorId: "nr1" },
		...partial,
	});
}

describe("tool.changed", () => {
	test("node id is tool:<toolUseId> — the host's real field name", () => {
		const item = toolItemFromEvent(
			toolEvent({
				data: { narratorId: "nr1", toolUseId: "tu_9", toolName: "Bash", status: "success" },
			}),
		);
		expect(item.id).toBe("tool:tu_9");
		expect(toolNodeId(toolEvent({ data: { toolUseId: "tu_9" } }))).toBe("tool:tu_9");
	});

	test("durationMs reconstructs the start time the host never sends", () => {
		const item = toolItemFromEvent(
			toolEvent({
				data: { toolUseId: "tu1", toolName: "Bash", status: "success", durationMs: 6_800 },
				occurredAt: "2026-10-16T10:00:10.000Z",
			}),
		);
		expect(item.startedAt).toBe("2026-10-16T10:00:03.200Z");
		expect(item.endedAt).toBe("2026-10-16T10:00:10.000Z");
		expect(item.durationMs).toBe(6_800);
		expect(item.status).toBe("success");
	});

	test("without a duration the frame timestamp is the only honest anchor", () => {
		const item = toolItemFromEvent(
			toolEvent({ data: { toolUseId: "tu1", toolName: "Read", status: "success" } }),
		);
		expect(item.startedAt).toBe("2026-10-16T10:00:10.000Z");
		expect(item.endedAt).toBe("2026-10-16T10:00:10.000Z");
		expect(item.durationMs).toBeUndefined();
	});

	test("failures keep the bounded error summary and are never re-labelled", () => {
		const item = toolItemFromEvent(
			toolEvent({
				data: { toolUseId: "tu2", toolName: "Bash", status: "fail", errorMessage: "exit 1" },
			}),
		);
		expect(item.status).toBe("fail");
		expect(item.errorMessage).toBe("exit 1");
	});

	test("a frame without toolUseId still gets its own node", () => {
		const a = toolItemFromEvent(
			toolEvent({ eventId: "e1", data: { toolName: "Bash", status: "success" } }),
		);
		const b = toolItemFromEvent(
			toolEvent({ eventId: "e2", data: { toolName: "Bash", status: "success" } }),
		);
		expect(a.id).toBe("tool:evt-e1");
		expect(b.id).toBe("tool:evt-e2");
		expect(a.id).not.toBe(b.id);
	});

	test("device ids survive", () => {
		const item = toolItemFromEvent(
			toolEvent({
				data: { toolUseId: "tu3", toolName: "Bash", status: "success", executionDeviceId: "dev_1" },
			}),
		);
		expect(item.executionDeviceId).toBe("dev_1");
	});
});

describe("permission.changed", () => {
	test("a pending request becomes an open waiting marker", () => {
		const item = permissionItemFromEvent(
			event({
				topic: "narrafork.narrator.permission.changed",
				resource: { type: "narrator", id: "nr1", narratorId: "nr1" },
				data: { narratorId: "nr1", requestId: "req_1", state: "pending" },
			}),
		);
		expect(item.id).toBe("perm:req_1");
		expect(item.kind).toBe("permission");
		expect(item.status).toBe("waiting");
		// The host never publishes a resolution, so the node must not claim an end.
		expect(item.endedAt).toBeUndefined();
	});
});

describe("attention", () => {
	test("raised and resolved merge into one node keyed by reason", () => {
		const raised = attentionItemFromEvent(
			event({
				topic: "narrafork.narrator.attention",
				eventId: "e1",
				resource: { type: "narrator", id: "nr1", narratorId: "nr1" },
				data: {
					narratorId: "nr1",
					reason: "waiting_permission",
					state: "raised",
					detail: "waiting",
				},
			}),
		);
		const resolved = attentionItemFromEvent(
			event({
				topic: "narrafork.narrator.attention",
				eventId: "e2",
				occurredAt: "2026-10-16T10:00:20.000Z",
				resource: { type: "narrator", id: "nr1", narratorId: "nr1" },
				data: { narratorId: "nr1", reason: "waiting_permission", state: "resolved" },
			}),
		);
		expect(raised.id).toBe(resolved.id);
		expect(raised.status).toBe("waiting");
		expect(resolved.status).toBe("success");

		const map = new Map<string, TimelineItem>();
		mergeItems(map, [raised]);
		mergeItems(map, [resolved]);
		const merged = map.get(raised.id);
		expect(merged?.status).toBe("success");
		expect(merged?.startedAt).toBe("2026-10-16T10:00:10.000Z");
		expect(merged?.endedAt).toBe("2026-10-16T10:00:20.000Z");
	});
});

describe("lifecycle", () => {
	test("each transition is its own bounded marker, never a rolling bar", () => {
		const first = lifecycleItemFromEvent(
			event({
				topic: "narrafork.narrator.lifecycle",
				eventId: "e1",
				resource: { type: "narrator", id: "nr1", narratorId: "nr1" },
				data: { narratorId: "nr1", status: "working", substatus: ["tool"] },
			}),
		);
		const second = lifecycleItemFromEvent(
			event({
				topic: "narrafork.narrator.lifecycle",
				eventId: "e2",
				occurredAt: "2026-10-16T10:05:00.000Z",
				resource: { type: "narrator", id: "nr1", narratorId: "nr1" },
				data: { narratorId: "nr1", changeKind: "error", status: "error" },
			}),
		);
		expect(first.id).not.toBe(second.id);
		expect(first.endedAt).toBe(first.startedAt);
		expect(first.durationMs).toBe(0);
		expect(first.detail).toBe("tool");
		expect(second.status).toBe("fail");
	});
});

describe("messages", () => {
	test("a user message is the turn boundary, everything else is a message", () => {
		const user = messageItemFromSummary({
			id: "m1",
			role: "user",
			text: "do the thing",
			createdAt: "2026-10-16T10:00:00.000Z",
		});
		const assistant = messageItemFromSummary({
			id: "m2",
			role: "assistant",
			text: "on it",
			createdAt: "2026-10-16T10:00:05.000Z",
		});
		expect(user.kind).toBe("turn");
		expect(assistant.kind).toBe("message");
		expect(user.id).toBe("msg:m1");
		expect(assistant.messageId).toBe("m2");
		expect(assistant.detail).toBe("on it");
	});

	test("message.changed carries no message id, so it never becomes a node", () => {
		const changed = event({
			topic: "narrafork.narrator.message.changed",
			resource: { type: "narrator", id: "nr1", narratorId: "nr1" },
			data: { narratorId: "nr1", role: "assistant" },
		});
		expect(itemsFromEvent(changed)).toEqual([]);
		expect(messageChangedNarrator(changed)).toBe("nr1");
	});
});

describe("batch behaviour", () => {
	test("itemsFromEvent routes every subscribed topic and ignores the rest", () => {
		const tool = toolEvent({ data: { toolUseId: "tu1", toolName: "Bash", status: "success" } });
		expect(itemsFromEvent(tool)).toHaveLength(1);
		expect(
			itemsFromEvent({
				...event({ topic: "narrafork.narrator.tool.changed", data: { toolUseId: "x" } }),
				topic: "narrafork.plugin.lifecycle",
			} as unknown as PublicEvent),
		).toEqual([]);
	});

	test("resync frames are recognized structurally, not by topic alone", () => {
		expect(
			isResyncEvent(event({ topic: "narrafork.events.resync_required", redaction: "public" })),
		).toBe(true);
		const overflow = {
			...event({ topic: "narrafork.narrator.tool.changed", data: {} }),
			resyncHint: { queryId: "narrafork.events.resync_required" },
		} as PublicEvent;
		expect(isResyncEvent(overflow)).toBe(true);
		expect(isResyncEvent(toolEvent({ data: { toolUseId: "x" } }))).toBe(false);
	});

	test("the narrator is read from the resource binding first", () => {
		expect(eventNarratorId(toolEvent({ data: { narratorId: "payload" } }))).toBe("nr1");
		const withoutResource = event({
			topic: "narrafork.narrator.tool.changed",
			data: { narratorId: "payload" },
		});
		expect(eventNarratorId(withoutResource)).toBe("payload");
	});
});

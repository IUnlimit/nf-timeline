import { describe, expect, test } from "bun:test";
import {
	decodeStored,
	emptyPersisted,
	MAX_TURNS,
	MAX_VALUE_BYTES,
	persistedTools,
	trimToBudget,
	utf8Bytes,
} from "../src/store";
import type { TimelineItem } from "../src/types";

function toolItem(id: string, partial: Partial<TimelineItem> = {}): TimelineItem {
	return {
		id: `tool:${id}`,
		kind: "tool",
		label: "Bash",
		toolName: "Bash",
		status: "success",
		startedAt: "2026-10-16T10:00:00.000Z",
		endedAt: "2026-10-16T10:00:02.000Z",
		durationMs: 2_000,
		...partial,
	};
}

describe("decodeStored", () => {
	test("garbage, wrong version and wrong narrator all collapse to empty", () => {
		expect(decodeStored(undefined, "n1").tools).toEqual([]);
		expect(decodeStored("nope", "n1").tools).toEqual([]);
		expect(decodeStored({ version: 2, narratorId: "n1" }, "n1").tools).toEqual([]);
		expect(decodeStored({ version: 1, narratorId: "other" }, "n1").tools).toEqual([]);
	});

	test("a stored observation round-trips", () => {
		const stored = {
			...emptyPersisted("n1"),
			tools: [
				{
					id: "tool:tu1",
					toolUseId: "tu1",
					toolName: "Bash",
					status: "success",
					startedAt: "2026-10-16T10:00:00.000Z",
					endedAt: "2026-10-16T10:00:02.000Z",
					durationMs: 2_000,
					executionDeviceId: "dev_1",
				},
				{ id: "broken" },
			],
			turns: [
				{
					id: "msg:u1",
					index: 3,
					startedAt: "2026-10-16T10:00:00.000Z",
					messageCount: 4,
					gapMs: 12_000,
				},
				{ index: 9 },
			],
			channel: { delivered: 7, subscribedAt: "2026-10-16T10:00:00.000Z" },
		};
		const decoded = decodeStored(stored, "n1");
		expect(decoded.tools).toHaveLength(1);
		expect(decoded.tools[0]?.toolUseId).toBe("tu1");
		expect(decoded.turns).toHaveLength(1);
		expect(decoded.turns[0]?.index).toBe(3);
		expect(decoded.channel.delivered).toBe(7);
	});
});

describe("persistedTools", () => {
	test("only tool nodes are persisted and they are ordered oldest first", () => {
		const items: TimelineItem[] = [
			toolItem("b", { startedAt: "2026-10-16T10:05:00.000Z" }),
			{
				id: "msg:1",
				kind: "message",
				label: "assistant",
				status: "success",
				startedAt: "2026-10-16T10:00:00.000Z",
				detail: "secret text",
			},
			toolItem("a", { startedAt: "2026-10-16T10:00:00.000Z" }),
		];
		const tools = persistedTools(items);
		expect(tools.map((tool) => tool.id)).toEqual(["tool:a", "tool:b"]);
	});

	test("message text never reaches storage", () => {
		const items: TimelineItem[] = [
			{
				id: "msg:1",
				kind: "message",
				label: "assistant",
				status: "success",
				startedAt: "2026-10-16T10:00:00.000Z",
				detail: "SUPER-SECRET-PROMPT-TEXT",
			},
			toolItem("a"),
		];
		const payload = JSON.stringify({
			...emptyPersisted("n1"),
			tools: persistedTools(items),
		});
		expect(payload).not.toContain("SUPER-SECRET-PROMPT-TEXT");
	});

	test("the tool list is capped", () => {
		const items = Array.from({ length: 260 }, (_, i) =>
			toolItem(`t${String(i).padStart(3, "0")}`, {
				startedAt: new Date(Date.parse("2026-10-16T10:00:00.000Z") + i * 1_000).toISOString(),
			}),
		);
		expect(persistedTools(items)).toHaveLength(200);
	});
});

describe("trimToBudget", () => {
	test("a small payload is returned untouched", () => {
		const state = { ...emptyPersisted("n1"), tools: persistedTools([toolItem("a")]) };
		const result = trimToBudget(state);
		expect(result.fits).toBe(true);
		expect(result.state.tools).toHaveLength(1);
	});

	test("an oversized payload is halved until it fits", () => {
		const state = {
			...emptyPersisted("n1"),
			tools: persistedTools(
				Array.from({ length: 200 }, (_, i) =>
					toolItem(`t${i}`, {
						startedAt: new Date(Date.parse("2026-10-16T10:00:00.000Z") + i * 1_000).toISOString(),
						errorMessage: "x".repeat(300),
					}),
				),
			),
			turns: Array.from({ length: MAX_TURNS }, (_, i) => ({
				id: `msg:u${i}`,
				index: i,
				startedAt: "2026-10-16T10:00:00.000Z",
				messageCount: 2,
				gapMs: 1_000,
			})),
		};
		expect(utf8Bytes(state)).toBeGreaterThan(MAX_VALUE_BYTES);
		const result = trimToBudget(state);
		expect(result.fits).toBe(true);
		expect(utf8Bytes(result.state)).toBeLessThanOrEqual(MAX_VALUE_BYTES);
		expect(result.state.tools.length).toBeLessThan(200);
	});

	test("an impossible budget reports failure instead of lying", () => {
		const state = {
			...emptyPersisted("n1"),
			tools: persistedTools([toolItem("a")]),
		};
		const result = trimToBudget(state, 5);
		expect(result.fits).toBe(false);
		expect(result.state.tools).toEqual([]);
	});
});

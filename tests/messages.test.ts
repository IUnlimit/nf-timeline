import { describe, expect, test } from "bun:test";
import {
	activityGaps,
	buildTurns,
	HEAD_TURN_ID,
	latestActivityMs,
	MIN_GAP_MS,
	spineItems,
	turnAt,
} from "../src/messages";
import type { TimelineItem } from "../src/types";

function node(partial: Partial<TimelineItem> & { id: string }): TimelineItem {
	return {
		kind: "message",
		label: "assistant",
		status: "success",
		startedAt: "2026-10-16T10:00:00.000Z",
		...partial,
	};
}

function userMessage(id: string, at: string): TimelineItem {
	return node({
		id: `msg:${id}`,
		kind: "turn",
		role: "user",
		startedAt: at,
		endedAt: at,
		durationMs: 0,
	});
}

function assistant(id: string, at: string): TimelineItem {
	return node({ id: `msg:${id}`, kind: "message", role: "assistant", startedAt: at, endedAt: at });
}

describe("buildTurns", () => {
	test("a user message opens a turn and later messages belong to it", () => {
		const turns = buildTurns([
			userMessage("u1", "2026-10-16T10:00:00.000Z"),
			assistant("a1", "2026-10-16T10:00:30.000Z"),
			assistant("a2", "2026-10-16T10:01:00.000Z"),
			userMessage("u2", "2026-10-16T10:05:00.000Z"),
			assistant("a3", "2026-10-16T10:05:10.000Z"),
		]);
		expect(turns).toHaveLength(2);
		expect(turns[0]?.id).toBe("msg:u1");
		expect(turns[0]?.messageCount).toBe(3);
		expect(turns[0]?.endedAt).toBe("2026-10-16T10:01:00.000Z");
		expect(turns[1]?.messageCount).toBe(2);
		expect(turns[0]?.index).toBe(1);
		expect(turns[1]?.index).toBe(2);
	});

	test("messages before the first user message land in a head block numbered zero", () => {
		const turns = buildTurns([
			assistant("s0", "2026-10-16T09:59:00.000Z"),
			userMessage("u1", "2026-10-16T10:00:00.000Z"),
		]);
		expect(turns[0]?.id).toBe(HEAD_TURN_ID);
		expect(turns[0]?.index).toBe(0);
		expect(turns[1]?.index).toBe(1);
	});

	test("a truncated window marks the oldest turn", () => {
		const turns = buildTurns(
			[
				userMessage("u1", "2026-10-16T10:00:00.000Z"),
				userMessage("u2", "2026-10-16T10:05:00.000Z"),
			],
			{ windowTruncated: true },
		);
		expect(turns[0]?.truncated).toBe(true);
		expect(turns[1]?.truncated).toBe(false);
	});

	test("gap totals are attributed to the turn that owns them", () => {
		const turns = buildTurns([
			userMessage("u1", "2026-10-16T10:00:00.000Z"),
			assistant("a1", "2026-10-16T10:00:30.000Z"),
		]);
		expect(turns[0]?.gapCount).toBe(1);
		expect(turns[0]?.gapMs).toBe(30_000);
	});
});

describe("activityGaps", () => {
	test("only gaps at or above the threshold become bands", () => {
		const items = [
			userMessage("u1", "2026-10-16T10:00:00.000Z"),
			assistant("a1", "2026-10-16T10:00:01.000Z"),
			assistant("a2", "2026-10-16T10:02:00.000Z"),
		];
		const gaps = activityGaps(items);
		expect(gaps).toHaveLength(1);
		expect(gaps[0]?.fromMs).toBe(Date.parse("2026-10-16T10:00:01.000Z"));
		expect(gaps[0]?.toMs).toBe(Date.parse("2026-10-16T10:02:00.000Z"));
		expect(gaps[0]?.turnId).toBe("msg:u1");
	});

	test("the threshold is configurable and a turn boundary is not a gap source", () => {
		const items = [
			userMessage("u1", "2026-10-16T10:00:00.000Z"),
			assistant("a1", "2026-10-16T10:00:01.000Z"),
			userMessage("u2", "2026-10-16T10:00:02.000Z"),
			assistant("a2", "2026-10-16T10:00:20.000Z"),
		];
		const gaps = activityGaps(items, 10_000);
		expect(gaps).toHaveLength(1);
		expect(gaps[0]?.turnId).toBe("msg:u2");
	});

	test("tool nodes never create bands — they are not message spine", () => {
		const items = [
			userMessage("u1", "2026-10-16T10:00:00.000Z"),
			node({
				id: "tool:t1",
				kind: "tool",
				toolName: "Bash",
				startedAt: "2026-10-16T10:00:10.000Z",
				endedAt: "2026-10-16T10:00:30.000Z",
				durationMs: 20_000,
			}),
			assistant("a1", "2026-10-16T10:01:00.000Z"),
		];
		const gaps = activityGaps(items);
		expect(gaps).toHaveLength(1);
		expect(gaps[0]?.fromMs).toBe(Date.parse("2026-10-16T10:00:00.000Z"));
		expect(gaps[0]?.toMs).toBe(Date.parse("2026-10-16T10:01:00.000Z"));
	});

	test("unsorted input is ordered before measuring", () => {
		const items = [
			assistant("a1", "2026-10-16T10:01:00.000Z"),
			userMessage("u1", "2026-10-16T10:00:00.000Z"),
		];
		expect(spineItems(items).map((item) => item.id)).toEqual(["msg:u1", "msg:a1"]);
		expect(activityGaps(items, MIN_GAP_MS)).toHaveLength(1);
	});
});

describe("activity helpers", () => {
	test("latestActivityMs prefers the newest end time", () => {
		const items = [
			assistant("a1", "2026-10-16T10:00:00.000Z"),
			node({
				id: "tool:t1",
				kind: "tool",
				startedAt: "2026-10-16T10:05:00.000Z",
				endedAt: "2026-10-16T10:06:00.000Z",
			}),
		];
		expect(latestActivityMs(items)).toBe(Date.parse("2026-10-16T10:06:00.000Z"));
		expect(Number.isNaN(latestActivityMs([]))).toBe(true);
	});

	test("turnAt finds the turn containing a timestamp", () => {
		const turns = buildTurns([
			userMessage("u1", "2026-10-16T10:00:00.000Z"),
			userMessage("u2", "2026-10-16T10:10:00.000Z"),
		]);
		expect(turnAt(turns, Date.parse("2026-10-16T10:05:00.000Z"))?.id).toBe("msg:u1");
		expect(turnAt(turns, Date.parse("2026-10-16T10:15:00.000Z"))?.id).toBe("msg:u2");
	});
});

import { describe, expect, test } from "bun:test";
import {
	activeCategories,
	applyFilter,
	countByKind,
	defaultFilter,
	detectCurrentTurn,
	inCurrentTurn,
	isFilterActive,
	matchesCategory,
	type TimelineFilter,
} from "../src/filters";
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

const tool = node({ id: "tool:1", kind: "tool", toolName: "Bash" });
const failedTool = node({ id: "tool:2", kind: "tool", status: "fail" });
const message = node({ id: "msg:1", kind: "message", role: "assistant" });
const userTurn = node({ id: "msg:u1", kind: "turn", role: "user" });
const laterTurn = node({
	id: "msg:u2",
	kind: "turn",
	role: "user",
	startedAt: "2026-10-16T11:00:00.000Z",
});
const permission = node({ id: "perm:1", kind: "permission", status: "waiting" });
const lifecycle = node({ id: "life:1", kind: "lifecycle", status: "success" });

const all = [tool, failedTool, message, userTurn, laterTurn, permission, lifecycle];

function filter(partial: Partial<TimelineFilter> = {}): TimelineFilter {
	return { ...defaultFilter(), ...partial };
}

describe("category predicates", () => {
	test("each key maps to its own node class", () => {
		expect(matchesCategory(tool, "tools")).toBe(true);
		expect(matchesCategory(message, "tools")).toBe(false);
		expect(matchesCategory(permission, "waits")).toBe(true);
		expect(matchesCategory(failedTool, "failures")).toBe(true);
		expect(matchesCategory(tool, "failures")).toBe(false);
		expect(matchesCategory(message, "messages")).toBe(true);
		expect(matchesCategory(userTurn, "turn")).toBe(true);
	});

	test("a waiting node counts as a wait even when its kind is not permission", () => {
		const waitingTool = node({ id: "tool:3", kind: "tool", status: "waiting" });
		expect(matchesCategory(waitingTool, "waits")).toBe(true);
	});
});

describe("union semantics", () => {
	test("no chip lit falls back to the default set, which shows the message backbone too", () => {
		expect(activeCategories(defaultFilter())).toEqual(["tools", "waits", "messages"]);
		const visible = applyFilter(all, defaultFilter());
		expect(visible.map((item) => item.id)).toContain("msg:1");
		expect(visible.map((item) => item.id)).toContain("tool:1");
	});

	test("tools + messages light up both categories at once", () => {
		const visible = applyFilter(all, filter({ tools: true, messages: true }));
		const ids = visible.map((item) => item.id);
		expect(ids).toContain("tool:1");
		expect(ids).toContain("msg:1");
	});

	test("every chip lit still yields a non-empty track", () => {
		const visible = applyFilter(
			all,
			filter({ tools: true, failures: true, waits: true, messages: true, currentTurn: true }),
			detectCurrentTurn(all),
		);
		expect(visible.length).toBeGreaterThan(0);
	});

	test("turn and lifecycle markers survive any category selection", () => {
		const visible = applyFilter(all, filter({ messages: true }));
		const ids = visible.map((item) => item.id);
		expect(ids).toContain("msg:u1");
		expect(ids).toContain("life:1");
	});

	test("only failures keeps just the failed nodes (plus context)", () => {
		const visible = applyFilter(all, filter({ failures: true }));
		expect(visible.map((item) => item.id)).toEqual(["tool:2", "msg:u1", "msg:u2", "life:1"]);
	});
});

describe("current turn scope", () => {
	test("boundary is the newest turn marker and it moves as turns arrive", () => {
		expect(detectCurrentTurn(all).since).toBe("2026-10-16T11:00:00.000Z");
		const withNewer = [
			...all,
			node({ id: "msg:u3", kind: "turn", role: "user", startedAt: "2026-10-16T12:00:00.000Z" }),
		];
		expect(detectCurrentTurn(withNewer).since).toBe("2026-10-16T12:00:00.000Z");
	});

	test("membership keeps the boundary node itself and drops older nodes", () => {
		const scope = detectCurrentTurn(all);
		expect(inCurrentTurn(laterTurn, scope)).toBe(true);
		expect(inCurrentTurn(tool, scope)).toBe(false);
		expect(inCurrentTurn({ ...laterTurn, startedAt: "2026-10-16T10:59:59.500Z" }, scope)).toBe(
			true,
		);
	});

	test("without any turn marker the scope admits everything", () => {
		expect(inCurrentTurn(tool, {})).toBe(true);
	});

	test("applying the scope prunes older nodes and keeps markers", () => {
		const visible = applyFilter(all, filter({ currentTurn: true }), detectCurrentTurn(all));
		expect(visible.map((item) => item.id)).toEqual(["msg:u2"]);
	});
});

describe("counts and activity", () => {
	test("counts match the predicate used by the chips", () => {
		const counts = countByKind(all);
		expect(counts.tools).toBe(2);
		expect(counts.failures).toBe(1);
		expect(counts.waits).toBe(1);
		expect(counts.messages).toBe(1);
		expect(counts.turns).toBe(2);
		expect(counts.total).toBe(all.length);
	});

	test("filter activity is reported for both category and scope switches", () => {
		expect(isFilterActive(defaultFilter())).toBe(false);
		expect(isFilterActive(filter({ messages: true }))).toBe(true);
		expect(isFilterActive(filter({ currentTurn: true }))).toBe(true);
	});
});

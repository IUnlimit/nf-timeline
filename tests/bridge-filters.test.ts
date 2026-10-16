import { describe, expect, test } from "bun:test";
import {
	type ContextSnapshot,
	describeError,
	fetchMessages,
	isPermissionFailure,
	type NarraforkUiApi,
	narratorIdFromBinding,
	narratorIdFromContext,
	resolveNarratorId,
	storageGet,
} from "../src/bridge";
import { turnOffsetFor } from "../src/store";

describe("narrator binding", () => {
	test("context prefers the resolved narrator and falls back to the workspace owner", () => {
		expect(narratorIdFromContext({ narrator: { id: "nr1" } } as ContextSnapshot)).toBe("nr1");
		expect(
			narratorIdFromContext({
				workspace: { id: "ws1", ownerNarratorId: "nr2" },
			} as ContextSnapshot),
		).toBe("nr2");
		expect(narratorIdFromContext({} as ContextSnapshot)).toBeUndefined();
	});

	test("the binding table only resolves kinds that own a narrator", () => {
		expect(narratorIdFromBinding({ kind: "focus-current-narrator", narratorId: "nr1" })).toBe(
			"nr1",
		);
		expect(
			narratorIdFromBinding({
				kind: "workspace-narrator",
				workspaceId: "ws",
				ownerNarratorId: "nr2",
			}),
		).toBe("nr2");
		expect(narratorIdFromBinding({ kind: "workspace", workspaceId: "ws" })).toBeUndefined();
		expect(narratorIdFromBinding({ kind: "global" })).toBeUndefined();
		expect(narratorIdFromBinding({ kind: "host-surface", surface: "focus" })).toBeUndefined();
		expect(narratorIdFromBinding(null)).toBeUndefined();
	});

	test("binding is the recovery path when context has no resolver", async () => {
		const api = {
			async getContext() {
				const error = new Error("CONTEXT_UNAVAILABLE") as Error & { code: string };
				error.code = "CONTEXT_UNAVAILABLE";
				throw error;
			},
			panel: {
				async getState() {
					return { binding: { kind: "focus-current-narrator", narratorId: "nr9" } };
				},
			},
		} as unknown as NarraforkUiApi;
		const { ctx, narratorId } = await resolveNarratorId(api);
		expect(ctx).toBeNull();
		expect(narratorId).toBe("nr9");
	});
});

describe("error shapes", () => {
	test("permission failures are recognized through code or message", () => {
		const withCode = Object.assign(new Error("nope"), { code: "PERMISSION_DENIED" });
		expect(isPermissionFailure(withCode)).toBe(true);
		expect(isPermissionFailure(new Error("PERMISSION_DENIED"))).toBe(true);
		expect(isPermissionFailure(new Error("boom"))).toBe(false);
	});

	test("describeError renders a bounded code: message", () => {
		expect(describeError(Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" }))).toBe(
			"PERMISSION_DENIED: denied",
		);
		expect(describeError("plain")).toBe("");
	});
});

describe("query + storage unwrapping", () => {
	test("fetchMessages accepts both the envelope and plain data", async () => {
		const envelope = {
			queries: {
				async execute() {
					return { status: "succeeded", data: { narratorId: "nr1", items: [{ id: "m1" }] } };
				},
			},
		} as unknown as NarraforkUiApi;
		expect((await fetchMessages(envelope, "nr1", 50)).items).toHaveLength(1);

		const flat = {
			queries: {
				async execute() {
					return { narratorId: "nr1", items: [] };
				},
			},
		} as unknown as NarraforkUiApi;
		expect((await fetchMessages(flat, "nr1", 50)).items).toEqual([]);
	});

	test("storageGet unwraps the entry and tolerates a missing value", async () => {
		const api = {
			storage: {
				async get() {
					return { key: "timeline:v1", value: { version: 1 } };
				},
			},
		} as unknown as NarraforkUiApi;
		expect(
			await storageGet<{ version: number }>(api, { type: "narrator", id: "nr1" }, "timeline:v1"),
		).toEqual({ version: 1 });

		const empty = { storage: { async get() {} } } as unknown as NarraforkUiApi;
		expect(await storageGet(empty, { type: "narrator", id: "nr1" }, "k")).toBeUndefined();
	});
});

describe("absolute turn numbering from storage", () => {
	test("a matching persisted turn shifts the window numbering", () => {
		const offset = turnOffsetFor(
			[
				{ id: "msg:u4", index: 1, startedAt: "2026-10-16T10:00:00.000Z" },
				{ id: "msg:u5", index: 2, startedAt: "2026-10-16T10:10:00.000Z" },
			],
			{
				version: 1,
				narratorId: "nr1",
				updatedAt: "",
				tools: [],
				turns: [
					{ id: "msg:u4", index: 12, startedAt: "", messageCount: 2, gapMs: 0 },
					{ id: "msg:u3", index: 11, startedAt: "", messageCount: 2, gapMs: 0 },
				],
				channel: { delivered: 0 },
			},
		);
		expect(offset).toBe(11);
	});

	test("with nothing in common the numbering stays window relative", () => {
		const offset = turnOffsetFor(
			[{ id: "msg:u9", index: 1, startedAt: "2026-10-16T09:00:00.000Z" }],
			{
				version: 1,
				narratorId: "nr1",
				updatedAt: "",
				tools: [],
				turns: [
					{
						id: "msg:u3",
						index: 7,
						startedAt: "2026-10-16T10:00:00.000Z",
						messageCount: 2,
						gapMs: 0,
					},
				],
				channel: { delivered: 0 },
			},
		);
		expect(offset).toBe(0);
	});

	test("a window that starts after everything stored keeps counting", () => {
		const offset = turnOffsetFor(
			[{ id: "msg:new", index: 1, startedAt: "2026-10-16T11:00:00.000Z" }],
			{
				version: 1,
				narratorId: "nr1",
				updatedAt: "",
				tools: [],
				turns: [
					{
						id: "msg:u3",
						index: 7,
						startedAt: "2026-10-16T10:00:00.000Z",
						endedAt: "2026-10-16T10:30:00.000Z",
						messageCount: 2,
						gapMs: 0,
					},
				],
				channel: { delivered: 0 },
			},
		);
		expect(offset).toBe(7);
	});
});

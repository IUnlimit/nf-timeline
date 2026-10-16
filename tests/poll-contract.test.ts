/**
 * Contract guard for `events.poll`.
 *
 * The host returns a **bare `PublicEvent[]`** (`IntegrationEventDispatcher.poll`
 * → `PluginEventGateway.poll` → `PluginUiHost.pollEvents`, all unwrapped).
 * The previous `EventsPollResult { …, events, hasMore, … }` shape was invented
 * from a design doc, so `result.events.length` threw a TypeError outside the
 * try block in `createPollLoop` and the loop died silently on its first
 * response — which is what made "工具调用始终为 0" unfixable at the derivation
 * layer.
 *
 * Every case here fails against that old client and passes now.
 */

import { describe, expect, test } from "bun:test";
import { type NarraforkUiApi, pollEvents } from "../src/bridge";
import type { PublicEvent } from "../src/types";

function event(partial: Partial<PublicEvent> = {}): PublicEvent {
	return {
		schema: "narrafork.public-event",
		schemaVersion: 1,
		eventId: "evt_1",
		topic: "narrafork.narrator.tool.changed",
		eventClass: "state",
		occurredAt: "2026-10-09T10:00:00.000Z",
		data: {},
		redaction: "user_scoped",
		...partial,
	};
}

/** Only the `events.poll` method is exercised; the rest of the bridge is unused. */
function apiWithPoll(result: unknown, seen?: { args?: unknown }): NarraforkUiApi {
	return {
		events: {
			async poll(args: unknown) {
				if (seen) seen.args = args;
				return result;
			},
		},
	} as unknown as NarraforkUiApi;
}

describe("events.poll response shape", () => {
	test("the real host shape: a bare array", async () => {
		const batch = await pollEvents(
			apiWithPoll([event(), event({ eventId: "evt_2" })]),
			"sub_1",
			100,
		);
		expect(batch.events).toHaveLength(2);
		expect(batch.resyncRequired).toBe(false);
		expect(batch.mayHaveMore).toBe(false);
	});

	test("forwards subscriptionId and limit exactly as the host expects", async () => {
		const seen: { args?: unknown } = {};
		await pollEvents(apiWithPoll([], seen), "sub_42", 100);
		// The UI host validates `{ subscriptionId, limit }` strictly; anything else
		// is INVALID_PARAMS.
		expect(seen.args).toEqual({ subscriptionId: "sub_42", limit: 100 });
	});

	test("a batch filling the request limit is flagged as possibly having more", async () => {
		const full = Array.from({ length: 100 }, (_, i) => event({ eventId: `e${i}` }));
		expect((await pollEvents(apiWithPoll(full), "s", 100)).mayHaveMore).toBe(true);
		expect((await pollEvents(apiWithPoll(full.slice(0, 9)), "s", 100)).mayHaveMore).toBe(false);
	});

	test("an envelope-shaped response degrades to an empty batch instead of inventing events", async () => {
		// The old client expected exactly this envelope. It is not the host contract,
		// so tolerating it silently would hide a real contract drift; the batch is
		// empty and the loop stays alive.
		const batch = await pollEvents(apiWithPoll({ events: [event()] }), "s", 100);
		expect(batch.events).toEqual([]);
		expect(batch.mayHaveMore).toBe(false);
	});

	test("unexpected payloads become an empty batch rather than a throw", async () => {
		for (const payload of [null, undefined, {}, "oops", 42]) {
			const batch = await pollEvents(apiWithPoll(payload), "s", 100);
			expect(batch.events).toEqual([]);
			expect(batch.resyncRequired).toBe(false);
			expect(batch.mayHaveMore).toBe(false);
		}
	});
});

describe("control events", () => {
	test("resync_required in the batch sets resyncRequired", async () => {
		const control = event({
			eventId: "ctl",
			topic: "narrafork.events.resync_required",
			eventClass: "audit",
			data: { subscriptionId: "sub_1" },
			redaction: "public",
			resyncHint: { queryId: "narrafork.events.resync_required" },
		});
		const batch = await pollEvents(apiWithPoll([control]), "s", 100);
		expect(batch.resyncRequired).toBe(true);
	});

	test("any event carrying resyncHint counts, including overflow", async () => {
		// `narrafork.events.overflow` is a real public topic that our own
		// TimelineEventTopic union does not enumerate, hence the structural literal.
		const overflow = {
			...event({ eventId: "ovf", eventClass: "audit", redaction: "public" }),
			topic: "narrafork.events.overflow",
			resyncHint: { queryId: "narrafork.events.resync_required" },
		};
		const batch = await pollEvents(apiWithPoll([overflow]), "s", 100);
		expect(batch.resyncRequired).toBe(true);
	});

	test("an ordinary tool event does not trigger resync", async () => {
		const batch = await pollEvents(apiWithPoll([event({ data: { toolUseId: "tu1" } })]), "s", 100);
		expect(batch.resyncRequired).toBe(false);
	});
});

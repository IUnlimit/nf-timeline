import { describe, expect, test } from "bun:test";
import { createPollLoop, nextDelayMs } from "../src/poll";
import type { PollBatch, PublicEvent } from "../src/types";

function event(id: string): PublicEvent {
	return {
		schema: "narrafork.public-event",
		schemaVersion: 1,
		eventId: id,
		topic: "narrafork.narrator.tool.changed",
		eventClass: "state",
		occurredAt: "2026-10-09T10:00:00.000Z",
		data: {},
		redaction: "user_scoped",
	};
}

function batch(partial: Partial<PollBatch>): PollBatch {
	return { events: [], resyncRequired: false, mayHaveMore: false, ...partial };
}

/**
 * Drives the loop with a bounded fake clock: each sleep records the delay and
 * yields a macrotask so the loop can never starve the test runner.
 */
function harness(options: {
	poll: (call: number) => Promise<PollBatch>;
	maxCalls?: number;
	onEvents?: (events: PublicEvent[]) => void;
	onResyncRequired?: () => void;
	onError?: (error: unknown) => void;
	isVisible?: () => boolean;
}) {
	const delays: number[] = [];
	let calls = 0;
	let handle: ReturnType<typeof createPollLoop>;
	const maxCalls = options.maxCalls ?? 8;

	handle = createPollLoop("sub_1", {
		async poll() {
			calls += 1;
			if (calls >= maxCalls) handle.stop();
			return await options.poll(calls);
		},
		onEvents: options.onEvents ?? (() => {}),
		onResyncRequired: options.onResyncRequired ?? (() => {}),
		onError: options.onError,
		async sleep(ms) {
			delays.push(ms);
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
		isVisible: options.isVisible ?? (() => true),
	});

	return {
		delays,
		getCalls: () => calls,
		stop: () => handle.stop(),
		isStopped: () => handle.stopped,
	};
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe("nextDelayMs", () => {
	test("hasMore drains immediately", () => {
		expect(nextDelayMs({ consecutiveFailures: 0, empty: false, hasMore: true })).toBe(0);
	});

	test("empty batch relaxes to the idle interval", () => {
		expect(nextDelayMs({ consecutiveFailures: 0, empty: true, hasMore: false })).toBe(4000);
		expect(nextDelayMs({ consecutiveFailures: 0, empty: false, hasMore: false })).toBe(1200);
	});

	test("failures back off exponentially and cap", () => {
		expect(nextDelayMs({ consecutiveFailures: 1, empty: true, hasMore: false })).toBe(1200);
		expect(nextDelayMs({ consecutiveFailures: 2, empty: true, hasMore: false })).toBe(2400);
		expect(nextDelayMs({ consecutiveFailures: 3, empty: true, hasMore: false })).toBe(4800);
		expect(nextDelayMs({ consecutiveFailures: 99, empty: true, hasMore: false })).toBe(15000);
	});
});

describe("createPollLoop", () => {
	test("delivers events and honours mayHaveMore", async () => {
		const seen: string[] = [];
		const { delays } = harness({
			poll: async (call) =>
				call === 1
					? batch({ events: [event("e1")], mayHaveMore: true })
					: call === 2
						? batch({ events: [event("e2")] })
						: batch({}),
			onEvents: (events) => {
				for (const item of events) seen.push(item.eventId);
			},
		});

		await settle();
		expect(seen).toEqual(["e1", "e2"]);
		// First batch had more, so it drained with no delay.
		expect(delays[0]).toBe(0);
	});

	test("reports every batch, including empty ones", async () => {
		// Empty batches are what advance `diag.polls` and the scope fallback's
		// `emptyPolls`; skipping them left both frozen at 0 forever.
		const batches: number[] = [];
		const { getCalls } = harness({
			poll: async () => batch({}),
			onEvents: (events) => batches.push(events.length),
			maxCalls: 4,
		});

		await settle();
		expect(batches.length).toBeGreaterThanOrEqual(3);
		expect(batches.every((count) => count === 0)).toBe(true);
		expect(getCalls()).toBeGreaterThanOrEqual(3);
	});

	test("a throwing callback does not take the loop down", async () => {
		// Regression: `result.events.length` used to be read outside the try, so a
		// shape mismatch escaped `void run()` as an unhandled rejection and polling
		// stopped permanently after the first response.
		const errors: unknown[] = [];
		let attempts = 0;
		harness({
			poll: async () => {
				attempts += 1;
				return batch({ events: [event(`e${attempts}`)] });
			},
			onEvents: () => {
				throw new TypeError("Cannot read properties of undefined (reading 'length')");
			},
			onError: (error) => errors.push(error),
			maxCalls: 6,
		});

		await settle();
		expect(errors.length).toBeGreaterThanOrEqual(2);
		expect(attempts).toBeGreaterThanOrEqual(3);
	});

	test("resyncRequired triggers a rebuild", async () => {
		let resyncs = 0;
		harness({
			poll: async () => batch({ resyncRequired: true }),
			onResyncRequired: () => {
				resyncs += 1;
			},
		});
		await settle();
		expect(resyncs).toBeGreaterThanOrEqual(1);
	});

	test("hidden panels do not poll at all", async () => {
		const { getCalls } = harness({
			poll: async () => batch({}),
			isVisible: () => false,
			maxCalls: 3,
		});
		await settle();
		expect(getCalls()).toBe(0);
	});

	test("poll failures are reported and retried", async () => {
		const errors: unknown[] = [];
		harness({
			poll: async () => {
				throw new Error("boom");
			},
			onError: (error) => errors.push(error),
		});
		await settle();
		expect(errors.length).toBeGreaterThanOrEqual(3);
	});

	test("stop halts the loop", async () => {
		const h = harness({ poll: async () => batch({}), maxCalls: 1000 });
		await settle();
		const seen = h.getCalls();
		h.stop();
		await settle();
		expect(h.getCalls()).toBe(seen);
		expect(h.isStopped()).toBe(true);
	});
});

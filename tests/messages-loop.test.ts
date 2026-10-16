import { describe, expect, test } from "bun:test";
import { createMessagesLoop, messagesDelayMs } from "../src/poll";
import { MESSAGES_POLL_ACTIVE_MS, MESSAGES_POLL_IDLE_MS } from "../src/types";

function harness(options: {
	load: (call: number) => Promise<void>;
	maxCalls?: number;
	active?: boolean;
	isVisible?: () => boolean;
	onError?: (error: unknown) => void;
}) {
	const delays: number[] = [];
	let calls = 0;
	let handle: ReturnType<typeof createMessagesLoop>;
	const maxCalls = options.maxCalls ?? 6;

	handle = createMessagesLoop({
		async load() {
			calls += 1;
			if (calls >= maxCalls) handle.stop();
			await options.load(calls);
		},
		isActive: () => options.active ?? false,
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

describe("messagesDelayMs", () => {
	test("an active session is polled eagerly, an idle one lazily", () => {
		expect(messagesDelayMs({ consecutiveFailures: 0, active: true })).toBe(MESSAGES_POLL_ACTIVE_MS);
		expect(messagesDelayMs({ consecutiveFailures: 0, active: false })).toBe(MESSAGES_POLL_IDLE_MS);
	});

	test("failures back off and cap", () => {
		expect(messagesDelayMs({ consecutiveFailures: 1, active: true })).toBe(3_000);
		expect(messagesDelayMs({ consecutiveFailures: 2, active: true })).toBe(6_000);
		expect(messagesDelayMs({ consecutiveFailures: 99, active: true })).toBe(15_000);
	});
});

describe("createMessagesLoop", () => {
	test("keeps re-reading the window on the active interval", async () => {
		const h = harness({ load: async () => {}, active: true, maxCalls: 4 });
		await settle();
		expect(h.getCalls()).toBeGreaterThanOrEqual(3);
		expect(h.delays.every((delay) => delay === MESSAGES_POLL_ACTIVE_MS)).toBe(true);
	});

	test("a failing read is reported and retried, never fatal", async () => {
		const errors: unknown[] = [];
		let attempts = 0;
		harness({
			load: async () => {
				attempts += 1;
				throw new Error("messages.list failed");
			},
			onError: (error) => errors.push(error),
			maxCalls: 5,
		});
		await settle();
		expect(errors.length).toBeGreaterThanOrEqual(3);
		expect(attempts).toBeGreaterThanOrEqual(3);
	});

	test("hidden panels stop reading entirely", async () => {
		const h = harness({ load: async () => {}, isVisible: () => false, maxCalls: 5 });
		await settle();
		expect(h.getCalls()).toBe(0);
		expect(h.delays.length).toBeGreaterThanOrEqual(2);
	});

	test("stop halts the loop", async () => {
		const h = harness({ load: async () => {}, maxCalls: 1000 });
		await settle();
		const seen = h.getCalls();
		h.stop();
		await settle();
		expect(h.getCalls()).toBe(seen);
		expect(h.isStopped()).toBe(true);
	});
});

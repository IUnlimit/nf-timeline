/**
 * The panel's two refresh loops.
 *
 * `createPollLoop` drains queued public events (`events.poll` returns a bare array,
 * no push channel exists). `createMessagesLoop` re-reads `messages.list`, which is
 * the panel's backbone: the message stream is the only data source the host actually
 * delivers today.
 *
 * Both loops share three invariants:
 *   - an exception anywhere (callback included) must never end the loop;
 *   - hidden panels stop polling and resume immediately when shown again;
 *   - failures back off exponentially up to a ceiling.
 */

import {
	MESSAGES_POLL_ACTIVE_MS,
	MESSAGES_POLL_IDLE_MS,
	POLL_ACTIVE_MS,
	POLL_BACKOFF_MAX_MS,
	POLL_BATCH_LIMIT,
	POLL_IDLE_MS,
	type PollBatch,
	type PublicEvent,
} from "./types";

export { POLL_BATCH_LIMIT };

export interface PollLoopDeps {
	poll(subscriptionId: string, limit: number): Promise<PollBatch>;
	/** Called for **every** successful poll, empty batches included. */
	onEvents(events: PublicEvent[]): void;
	onResyncRequired(): void;
	onError?(error: unknown): void;
	now?(): number;
	sleep?(ms: number, signal: AbortSignal): Promise<void>;
	isVisible?(): boolean;
	activeIntervalMs?: number;
	idleIntervalMs?: number;
	maxBackoffMs?: number;
}

export interface PollLoopHandle {
	stop(): void;
	readonly stopped: boolean;
}

/**
 * Delay before the next poll. `hasMore` drains immediately, failures back off
 * exponentially, an empty batch relaxes to the idle interval.
 */
export function nextDelayMs(args: {
	consecutiveFailures: number;
	empty: boolean;
	hasMore: boolean;
	activeIntervalMs?: number;
	idleIntervalMs?: number;
	maxBackoffMs?: number;
}): number {
	const active = args.activeIntervalMs ?? POLL_ACTIVE_MS;
	const idle = args.idleIntervalMs ?? POLL_IDLE_MS;
	const maxBackoff = args.maxBackoffMs ?? POLL_BACKOFF_MAX_MS;
	if (args.hasMore) return 0;
	if (args.consecutiveFailures > 0) {
		return Math.min(maxBackoff, active * 2 ** Math.min(5, args.consecutiveFailures - 1));
	}
	return args.empty ? idle : active;
}

/** Delay before the next `messages.list` read. */
export function messagesDelayMs(args: {
	consecutiveFailures: number;
	active: boolean;
	activeIntervalMs?: number;
	idleIntervalMs?: number;
	maxBackoffMs?: number;
}): number {
	const active = args.activeIntervalMs ?? MESSAGES_POLL_ACTIVE_MS;
	const idle = args.idleIntervalMs ?? MESSAGES_POLL_IDLE_MS;
	const maxBackoff = args.maxBackoffMs ?? POLL_BACKOFF_MAX_MS;
	if (args.consecutiveFailures > 0) {
		return Math.min(maxBackoff, active * 2 ** Math.min(5, args.consecutiveFailures - 1));
	}
	return args.active ? active : idle;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function defaultVisible(): boolean {
	return typeof document === "undefined" ? true : document.visibilityState !== "hidden";
}

export function createPollLoop(subscriptionId: string, deps: PollLoopDeps): PollLoopHandle {
	const controller = new AbortController();
	const sleep = deps.sleep ?? defaultSleep;
	const isVisible = deps.isVisible ?? defaultVisible;

	let stopped = false;
	let consecutiveFailures = 0;

	const run = async (): Promise<void> => {
		while (!controller.signal.aborted) {
			try {
				if (!isVisible()) {
					await sleep(POLL_IDLE_MS, controller.signal);
					continue;
				}
				const batch = await deps.poll(subscriptionId, POLL_BATCH_LIMIT);
				consecutiveFailures = 0;
				if (batch.resyncRequired) deps.onResyncRequired();
				deps.onEvents(batch.events);
				await sleep(
					nextDelayMs({
						consecutiveFailures: 0,
						empty: batch.events.length === 0,
						hasMore: batch.mayHaveMore,
						activeIntervalMs: deps.activeIntervalMs,
						idleIntervalMs: deps.idleIntervalMs,
						maxBackoffMs: deps.maxBackoffMs,
					}),
					controller.signal,
				);
			} catch (error) {
				if (controller.signal.aborted) break;
				// Everything above — callbacks included — stays inside this catch on
				// purpose: a throw outside it once killed the loop silently.
				consecutiveFailures += 1;
				try {
					deps.onError?.(error);
				} catch {
					// Reporting must never be the thing that ends the loop.
				}
				await sleep(
					nextDelayMs({
						consecutiveFailures,
						empty: true,
						hasMore: false,
						activeIntervalMs: deps.activeIntervalMs,
						idleIntervalMs: deps.idleIntervalMs,
						maxBackoffMs: deps.maxBackoffMs,
					}),
					controller.signal,
				);
			}
		}
	};

	void run().catch((error: unknown) => {
		try {
			deps.onError?.(error);
		} catch {
			// Nothing further can be done, but keep the failure observable.
		}
	});

	return {
		stop() {
			stopped = true;
			controller.abort();
		},
		get stopped() {
			return stopped;
		},
	};
}

export interface MessagesLoopDeps {
	/** Read `messages.list`; resolves when the row set has been merged. */
	load(): Promise<void>;
	/** Whether the session looks active right now (recent message activity). */
	isActive(): boolean;
	onError?(error: unknown): void;
	sleep?(ms: number, signal: AbortSignal): Promise<void>;
	isVisible?(): boolean;
	activeIntervalMs?: number;
	idleIntervalMs?: number;
	maxBackoffMs?: number;
}

/**
 * Re-read the message window on an adaptive interval. Nothing here depends on the
 * event channel, so the panel still updates when event delivery is broken.
 */
export function createMessagesLoop(deps: MessagesLoopDeps): PollLoopHandle {
	const controller = new AbortController();
	const sleep = deps.sleep ?? defaultSleep;
	const isVisible = deps.isVisible ?? defaultVisible;

	let stopped = false;
	let consecutiveFailures = 0;

	const run = async (): Promise<void> => {
		while (!controller.signal.aborted) {
			try {
				if (isVisible()) {
					await deps.load();
					consecutiveFailures = 0;
				}
			} catch (error) {
				if (controller.signal.aborted) break;
				consecutiveFailures += 1;
				try {
					deps.onError?.(error);
				} catch {
					// Never let reporting end the loop.
				}
			}
			await sleep(
				messagesDelayMs({
					consecutiveFailures,
					active: deps.isActive(),
					activeIntervalMs: deps.activeIntervalMs,
					idleIntervalMs: deps.idleIntervalMs,
					maxBackoffMs: deps.maxBackoffMs,
				}),
				controller.signal,
			);
		}
	};

	void run().catch((error: unknown) => {
		try {
			deps.onError?.(error);
		} catch {
			// Keep the failure observable without escaping.
		}
	});

	return {
		stop() {
			stopped = true;
			controller.abort();
		},
		get stopped() {
			return stopped;
		},
	};
}

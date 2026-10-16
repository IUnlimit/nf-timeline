/**
 * End-to-end smoke test of the panel boot sequence.
 *
 * Unit tests cover the pure modules; this one boots the real entry point once against
 * a minimal DOM and a stub host bridge. It is deliberately a single flow: `src/index`
 * executes `boot()` at import time, and the module is cached, so a second import would
 * prove nothing.
 */

import { describe, expect, test } from "bun:test";
import type { PublicEvent } from "../src/types";

class FakeClassList {
	constructor(private readonly owner: FakeElement) {}
	add(name: string): void {
		if (!this.owner.className.split(" ").includes(name)) {
			this.owner.className = `${this.owner.className} ${name}`.trim();
		}
	}
	toggle(name: string, on?: boolean): void {
		if (on === false) {
			this.owner.className = this.owner.className
				.split(" ")
				.filter((part) => part !== name)
				.join(" ");
			return;
		}
		this.add(name);
	}
	contains(name: string): boolean {
		return this.owner.className.split(" ").includes(name);
	}
}

class FakeElement {
	readonly tagName: string;
	className = "";
	textContent = "";
	title = "";
	tabIndex = 0;
	clientWidth = 960;
	style: Record<string, string> = { cssText: "" };
	dataset: Record<string, string> = {};
	attributes: Record<string, string> = {};
	children: FakeElement[] = [];
	classList: FakeClassList;

	constructor(tagName: string) {
		this.tagName = tagName;
		this.classList = new FakeClassList(this);
	}

	append(...nodes: FakeElement[]): void {
		this.children.push(...nodes);
	}
	replaceChildren(...nodes: FakeElement[]): void {
		this.children = [...nodes];
	}
	addEventListener(): void {}
	setAttribute(name: string, value: string): void {
		this.attributes[name] = value;
	}
	getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
		return { left: 0, top: 0, width: this.clientWidth, height: 120 };
	}
	querySelectorAll(): FakeElement[] {
		return [];
	}
}

function walk(node: FakeElement, out: FakeElement[] = []): FakeElement[] {
	out.push(node);
	for (const child of node.children) walk(child, out);
	return out;
}

interface Harness {
	root: FakeElement;
	classes: () => string;
	queries: Array<{ queryId: string; input: { narratorId: string; limit: number } }>;
	subscribe: Array<{ topics: string[]; scope?: { narratorId?: string } }>;
	polls: () => number;
	storageSets: Array<{ scope: { type: string; id?: string }; key: string; value: unknown }>;
	pagehide: () => void;
}

function installHarness(): Harness {
	const root = new FakeElement("div");
	root.clientWidth = 960;
	const body = new FakeElement("body");
	body.children.push(root);

	const queries: Harness["queries"] = [];
	const subscribe: Harness["subscribe"] = [];
	const storageSets: Harness["storageSets"] = [];
	let polls = 0;
	let queued: PublicEvent[] = [];
	let pagehideListener: (() => void) | null = null;

	const now = Date.now();
	const queue = (event: PublicEvent): void => {
		queued = [...queued, event];
	};
	queue({
		schema: "narrafork.public-event",
		schemaVersion: 1,
		eventId: "evt_tool_1",
		topic: "narrafork.narrator.tool.changed",
		eventClass: "state",
		occurredAt: new Date(now - 1_000).toISOString(),
		resource: { type: "narrator", id: "nr1", narratorId: "nr1" },
		data: {
			narratorId: "nr1",
			toolUseId: "tu1",
			toolName: "Bash",
			status: "success",
			durationMs: 5_000,
		},
		redaction: "user_scoped",
	});

	globalThis.document = {
		readyState: "complete",
		visibilityState: "visible",
		body,
		createElement: (tag: string) => new FakeElement(tag),
		getElementById: (id: string) => (id === "dsh-timeline-root" ? root : null),
		addEventListener: () => {},
	} as unknown as Document;
	globalThis.ResizeObserver = class {
		observe(): void {}
		disconnect(): void {}
	} as unknown as typeof ResizeObserver;
	globalThis.window = {
		addEventListener: (type: string, listener: () => void) => {
			if (type === "pagehide") pagehideListener = listener;
		},
	} as unknown as Window & typeof globalThis;

	globalThis.narrafork = {
		request: async () => ({}),
		notify: () => {},
		onNotification: () => () => {},
		getContext: async () => ({
			host: { locale: "zh-CN" },
			narrator: { id: "nr1" },
			plugin: {
				id: "dev.illtamer.narrafork-dsh-timeline",
				contributionId: "dsh-timeline",
				panelInstanceId: "p1",
			},
			surface: { kind: "narrator-focus" },
		}),
		panel: {
			getState: async () => ({ binding: { kind: "focus-current-narrator", narratorId: "nr1" } }),
		},
		queries: {
			execute: async (queryId: string, input: { narratorId: string; limit: number }) => {
				queries.push({ queryId, input });
				return {
					status: "succeeded",
					data: {
						narratorId: "nr1",
						items: [
							{
								id: "m1",
								role: "user",
								text: "do the thing",
								createdAt: new Date(now - 90_000).toISOString(),
							},
							{
								id: "m2",
								role: "assistant",
								text: "SECRET-MESSAGE-TEXT",
								createdAt: new Date(now - 60_000).toISOString(),
							},
						],
					},
				};
			},
		},
		events: {
			subscribe: async (input: { topics: string[]; scope?: { narratorId?: string } }) => {
				subscribe.push(input);
				return {
					subscriptionId: "sub_1",
					mode: "live",
					delivery: { maxFrameBytes: 1, queueEvents: 100, queueBytes: 1024, maxRatePerSecond: 100 },
				};
			},
			unsubscribe: async () => ({}),
			poll: async () => {
				polls += 1;
				const batch = queued;
				queued = [];
				return batch;
			},
		},
		storage: {
			get: async () => undefined,
			set: async (input: { scope: { type: string; id?: string }; key: string; value: unknown }) => {
				storageSets.push(input);
				return {};
			},
			delete: async () => ({}),
			list: async () => ({ items: [] }),
		},
		commands: { execute: async () => ({}) },
		config: { get: async () => ({}) },
		notifications: { show: async () => ({}) },
		ui: { openExternal: async () => {} },
		i18n: { locale: "zh-CN", t: (_tables: unknown, key: string) => key, onChange: () => () => {} },
	} as unknown as typeof globalThis.narrafork;

	return {
		root,
		classes: () =>
			walk(root)
				.map((node) => node.className)
				.join(" | "),
		queries,
		subscribe,
		polls: () => polls,
		storageSets,
		pagehide: () => pagehideListener?.(),
	};
}

const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("panel boot", () => {
	test("boots against a real DOM stub and wires every channel", async () => {
		const harness = installHarness();
		await import("../src/index");
		await settle();

		// Message channel: the panel's backbone.
		expect(harness.queries.length).toBeGreaterThanOrEqual(1);
		expect(harness.queries[0]?.queryId).toBe("narrafork.narrator.messages.list");
		expect(harness.queries[0]?.input).toEqual({ narratorId: "nr1", limit: 50 });

		// Event channel: subscribed with the narrator scope, and actually polled.
		expect(harness.subscribe).toHaveLength(1);
		expect(harness.subscribe[0]?.topics).toContain("narrafork.narrator.tool.changed");
		expect(harness.subscribe[0]?.scope).toEqual({ narratorId: "nr1" });
		expect(harness.polls()).toBeGreaterThanOrEqual(1);

		const classes = harness.classes();
		expect(classes).toContain("nf-dsh-track");
		expect(classes).toContain("nf-dsh-node--turn");
		expect(classes).toContain("nf-dsh-node--message");
		expect(classes).toContain("nf-dsh-node--tool");

		// Persistence: the delivered tool and the observed turns are written on unload.
		harness.pagehide();
		await settle();
		expect(harness.storageSets.length).toBeGreaterThanOrEqual(1);
		const write = harness.storageSets[harness.storageSets.length - 1];
		expect(write?.scope).toEqual({ type: "narrator", id: "nr1" });
		expect(write?.key).toBe("timeline:v1");
		const payload = JSON.stringify(write?.value);
		expect(payload).toContain("Bash");
		expect(payload).not.toContain("SECRET-MESSAGE-TEXT");
	});
});

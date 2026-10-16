/**
 * DSH Timeline plugin entry (IIFE).
 *
 * Data sources and their verified limits (NarraFork v0.9.1 / main):
 *   - `narrafork.narrator.messages.list` — the backbone: last 50 messages, no paging.
 *   - polled public events — tool/permission/lifecycle nodes. The 0.9.1 build
 *     authorizes subscribe+poll but delivers nothing, so this channel is treated as
 *     an enhancement whose delivery state is reported instead of assumed.
 *   - host plugin storage — the accumulated observation, so a reopened panel keeps
 *     what it has seen (there is no tool-call history query to fall back on).
 */

import {
	describeError,
	fetchMessages,
	getNarraforkApi,
	isPermissionFailure,
	type NarraforkUiApi,
	pollEvents,
	resolveNarratorId,
	type StorageScope,
	storageGet,
	storageSet,
	subscribeTopics,
	unsubscribe,
} from "./bridge";
import {
	eventNarratorId,
	isResyncEvent,
	itemsFromEvent,
	mergeItems,
	messageItemFromSummary,
} from "./derive";
import {
	applyFilter,
	countByKind,
	defaultFilter,
	detectCurrentTurn,
	isFilterActive,
	type TimelineFilter,
} from "./filters";
import { type Locale, resolveLocale } from "./i18n";
import {
	fitView,
	followEndMs,
	MAX_SPAN_MS,
	MIN_SPAN_MS,
	resolveView,
	scaleFor,
	type TimelineView,
	zoomViewAt,
} from "./layout";
import { activityGaps, buildTurns, latestActivityMs } from "./messages";
import { createMessagesLoop, createPollLoop, type PollLoopHandle } from "./poll";
import {
	type LiveState,
	type PanelErrorInfo,
	type PanelPhase,
	type RenderHandlers,
	type RenderState,
	renderApp,
} from "./render";
import {
	decodeStored,
	emptyPersisted,
	MAX_TURNS,
	type PersistedTimeline,
	persistedTools,
	trimToBudget,
	turnOffsetFor,
} from "./store";
import {
	type LayoutScale,
	MESSAGES_ACTIVE_WINDOW_MS,
	MESSAGES_QUERY_LIMIT,
	type PublicEvent,
	STORAGE_KEY,
	TIMELINE_TOPICS,
	type TimelineItem,
	type TimelineWindow,
} from "./types";

/** Nodes kept in memory; the message window is 50, the rest is live/restored tools. */
const MAX_ITEMS = 600;
/** Storage writes are coalesced; the panel never waits on them. */
const STORE_DEBOUNCE_MS = 5_000;

interface ChannelFacts {
	delivered: number;
	subscribedAt?: string;
	lastEventAt?: string;
}

interface AppState {
	locale: Locale;
	phase: PanelPhase;
	error?: PanelErrorInfo;
	items: Map<string, TimelineItem>;
	narratorId?: string;
	selectedId?: string;
	filter: TimelineFilter;
	view: TimelineView | null;
	window: TimelineWindow | null;
	follow: boolean;
	viewAdjusted: boolean;
	infoOpen: boolean;
	live: LiveState;
	liveDetail?: string;
	storageAvailable: boolean;
	historyError?: string;
	channel: ChannelFacts;
	truncated: boolean;
	/** Absolute turn numbering recovered from storage (0 = window relative). */
	turnOffset: number;
	scale: LayoutScale | null;
}

function ensureRoot(): HTMLElement {
	const existing = document.getElementById("dsh-timeline-root");
	if (existing) return existing;
	const root = document.createElement("div");
	root.id = "dsh-timeline-root";
	root.style.cssText = "height:100%;min-height:120px;width:100%;overflow:hidden;";
	document.body.style.cssText = "margin:0;height:100%;overflow:hidden;";
	document.body.appendChild(root);
	return root;
}

function boot(): void {
	const root = ensureRoot();
	const api = getNarraforkApi();

	const state: AppState = {
		locale: api ? resolveLocale(api.i18n?.locale ?? "en") : "en",
		phase: "loading",
		items: new Map(),
		filter: defaultFilter(),
		view: null,
		window: null,
		follow: true,
		viewAdjusted: false,
		infoOpen: false,
		live: "subscribed",
		storageAvailable: true,
		channel: { delivered: 0 },
		truncated: false,
		turnOffset: 0,
		scale: null,
	};

	if (!api) {
		state.phase = "error";
		state.error = { kind: "missing-api" };
	}

	let eventLoop: PollLoopHandle | null = null;
	let messagesLoop: PollLoopHandle | null = null;
	let subscriptionId: string | null = null;
	let persisted: PersistedTimeline = emptyPersisted("");
	let storeTimer: ReturnType<typeof setTimeout> | null = null;
	/** `message.changed` frames coalesce onto one in-flight `messages.list` read. */
	let historyInFlight = false;

	const viewportWidth = (): number => Math.max(240, root.clientWidth || 800);
	const allItems = (): TimelineItem[] => [...state.items.values()];
	const storageScope = (narratorId: string): StorageScope => ({ type: "narrator", id: narratorId });

	const clampSpan = (span: number | undefined): number =>
		Math.min(MAX_SPAN_MS, Math.max(MIN_SPAN_MS, span ?? fitView(allItems(), Date.now()).spanMs));

	const paint = (): void => {
		const all = allItems();
		const counts = countByKind(all);
		const scope = detectCurrentTurn(all);
		const filtered = applyFilter(all, state.filter, scope);
		const sinceMs = Date.parse(scope.since ?? "");
		const gaps = activityGaps(all).filter(
			(gap) =>
				!state.filter.currentTurn || !Number.isFinite(sinceMs) || gap.fromMs >= sinceMs - 1_000,
		);
		const turns = buildTurns(all, { windowTruncated: state.truncated });
		// Recomputed every frame so the numbering self-corrects as the window slides.
		state.turnOffset = turnOffsetFor(turns, persisted);
		const lastTurn = turns[turns.length - 1];
		const turnIndex = lastTurn ? lastTurn.index + state.turnOffset : null;

		const now = Date.now();
		state.view = resolveView(all, now, state.view, state.follow, {
			userAdjusted: state.viewAdjusted,
		});
		const scale = scaleFor(state.view, viewportWidth());
		state.scale = scale;
		const win: TimelineWindow = {
			startMs: scale.offsetMs,
			endMs: scale.offsetMs + state.view.spanMs,
			spanMs: state.view.spanMs,
		};
		state.window = win;

		const latest = latestActivityMs(all);
		const renderState: RenderState = {
			phase: state.phase,
			...(state.error ? { error: state.error } : {}),
			items: filtered,
			gaps,
			totalCount: all.length,
			filterActive: isFilterActive(state.filter),
			counts,
			locale: state.locale,
			window: win,
			scale,
			...(state.selectedId ? { selectedId: state.selectedId } : {}),
			live: state.live,
			...(state.liveDetail ? { liveDetail: state.liveDetail } : {}),
			storageAvailable: state.storageAvailable,
			...(state.historyError ? { historyError: state.historyError } : {}),
			truncated: state.truncated,
			channel: state.channel,
			infoOpen: state.infoOpen,
			turnIndex,
			lastActivityMs: Number.isFinite(latest) ? latest : null,
		};

		const handlers: RenderHandlers = {
			onSelect(id) {
				state.selectedId = id;
				paint();
			},
			onZoom(factor) {
				// `factor` multiplies the visible span: > 1 shows more time (zoom out).
				state.view = {
					spanMs: clampSpan(state.view ? state.view.spanMs * factor : undefined),
					endMs: followEndMs(allItems(), Date.now()),
				};
				state.viewAdjusted = true;
				paint();
			},
			onFit() {
				state.view = fitView(allItems(), Date.now());
				state.follow = true;
				state.viewAdjusted = false;
				paint();
			},
			onWheelZoom(deltaY, clientX) {
				// Scrolling down shows more time (zoom out), scrolling up zooms in.
				const factor = deltaY > 0 ? 1.1 : 1 / 1.1;
				const base = state.view ?? fitView(allItems(), Date.now());
				state.view = zoomViewAt(base, factor, viewportWidth(), clientX);
				state.viewAdjusted = true;
				paint();
			},
			onFilterToggle(key) {
				state.filter[key] = !state.filter[key];
				paint();
			},
			onClearFilters() {
				state.filter = defaultFilter();
				paint();
			},
			onToggleInfo() {
				state.infoOpen = !state.infoOpen;
				paint();
			},
			onCloseDetail() {
				state.selectedId = undefined;
				paint();
			},
		};

		renderApp(root, renderState, handlers);
	};

	const resize = new ResizeObserver(() => paint());
	resize.observe(root);
	paint();

	if (!api) return;

	const trim = (): void => {
		if (state.items.size <= MAX_ITEMS) return;
		const sorted = [...state.items.values()].sort((a, b) => {
			const at = Date.parse(a.endedAt ?? a.startedAt) || 0;
			const bt = Date.parse(b.endedAt ?? b.startedAt) || 0;
			return bt - at;
		});
		state.items = new Map(sorted.slice(0, MAX_ITEMS).map((item) => [item.id, item]));
	};

	const mergeAll = (items: TimelineItem[]): boolean => {
		if (items.length === 0) return false;
		const changed = mergeItems(state.items, items);
		trim();
		return changed;
	};

	const flushStore = async (): Promise<void> => {
		const narratorId = state.narratorId;
		if (!narratorId || !state.storageAvailable) return;
		const all = allItems();
		const turns = buildTurns(all, { windowTruncated: state.truncated });
		const next: PersistedTimeline = {
			version: 1,
			narratorId,
			updatedAt: new Date().toISOString(),
			tools: persistedTools(all),
			turns: turns
				.filter((turn) => turn.messageCount > 0)
				.map((turn) => ({
					id: turn.id,
					index: turn.index + state.turnOffset,
					startedAt: turn.startedAt,
					...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
					messageCount: turn.messageCount,
					gapMs: turn.gapMs,
				}))
				.slice(-MAX_TURNS),
			channel: { ...state.channel },
		};
		const { state: bounded, fits } = trimToBudget(next);
		if (!fits) {
			state.storageAvailable = false;
			paint();
			return;
		}
		try {
			await storageSet(api, storageScope(narratorId), STORAGE_KEY, bounded);
			persisted = bounded;
		} catch (error) {
			// Storage is an enhancement: it must never break the timeline.
			state.storageAvailable = false;
			state.liveDetail = describeError(error) || state.liveDetail;
			paint();
		}
	};

	const scheduleStore = (): void => {
		if (!state.narratorId || !state.storageAvailable) return;
		if (storeTimer) clearTimeout(storeTimer);
		storeTimer = setTimeout(() => {
			storeTimer = null;
			void flushStore();
		}, STORE_DEBOUNCE_MS);
	};

	const loadHistory = async (): Promise<void> => {
		const narratorId = state.narratorId;
		if (!narratorId) return;
		if (historyInFlight) return;
		historyInFlight = true;
		try {
			const payload = await fetchMessages(api, narratorId, MESSAGES_QUERY_LIMIT);
			const rows = Array.isArray(payload?.items) ? payload.items : [];
			const items: TimelineItem[] = [];
			for (const row of rows) {
				if (row && typeof row.id === "string") items.push(messageItemFromSummary(row));
			}
			const recovered = Boolean(state.historyError);
			state.historyError = undefined;
			state.truncated = rows.length >= MESSAGES_QUERY_LIMIT;
			mergeAll(items);
			if (state.phase === "loading") state.phase = "ready";
			if (state.phase === "error" && state.error?.kind === "forbidden") state.error = undefined;
			paint();
			if (recovered) scheduleStore();
		} catch (error) {
			const detail = describeError(error);
			if (isPermissionFailure(error)) {
				state.phase = "error";
				state.error = { kind: "forbidden", ...(detail ? { detail } : {}) };
				paint();
				throw error;
			}
			state.historyError = detail || "messages.list failed";
			if (state.phase === "loading") state.phase = "ready";
			paint();
			throw error;
		} finally {
			historyInFlight = false;
		}
	};

	const handleEvents = (events: PublicEvent[]): void => {
		let changed = false;
		for (const event of events) {
			if (isResyncEvent(event)) {
				void loadHistory().catch(() => undefined);
				continue;
			}
			const eventNarrator = eventNarratorId(event);
			if (state.narratorId && eventNarrator && eventNarrator !== state.narratorId) continue;
			if (event.topic === "narrafork.narrator.message.changed") {
				// No message id in the payload: re-read the window instead of inventing a node.
				void loadHistory().catch(() => undefined);
				continue;
			}
			changed = mergeAll(itemsFromEvent(event)) || changed;
		}
		if (changed) paint();
	};

	const startLive = async (narratorId: string | undefined): Promise<void> => {
		try {
			const subscription = await subscribeTopics(api, TIMELINE_TOPICS, narratorId);
			subscriptionId = subscription.subscriptionId;
			state.channel.subscribedAt = new Date().toISOString();
			if (state.live !== "delivering") state.live = "subscribed";
			state.liveDetail = undefined;
			paint();

			eventLoop = createPollLoop(subscriptionId, {
				poll: (id, limit) => pollEvents(api, id, limit),
				onEvents: (events) => {
					if (events.length === 0) return;
					state.channel.delivered += events.length;
					state.channel.lastEventAt = new Date().toISOString();
					if (state.live !== "delivering") {
						state.live = "delivering";
						state.liveDetail = undefined;
					}
					handleEvents(events);
					paint();
					scheduleStore();
				},
				onResyncRequired: () => {
					void loadHistory().catch(() => undefined);
				},
				onError: (error) => {
					state.live = "unavailable";
					state.liveDetail = describeError(error) || "events.poll failed";
					paint();
				},
			});
		} catch (error) {
			state.live = isPermissionFailure(error) ? "denied" : "unavailable";
			state.liveDetail = describeError(error) || undefined;
			paint();
		}
	};

	const restore = async (narratorId: string): Promise<void> => {
		try {
			const value = await storageGet(api, storageScope(narratorId), STORAGE_KEY);
			persisted = decodeStored(value, narratorId);
			const restored: TimelineItem[] = persisted.tools.map((tool) => ({
				id: tool.id,
				kind: "tool",
				label: tool.toolName,
				toolName: tool.toolName,
				status: tool.status === "fail" ? "fail" : "success",
				startedAt: tool.startedAt,
				...(tool.endedAt ? { endedAt: tool.endedAt } : {}),
				...(typeof tool.durationMs === "number" ? { durationMs: tool.durationMs } : {}),
				...(tool.toolUseId ? { toolUseId: tool.toolUseId } : {}),
				...(tool.executionDeviceId ? { executionDeviceId: tool.executionDeviceId } : {}),
				...(tool.error ? { errorMessage: tool.error } : {}),
			}));
			mergeAll(restored);
			state.channel = { ...persisted.channel };
			state.storageAvailable = true;
		} catch {
			state.storageAvailable = false;
		}
	};

	const start = async (): Promise<void> => {
		const unsubscribeLocale = api.i18n.onChange((locale) => {
			state.locale = resolveLocale(locale);
			paint();
		});

		const { ctx, narratorId } = await resolveNarratorId(api);
		state.locale = resolveLocale(ctx?.host?.locale ?? ctx?.locale ?? api.i18n.locale ?? "en");
		state.narratorId = narratorId;

		if (!narratorId) {
			state.phase = "unbound";
			paint();
		} else {
			await restore(narratorId);
			await loadHistory().catch(() => undefined);
		}

		await startLive(narratorId);

		messagesLoop = createMessagesLoop({
			load: () => loadHistory(),
			isActive: () => Date.now() - (latestActivityMs(allItems()) || 0) < MESSAGES_ACTIVE_WINDOW_MS,
			onError: () => {
				// loadHistory already recorded the failure; the loop keeps retrying.
			},
		});

		window.addEventListener("pagehide", () => {
			messagesLoop?.stop();
			eventLoop?.stop();
			unsubscribeLocale();
			if (storeTimer) {
				clearTimeout(storeTimer);
				storeTimer = null;
			}
			void flushStore().catch(() => undefined);
			void (subscriptionId ? unsubscribe(api, subscriptionId) : Promise.resolve());
		});
	};

	void start().catch((error: unknown) => {
		const detail = describeError(error) || undefined;
		state.phase = "error";
		state.error = {
			kind: isPermissionFailure(error) ? "forbidden" : "error",
			...(detail ? { detail } : {}),
		};
		paint();
	});
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
	boot();
}

export type { NarraforkUiApi };

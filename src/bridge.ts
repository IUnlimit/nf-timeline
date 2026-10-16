/**
 * Thin adapter over the host-injected `globalThis.narrafork` UI bridge.
 * The shell owns the handshake and the postMessage channel; plugin code only calls
 * the frozen API. Errors arrive as `Error` instances carrying `.code` / `.retryable`.
 */

import { isResyncEvent } from "./derive";
import type { MessagesListResponse, PollBatch, PublicEvent } from "./types";

export interface BridgeError {
	code: string;
	message: string;
	retryable?: boolean;
}

export interface ContextSnapshot {
	locale?: string;
	host?: {
		appVersion?: string;
		locale?: string;
		colorScheme?: "light" | "dark";
	};
	plugin?: {
		id: string;
		version?: string;
		contributionId: string;
		panelInstanceId: string;
	};
	surface?: { kind?: string; active?: boolean; visible?: boolean };
	narrator?: { id: string; chapterId?: string | null; projectId?: string | null };
	workspace?: { id: string; ownerNarratorId?: string };
	[key: string]: unknown;
}

/** `PluginDockPanelParams["binding"]` as returned by `panel.getState`. */
export interface PanelBinding {
	kind?: string;
	narratorId?: string;
	ownerNarratorId?: string;
	surface?: string;
	workspaceId?: string;
}

export interface PanelState {
	panelInstanceId: string;
	pluginId: string;
	contributionId: string;
	binding: PanelBinding | null;
	title: string | null;
	active: boolean | null;
	viewState: unknown;
	viewStateVersion: number | null;
}

export interface StorageScope {
	type: "narrator" | "global" | "session" | "user" | "project" | "workspace" | "chapter";
	id?: string;
}

export interface StorageEntry<T = unknown> {
	key: string;
	value: T;
	revision?: number;
	updatedAt?: string;
}

export interface NarraforkUiApi {
	request(method: string, params?: unknown, timeout?: number): Promise<unknown>;
	notify(method: string, params?: unknown): void;
	onNotification(listener: (message: unknown) => void): () => void;
	getContext(): Promise<ContextSnapshot>;
	panel: {
		getState(): Promise<PanelState>;
		setTitle(input: { title: string }): Promise<unknown>;
		updateParams(input: { patch: unknown }): Promise<unknown>;
		focus(): Promise<unknown>;
		close(): Promise<unknown>;
		open(input: unknown): Promise<unknown>;
	};
	queries: { execute(queryId: string, input?: unknown): Promise<unknown> };
	commands: { execute(commandId: string, input?: unknown): Promise<unknown> };
	events: {
		subscribe(input: unknown): Promise<unknown>;
		unsubscribe(input: unknown): Promise<unknown>;
		poll(input?: unknown): Promise<unknown>;
	};
	storage: {
		get(input: unknown): Promise<unknown>;
		set(input: unknown): Promise<unknown>;
		delete(input: unknown): Promise<unknown>;
		list(input?: unknown): Promise<unknown>;
	};
	config: { get(): Promise<unknown> };
	notifications: { show(input: unknown): Promise<unknown> };
	ui: { openExternal(input: unknown): Promise<void> };
	i18n: {
		readonly locale: string;
		t(tables: unknown, key: string, params?: unknown): string;
		onChange(listener: (locale: string) => void): () => void;
	};
}

declare global {
	// eslint-disable-next-line no-var
	var narrafork: NarraforkUiApi | undefined;
}

export function getNarraforkApi(): NarraforkUiApi | null {
	const api = globalThis.narrafork;
	if (!api || typeof api !== "object" || typeof api.request !== "function") return null;
	return api;
}

export function isBridgeError(err: unknown): err is BridgeError {
	return Boolean(err && typeof err === "object" && typeof (err as BridgeError).code === "string");
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `PluginUiContext` has no `binding` field: the host only populates `narrator` when it
 * could resolve an owner, so `workspace.ownerNarratorId` is the only reliable
 * secondary source. Never guess a session.
 */
export function narratorIdFromContext(ctx: ContextSnapshot): string | undefined {
	return str(ctx.narrator?.id) ?? str(ctx.workspace?.ownerNarratorId);
}

/**
 * Binding kinds that own a narrator. `workspace` / `global` / `host-surface` own none,
 * so they resolve to `undefined` rather than picking a session at random.
 */
export function narratorIdFromBinding(
	binding: PanelBinding | null | undefined,
): string | undefined {
	if (!binding || typeof binding !== "object") return undefined;
	if (binding.kind === "focus-current-narrator") return str(binding.narratorId);
	if (binding.kind === "workspace-narrator") return str(binding.ownerNarratorId);
	return undefined;
}

export async function readPanelState(api: NarraforkUiApi): Promise<PanelState | null> {
	try {
		return (await api.panel.getState()) as PanelState;
	} catch {
		return null;
	}
}

/**
 * Resolve the bound narrator from the context, falling back to the panel binding.
 * `context.get` reports `CONTEXT_UNAVAILABLE` on surfaces with no context resolver,
 * so the binding lookup doubles as the recovery path.
 */
export async function resolveNarratorId(
	api: NarraforkUiApi,
): Promise<{ ctx: ContextSnapshot | null; narratorId: string | undefined }> {
	let ctx: ContextSnapshot | null = null;
	try {
		ctx = await api.getContext();
	} catch {
		ctx = null;
	}
	const fromContext = ctx ? narratorIdFromContext(ctx) : undefined;
	if (fromContext) return { ctx, narratorId: fromContext };

	const panel = await readPanelState(api);
	return { ctx, narratorId: narratorIdFromBinding(panel?.binding) };
}

/**
 * `queries.execute` resolves with the query envelope (`{status, data, page, ...}`) or
 * with plain data, depending on the host tier. Both are accepted.
 */
export async function fetchMessages(
	api: NarraforkUiApi,
	narratorId: string,
	limit: number,
): Promise<MessagesListResponse> {
	const result = await api.queries.execute("narrafork.narrator.messages.list", {
		narratorId,
		limit,
	});
	const data = (result as { data?: unknown } | null)?.data ?? result;
	return data as MessagesListResponse;
}

export interface SubscribeResult {
	subscriptionId: string;
	mode: "live";
	delivery: {
		maxFrameBytes: number;
		queueEvents: number;
		queueBytes: number;
		maxRatePerSecond: number;
	};
}

/**
 * Subscribe to public topics. `delivery.transport` is deliberately **not** sent: the
 * UI host strips it before validating against the backend schema, and the UI protocol
 * field is not part of that schema.
 */
export async function subscribeTopics(
	api: NarraforkUiApi,
	topics: readonly string[],
	narratorId?: string,
): Promise<SubscribeResult> {
	return (await api.events.subscribe({
		topics: [...topics],
		mode: "live",
		...(narratorId ? { scope: { narratorId } } : {}),
	})) as SubscribeResult;
}

/**
 * Pull queued public events.
 *
 * The host returns a **bare `PublicEvent[]`** (`IntegrationEventDispatcher.poll` →
 * `PluginEventGateway.poll` → `PluginUiHost.pollEvents`, all pass the array through).
 * There is no envelope, no `subscriptionId`, no `hasMore`; an unexpected shape
 * degrades into "no events this round" rather than a TypeError that kills the loop.
 */
export async function pollEvents(
	api: NarraforkUiApi,
	subscriptionId: string,
	limit: number,
): Promise<PollBatch> {
	const raw: unknown = await api.events.poll({ subscriptionId, limit });
	const events = Array.isArray(raw) ? (raw as PublicEvent[]) : [];
	return {
		events,
		resyncRequired: events.some(isResyncEvent),
		mayHaveMore: events.length >= limit,
	};
}

export async function unsubscribe(api: NarraforkUiApi, subscriptionId: string): Promise<void> {
	try {
		await api.events.unsubscribe({ subscriptionId });
	} catch {
		// The panel may already be detached; nothing to do.
	}
}

/** Read one narrator-scoped storage value. Returns `undefined` when absent. */
export async function storageGet<T>(
	api: NarraforkUiApi,
	scope: StorageScope,
	key: string,
): Promise<T | undefined> {
	const raw = await api.storage.get({ scope, key });
	if (!raw || typeof raw !== "object") return undefined;
	const value = (raw as { value?: unknown }).value;
	return value === undefined ? undefined : (value as T);
}

/** Write one narrator-scoped storage value. */
export async function storageSet(
	api: NarraforkUiApi,
	scope: StorageScope,
	key: string,
	value: unknown,
): Promise<void> {
	await api.storage.set({ scope, key, value });
}

export function isPermissionFailure(err: unknown): boolean {
	const value = err as { code?: unknown; message?: unknown } | null;
	const code = typeof value?.code === "string" ? value.code : "";
	const message = typeof value?.message === "string" ? value.message : "";
	return ["PERMISSION_DENIED", "forbidden", "capability_denied"].some(
		(token) => code.includes(token) || message.includes(token),
	);
}

/** `code: message` from the host, bounded, for a factual status line. */
export function describeError(err: unknown): string {
	const value = err as { code?: unknown; message?: unknown } | null;
	const code = typeof value?.code === "string" ? value.code : "";
	const message = typeof value?.message === "string" ? value.message : "";
	return [code, message].filter(Boolean).join(": ").slice(0, 200);
}

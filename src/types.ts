/**
 * Host contract + view-model types.
 *
 * Every host-facing shape here was verified against NarraFork v0.9.1 (identical in
 * v0.9.2 / main); see README «数据来源与能力边界». Nothing in this file is
 * aspirational — if the host does not expose it, it is not typed here.
 */

/** Node categories that have a real data source. */
export type TimelineKind = "turn" | "message" | "tool" | "permission" | "attention" | "lifecycle";

export type TimelineStatus = "running" | "success" | "fail" | "waiting" | "unknown";

export interface TimelineItem {
	id: string;
	kind: TimelineKind;
	label: string;
	status: TimelineStatus;
	/** ISO timestamp. For tool nodes without a payload start this is back-computed. */
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	/** `message` / `turn` nodes. */
	role?: string;
	messageId?: string;
	/** `tool` nodes. */
	toolUseId?: string;
	toolName?: string;
	executionDeviceId?: string | null;
	errorMessage?: string;
	/** Free-form short detail (attention reason, lifecycle substatus, message excerpt). */
	detail?: string;
}

/** `narrafork.narrator.messages.list` row (text is bounded to 1000 chars by the host). */
export interface MessageSummary {
	id: string;
	role: string;
	text: string | null;
	createdAt: string;
}

export interface MessagesListResponse {
	narratorId: string;
	items: MessageSummary[];
}

/**
 * A band between two consecutive messages inside one turn. This is the only way to
 * show "work happened here" while the host exposes no tool history and delivers no
 * tool events — it is an interval, not a tool duration, and the UI says so.
 */
export interface ActivityGap {
	id: string;
	turnId: string;
	fromMs: number;
	toMs: number;
}

export interface TurnBlock {
	id: string;
	index: number;
	startedAt: string;
	endedAt?: string;
	messageCount: number;
	gapCount: number;
	gapMs: number;
	/** True when the 50-row window cut this turn's beginning off. */
	truncated: boolean;
}

/**
 * Public event topics the host has a producer for and we subscribe to.
 * Topics present in `PUBLIC_EVENT_TOPICS` without a mapper are deliberately absent.
 */
export const TIMELINE_TOPICS = [
	"narrafork.narrator.tool.changed",
	"narrafork.narrator.message.changed",
	"narrafork.narrator.lifecycle",
	"narrafork.narrator.attention",
	"narrafork.narrator.permission.changed",
	"narrafork.events.resync_required",
] as const;

export type TimelineEventTopic = (typeof TIMELINE_TOPICS)[number];

export type PublicEventClass = "state" | "lifecycle" | "progress" | "attention" | "audit";

export interface PublicEventResource {
	type: string;
	id: string;
	projectId?: string;
	chapterId?: string;
	narratorId?: string;
	resourceVersion?: number;
}

export interface PublicEvent {
	schema: "narrafork.public-event";
	schemaVersion: 1;
	eventId: string;
	topic: TimelineEventTopic;
	eventClass: PublicEventClass;
	occurredAt: string;
	resource?: PublicEventResource;
	data: Record<string, unknown>;
	redaction: "public" | "user_scoped" | "admin_scoped";
	resyncHint?: { queryId: string; resourceVersion?: number };
}

/** `narrafork.narrator.tool.changed` payload (plugin-event-gateway default mapper). */
export interface ToolChangedData {
	narratorId?: string;
	toolUseId?: string;
	toolName?: string;
	status?: string;
	durationMs?: number;
	executionDeviceId?: string;
	errorMessage?: string;
}

export interface MessageChangedData {
	narratorId?: string;
	role?: string;
}

export interface LifecycleData {
	narratorId?: string;
	status?: string;
	substatus?: string[];
	changeKind?: string;
}

export interface AttentionData {
	narratorId?: string;
	reason?: string;
	state?: string;
	detail?: string;
}

export interface PermissionChangedData {
	narratorId?: string;
	requestId?: string;
	state?: string;
}

/**
 * Normalized poll batch. `events.poll` returns a **bare `PublicEvent[]`** — there is
 * no envelope, no `hasMore`. The array form is the only accepted shape; anything
 * else degrades to an empty batch (never to a thrown TypeError inside the loop).
 */
export interface PollBatch {
	events: PublicEvent[];
	/** The batch carried a resync/overflow control event. */
	resyncRequired: boolean;
	/** Returned count hit the requested limit, so more may be queued. */
	mayHaveMore: boolean;
}

export interface TimelineWindow {
	startMs: number;
	endMs: number;
	spanMs: number;
}

export interface LayoutScale {
	pxPerMs: number;
	offsetMs: number;
	viewportWidth: number;
}

/** Query ids this plugin calls. Both require `query.read.narrators`. */
export const MESSAGES_QUERY_ID = "narrafork.narrator.messages.list";
export const MESSAGES_QUERY_LIMIT = 50;
export const TIMELINE_PROTOCOL = "narrafork.ui/1";

/** Capabilities this plugin requests. Kept in sync with manifest.json by scripts/validate.ts. */
export const UI_PANEL_CAPABILITY = "ui.panel";
export const NARRATOR_READ_CAPABILITY = "query.read.narrators";
export const EVENT_CAPABILITY = "event.subscribe";
export const STORAGE_READ_CAPABILITY = "storage.read_self";
export const STORAGE_WRITE_CAPABILITY = "storage.write_self";

/** Narrator-scoped storage key holding the accumulated observation. */
export const STORAGE_KEY = "timeline:v1";

/** Event poll loop tuning (ms). */
export const POLL_ACTIVE_MS = 1_200;
export const POLL_IDLE_MS = 4_000;
export const POLL_BACKOFF_MAX_MS = 15_000;
export const POLL_BATCH_LIMIT = 100;

/**
 * Message poll tuning (ms). The message stream is the backbone of the panel, so it
 * is polled far more eagerly while the session is producing messages.
 */
export const MESSAGES_POLL_ACTIVE_MS = 3_000;
export const MESSAGES_POLL_IDLE_MS = 15_000;
/** A message newer than this marks the session as "active" for interval selection. */
export const MESSAGES_ACTIVE_WINDOW_MS = 60_000;

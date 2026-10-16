/**
 * Single-track renderer.
 *
 * One track carries every category; hue names the category and an overlay names the
 * status. Separate per-category lanes were dropped on purpose: two of them (agents,
 * background tasks) had no data source at all, and splitting the rest made the panel
 * taller without making it more readable.
 */

import type { KindCounts } from "./filters";
import { formatAgo, formatDuration, type Locale, makeT, roleLabel } from "./i18n";
import {
	geometryForItem,
	MIN_NODE_PX,
	packRows,
	ROW_HEIGHT_PX,
	rowCount,
	ticksForScale,
	xForTime,
} from "./layout";
import type { ActivityGap, LayoutScale, TimelineItem, TimelineWindow } from "./types";

export type PanelPhase = "loading" | "unbound" | "error" | "ready";

/** Live-channel state, expressed as what the panel can actually observe. */
export type LiveState = "delivering" | "subscribed" | "unavailable" | "denied";

export interface PanelErrorInfo {
	kind: "forbidden" | "error" | "missing-api";
	detail?: string;
}

export interface RenderChannelFacts {
	delivered: number;
	subscribedAt?: string;
	lastEventAt?: string;
}

export interface RenderState {
	phase: PanelPhase;
	error?: PanelErrorInfo;
	items: TimelineItem[];
	gaps: ActivityGap[];
	totalCount: number;
	filterActive: boolean;
	counts: KindCounts;
	locale: Locale;
	window: TimelineWindow;
	scale: LayoutScale;
	selectedId?: string;
	live: LiveState;
	liveDetail?: string;
	storageAvailable: boolean;
	/** Last `messages.list` failure while the panel keeps retrying. */
	historyError?: string;
	truncated: boolean;
	channel: RenderChannelFacts;
	infoOpen: boolean;
	/** Newest turn index in the window, `null` when the window has no turn marker. */
	turnIndex: number | null;
	/** Timestamp of the newest observed node, `null` when the panel saw nothing yet. */
	lastActivityMs: number | null;
}

export type FilterToggleKey = "tools" | "failures" | "waits" | "messages" | "currentTurn";

export interface RenderHandlers {
	onSelect(id: string | undefined): void;
	onZoom(factor: number): void;
	onFit(): void;
	onWheelZoom(deltaY: number, clientX: number): void;
	onFilterToggle(key: FilterToggleKey): void;
	onClearFilters(): void;
	onToggleInfo(): void;
	onCloseDetail(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function clockLabel(ms: number, locale: Locale, withSeconds: boolean): string {
	return new Date(ms).toLocaleTimeString(locale, {
		hour: "2-digit",
		minute: "2-digit",
		...(withSeconds ? { second: "2-digit" as const } : {}),
	});
}

function isoLabel(iso: string | undefined, locale: Locale): string {
	if (!iso) return "—";
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return "—";
	return new Date(ms).toLocaleString(locale, {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function truncate(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function statusKey(status: TimelineItem["status"]): string {
	return `status.${status}`;
}

const LEGEND_KINDS: TimelineItem["kind"][] = ["turn", "message", "tool", "permission"];

export function renderApp(root: HTMLElement, state: RenderState, handlers: RenderHandlers): void {
	const t = makeT(state.locale);
	root.replaceChildren();

	const shell = el("div", "nf-dsh-shell");
	shell.append(renderToolbar(state, handlers, t));
	shell.append(renderLegend(t));

	const notice = renderNotice(state, t);
	if (notice) shell.append(notice);

	const body = el("div", "nf-dsh-body");
	if (state.phase === "ready") {
		if (state.items.length === 0) {
			body.append(renderEmpty(state, handlers, t));
		} else {
			body.append(renderTrack(state, handlers, t));
			const selected = state.selectedId
				? state.items.find((item) => item.id === state.selectedId)
				: undefined;
			if (selected) body.append(renderDetail(selected, state, handlers, t));
		}
	}
	shell.append(body);

	if (state.infoOpen) shell.append(renderInfo(state, handlers, t));
	root.append(shell);
}

function renderToolbar(state: RenderState, handlers: RenderHandlers, t: ReturnType<typeof makeT>) {
	const toolbar = el("div", "nf-dsh-toolbar");
	toolbar.append(el("div", "nf-dsh-title", t("title")));

	const summary = el("div", "nf-dsh-summary");
	const turnText =
		state.turnIndex === null ? t("summary.noTurn") : t("summary.turn", { n: state.turnIndex });
	summary.append(el("span", "nf-dsh-summary-item nf-dsh-summary-item--turn", turnText));
	summary.append(
		el(
			"span",
			"nf-dsh-summary-item",
			state.lastActivityMs === null
				? t("summary.idle")
				: t("summary.lastActivity", {
						ago: formatAgo(Date.now() - state.lastActivityMs, state.locale),
					}),
		),
	);
	summary.append(
		el(
			"span",
			"nf-dsh-summary-item",
			t("summary.observed", { tools: state.counts.tools, messages: state.counts.messages }),
		),
	);
	toolbar.append(summary);

	const filters = el("div", "nf-dsh-filters");
	const defs: Array<[FilterToggleKey, Parameters<typeof t>[0], number]> = [
		["tools", "filter.tools", state.counts.tools],
		["failures", "filter.failures", state.counts.failures],
		["waits", "filter.waits", state.counts.waits],
		["messages", "filter.messages", state.counts.messages],
		["currentTurn", "filter.currentTurn", state.turnIndex === null ? 0 : 1],
	];
	for (const [key, labelKey, count] of defs) {
		const chip = el("button", "nf-dsh-chip", t(labelKey));
		chip.type = "button";
		chip.dataset.filter = key;
		chip.append(el("span", "nf-dsh-chip-count", String(count)));
		chip.addEventListener("click", () => handlers.onFilterToggle(key));
		filters.append(chip);
	}
	if (state.filterActive) {
		const clear = el("button", "nf-dsh-chip nf-dsh-chip--ghost", t("filter.clear"));
		clear.type = "button";
		clear.addEventListener("click", (event) => {
			event.stopPropagation();
			handlers.onClearFilters();
		});
		filters.append(clear);
	}
	toolbar.append(filters);

	const controls = el("div", "nf-dsh-controls");
	const zoomOut = el("button", "nf-dsh-icon-btn", "−");
	zoomOut.type = "button";
	zoomOut.title = t("control.zoomOut");
	zoomOut.setAttribute("aria-label", t("control.zoomOut"));
	zoomOut.addEventListener("click", () => handlers.onZoom(1.25));

	const zoomIn = el("button", "nf-dsh-icon-btn", "+");
	zoomIn.type = "button";
	zoomIn.title = t("control.zoomIn");
	zoomIn.setAttribute("aria-label", t("control.zoomIn"));
	zoomIn.addEventListener("click", () => handlers.onZoom(1 / 1.25));

	const fit = el("button", "nf-dsh-chip", t("control.fit"));
	fit.type = "button";
	fit.addEventListener("click", () => handlers.onFit());

	const info = el("button", "nf-dsh-chip nf-dsh-chip--info", "i");
	info.type = "button";
	info.title = t("control.info");
	info.setAttribute("aria-label", t("control.info"));
	info.setAttribute("aria-expanded", state.infoOpen ? "true" : "false");
	info.classList.toggle("nf-dsh-chip--active", state.infoOpen);
	info.addEventListener("click", () => handlers.onToggleInfo());

	controls.append(zoomOut, zoomIn, fit, info);
	toolbar.append(controls);
	return toolbar;
}

function renderLegend(t: ReturnType<typeof makeT>): HTMLElement {
	const legend = el("div", "nf-dsh-legend");
	legend.title = t("legend.hint");
	legend.append(el("span", "nf-dsh-legend-title", t("legend.title")));
	for (const kind of LEGEND_KINDS) {
		const item = el("span", "nf-dsh-legend-item");
		item.append(el("span", `nf-dsh-legend-dot nf-dsh-legend-dot--${kind}`));
		item.append(el("span", undefined, t(`kind.${kind}` as Parameters<typeof t>[0])));
		legend.append(item);
	}
	const gap = el("span", "nf-dsh-legend-item");
	gap.append(el("span", "nf-dsh-legend-dot nf-dsh-legend-dot--gap"));
	gap.append(el("span", undefined, t("kind.gap")));
	legend.append(gap);

	const fail = el("span", "nf-dsh-legend-item");
	fail.append(el("span", "nf-dsh-legend-dot nf-dsh-legend-dot--fail"));
	fail.append(el("span", undefined, t("status.fail")));
	legend.append(fail);
	return legend;
}

/** Status strip. A degraded channel is always stated, never implied. */
function renderNotice(state: RenderState, t: ReturnType<typeof makeT>): HTMLElement | null {
	const lines: string[] = [];
	let tone = "info";
	if (state.phase === "loading") {
		lines.push(t("loading"));
	} else if (state.phase === "unbound") {
		lines.push(t("unbound"));
		tone = "warn";
	} else if (state.phase === "error") {
		tone = "error";
		const kind = state.error?.kind ?? "error";
		const head =
			kind === "missing-api" ? t("missingApi") : kind === "forbidden" ? t("forbidden") : t("error");
		lines.push(state.error?.detail ? `${head} — ${state.error.detail}` : head);
	} else {
		if (state.live === "subscribed") lines.push(t("live.subscribed"));
		else if (state.live === "unavailable") {
			lines.push(
				state.liveDetail ? `${t("live.unavailable")} — ${state.liveDetail}` : t("live.unavailable"),
			);
			tone = "warn";
		} else if (state.live === "denied") {
			lines.push(t("live.denied"));
			tone = "warn";
		}
		if (!state.storageAvailable) lines.push(t("storage.unavailable"));
		if (state.historyError) {
			lines.push(t("history.failed", { detail: state.historyError }));
			tone = "warn";
		}
		if (state.truncated) lines.push(t("truncated"));
	}
	if (lines.length === 0) return null;
	const strip = el("div", `nf-dsh-notice nf-dsh-notice--${tone}`);
	for (const line of lines) strip.append(el("div", "nf-dsh-notice-line", line));
	return strip;
}

function renderEmpty(
	state: RenderState,
	handlers: RenderHandlers,
	t: ReturnType<typeof makeT>,
): HTMLElement {
	const empty = el("div", "nf-dsh-empty");
	const filtered = state.filterActive && state.totalCount > 0;
	empty.append(el("span", undefined, filtered ? t("emptyFiltered") : t("emptyTrack")));
	if (filtered) {
		const clear = el("button", "nf-dsh-chip nf-dsh-chip--ghost", t("filter.clear"));
		clear.type = "button";
		clear.addEventListener("click", () => handlers.onClearFilters());
		empty.append(clear);
	}
	return empty;
}

function renderTrack(
	state: RenderState,
	handlers: RenderHandlers,
	t: ReturnType<typeof makeT>,
): HTMLElement {
	const viewportWidth = state.scale.viewportWidth;
	const nowMs = Date.now();
	const withSeconds = state.window.spanMs <= 10 * 60_000;

	const scroller = el("div", "nf-dsh-scroller");
	scroller.tabIndex = 0;
	scroller.setAttribute("role", "application");
	scroller.setAttribute("aria-label", t("title"));

	const content = el("div", "nf-dsh-content");
	content.style.width = `${viewportWidth}px`;

	// Ruler
	const ruler = el("div", "nf-dsh-ruler");
	for (const tick of ticksForScale(state.scale, state.window)) {
		const x = xForTime(state.scale, tick);
		const mark = el("div", "nf-dsh-tick");
		mark.style.left = `${x}px`;
		mark.append(el("span", "nf-dsh-tick-label", clockLabel(tick, state.locale, withSeconds)));
		ruler.append(mark);
	}
	content.append(ruler);

	// Single track
	const minNodeWidth = Math.max(MIN_NODE_PX, viewportWidth * 0.003);
	const geoms = state.items.map((item) => geometryForItem(item, state.scale, nowMs, minNodeWidth));
	const packed = packRows(geoms);
	const rows = rowCount(packed);
	const track = el("div", "nf-dsh-track");
	track.style.height = `${rows * ROW_HEIGHT_PX}px`;

	// Activity bands sit behind the nodes: they are context, not nodes.
	for (const gap of state.gaps) {
		const x = xForTime(state.scale, gap.fromMs);
		const width = Math.max(1, (gap.toMs - gap.fromMs) * state.scale.pxPerMs);
		if (x + width < 0 || x > viewportWidth) continue;
		const band = el("div", "nf-dsh-gap");
		band.style.left = `${x}px`;
		band.style.width = `${width}px`;
		band.title = `${t("kind.gap")} · ${formatDuration(gap.toMs - gap.fromMs)}`;
		band.append(el("span", "nf-dsh-gap-label", formatDuration(gap.toMs - gap.fromMs)));
		track.append(band);
	}

	const byId = new Map(state.items.map((item) => [item.id, item]));
	for (const geom of packed) {
		if (geom.x + geom.width < 0 || geom.x > viewportWidth) continue;
		const item = byId.get(geom.id);
		if (!item) continue;
		const node = el("div", `nf-dsh-node nf-dsh-node--${item.kind} nf-dsh-node--${item.status}`);
		node.dataset.id = item.id;
		node.dataset.kind = item.kind;
		node.style.left = `${geom.x}px`;
		node.style.width = `${geom.width}px`;
		node.style.top = `${geom.row * ROW_HEIGHT_PX}px`;
		if (item.role) node.dataset.role = item.role;
		if (item.status === "waiting") node.classList.add("nf-dsh-node--pulse");
		if (state.selectedId === item.id) node.classList.add("nf-dsh-node--selected");
		node.tabIndex = 0;
		node.setAttribute("role", "button");
		node.title = `${nodeLabel(item, t)} · ${t(statusKey(item.status) as Parameters<typeof t>[0])}`;
		node.setAttribute("aria-label", node.title);

		if (geom.width >= 54) node.append(el("span", "nf-dsh-node-label", nodeLabel(item, t)));
		if (geom.width >= 30 && typeof item.durationMs === "number" && item.durationMs >= 1_000) {
			node.append(el("span", "nf-dsh-node-duration", formatDuration(item.durationMs)));
		}
		node.addEventListener("click", (event) => {
			event.stopPropagation();
			handlers.onSelect(item.id);
		});
		track.append(node);
	}

	// "Now" marker
	const nowX = xForTime(state.scale, nowMs);
	if (nowX >= 0 && nowX <= viewportWidth) {
		const marker = el("div", "nf-dsh-now");
		marker.style.left = `${nowX}px`;
		track.append(marker);
	}

	content.append(track);
	scroller.append(content);

	scroller.addEventListener(
		"wheel",
		(event: WheelEvent) => {
			if (!event.ctrlKey) return;
			event.preventDefault();
			const rect = scroller.getBoundingClientRect();
			// Scrolling down shows more time, scrolling up zooms in.
			handlers.onWheelZoom(event.deltaY, event.clientX - rect.left);
		},
		{ passive: false },
	);
	scroller.addEventListener("click", () => handlers.onSelect(undefined));
	return scroller;
}

function nodeLabel(item: TimelineItem, t: ReturnType<typeof makeT>): string {
	if (item.kind === "message" || item.kind === "turn") return roleLabel(item.role, t);
	if (item.kind === "tool") return item.toolName ?? item.label;
	return item.label;
}

function renderDetail(
	item: TimelineItem,
	state: RenderState,
	handlers: RenderHandlers,
	t: ReturnType<typeof makeT>,
): HTMLElement {
	const card = el("div", "nf-dsh-detail");
	const head = el("div", "nf-dsh-detail-head");
	head.append(el("span", "nf-dsh-detail-title", nodeLabel(item, t)));
	const close = el("button", "nf-dsh-chip nf-dsh-chip--ghost", t("detail.close"));
	close.type = "button";
	close.addEventListener("click", (event) => {
		event.stopPropagation();
		handlers.onCloseDetail();
	});
	head.append(close);
	card.append(head);

	const rows: Array<[string, string]> = [
		[t("detail.kind"), t(`kind.${item.kind}` as Parameters<typeof t>[0])],
		[t("detail.status"), t(statusKey(item.status) as Parameters<typeof t>[0])],
		[t("detail.started"), isoLabel(item.startedAt, state.locale)],
	];
	if (item.endedAt) rows.push([t("detail.ended"), isoLabel(item.endedAt, state.locale)]);
	if (typeof item.durationMs === "number") {
		rows.push([t("detail.duration"), formatDuration(item.durationMs)]);
	}
	if (item.toolName) rows.push([t("detail.tool"), item.toolName]);
	if (item.executionDeviceId) rows.push([t("detail.device"), item.executionDeviceId]);
	if (item.errorMessage) rows.push([t("detail.error"), truncate(item.errorMessage, 200)]);

	const list = el("dl", "nf-dsh-detail-rows");
	for (const [key, value] of rows) {
		list.append(el("dt", undefined, key));
		list.append(el("dd", undefined, value));
	}
	card.append(list);

	if (item.detail && (item.kind === "message" || item.kind === "turn")) {
		card.append(el("div", "nf-dsh-detail-section", t("detail.text")));
		card.append(el("div", "nf-dsh-detail-text", truncate(item.detail, 300)));
	}
	if (item.kind === "permission" || item.kind === "attention") {
		card.append(el("div", "nf-dsh-detail-note", t("detail.waitNote")));
	}
	return card;
}

function renderInfo(
	state: RenderState,
	handlers: RenderHandlers,
	t: ReturnType<typeof makeT>,
): HTMLElement {
	const box = el("div", "nf-dsh-info");
	const head = el("div", "nf-dsh-detail-head");
	head.append(el("span", "nf-dsh-detail-title", t("info.title")));
	const close = el("button", "nf-dsh-chip nf-dsh-chip--ghost", t("info.close"));
	close.type = "button";
	close.addEventListener("click", (event) => {
		event.stopPropagation();
		handlers.onToggleInfo();
	});
	head.append(close);
	box.append(head);

	const list = el("dl", "nf-dsh-detail-rows");
	const facts: Array<[string, string]> = [
		[t("info.live"), t(`live.${state.live}` as Parameters<typeof t>[0])],
		[t("info.delivered"), String(state.channel.delivered)],
		[t("info.subscribedAt"), isoLabel(state.channel.subscribedAt, state.locale)],
		[t("info.lastEvent"), isoLabel(state.channel.lastEventAt, state.locale)],
		[
			t("summary.observed"),
			t("summary.observed", { tools: state.counts.tools, messages: state.counts.messages }),
		],
	];
	if (state.liveDetail) facts.push([t("live.unavailable"), state.liveDetail]);
	for (const [key, value] of facts) {
		list.append(el("dt", undefined, key));
		list.append(el("dd", undefined, value));
	}
	box.append(list);
	box.append(el("div", "nf-dsh-detail-note", t("info.toolHistoryNote")));
	return box;
}

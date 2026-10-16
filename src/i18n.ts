export type Locale = "en" | "zh-CN";

export type MessageKey =
	| "title"
	| "loading"
	| "unbound"
	| "error"
	| "forbidden"
	| "missingApi"
	| "emptyTrack"
	| "emptyFiltered"
	| "truncated"
	| "live.delivering"
	| "live.subscribed"
	| "live.unavailable"
	| "live.denied"
	| "storage.unavailable"
	| "history.failed"
	| "summary.turn"
	| "summary.noTurn"
	| "summary.lastActivity"
	| "summary.observed"
	| "summary.idle"
	| "status.running"
	| "status.success"
	| "status.fail"
	| "status.waiting"
	| "status.unknown"
	| "kind.turn"
	| "kind.message"
	| "kind.tool"
	| "kind.permission"
	| "kind.attention"
	| "kind.lifecycle"
	| "kind.gap"
	| "role.user"
	| "role.assistant"
	| "role.sys"
	| "role.system"
	| "role.disp"
	| "role.other"
	| "filter.tools"
	| "filter.failures"
	| "filter.waits"
	| "filter.messages"
	| "filter.currentTurn"
	| "filter.clear"
	| "counts.title"
	| "legend.title"
	| "legend.hint"
	| "control.zoomIn"
	| "control.zoomOut"
	| "control.fit"
	| "control.info"
	| "control.close"
	| "detail.title"
	| "detail.kind"
	| "detail.status"
	| "detail.started"
	| "detail.ended"
	| "detail.duration"
	| "detail.tool"
	| "detail.device"
	| "detail.error"
	| "detail.text"
	| "detail.turn"
	| "detail.gapNote"
	| "detail.waitNote"
	| "detail.close"
	| "info.title"
	| "info.live"
	| "info.delivered"
	| "info.subscribedAt"
	| "info.lastEvent"
	| "info.toolHistoryNote"
	| "info.close";

const EN: Record<MessageKey, string> = {
	title: "Timeline",
	loading: "Loading timeline…",
	unbound: "No session bound — open this view from a narrator panel",
	error: "Timeline unavailable",
	forbidden: "Timeline permission not granted",
	missingApi: "Host bridge not ready",
	emptyTrack: "Nothing to show yet — this panel fills as the session runs",
	emptyFiltered: "No node matches the current selection",
	truncated: "Only the newest 50 messages are readable; earlier history is not exposed by the host",
	"live.delivering": "Live events: delivering",
	"live.subscribed": "Live events: subscribed, host has delivered nothing",
	"live.unavailable": "Live events: subscription failed",
	"live.denied": "Live events: not authorized",
	"storage.unavailable": "Observation store unavailable",
	"history.failed": "Message history read failed — {detail}",
	"summary.turn": "Turn {n}",
	"summary.noTurn": "No turn yet",
	"summary.lastActivity": "last activity {ago} ago",
	"summary.idle": "idle",
	"summary.observed": "observed: tools {tools} · messages {messages}",
	"status.running": "Running",
	"status.success": "Success",
	"status.fail": "Failed",
	"status.waiting": "Waiting",
	"status.unknown": "Unknown",
	"kind.turn": "Turn",
	"kind.message": "Message",
	"kind.tool": "Tool",
	"kind.permission": "Permission",
	"kind.attention": "Attention",
	"kind.lifecycle": "Status change",
	"kind.gap": "Activity gap",
	"role.user": "User",
	"role.assistant": "Assistant",
	"role.sys": "System prompt",
	"role.system": "System",
	"role.disp": "Display",
	"role.other": "Message",
	"filter.tools": "Tools",
	"filter.failures": "Failures",
	"filter.waits": "Waits",
	"filter.messages": "Messages",
	"filter.currentTurn": "Current turn",
	"filter.clear": "Clear selection",
	"counts.title": "Nodes by category (before filtering)",
	"legend.title": "Colors",
	"legend.hint": "Hue is the category, overlay is the status",
	"control.zoomIn": "Zoom in",
	"control.zoomOut": "Zoom out",
	"control.fit": "Fit",
	"control.info": "Data sources",
	"control.close": "Close",
	"detail.title": "Details",
	"detail.kind": "Category",
	"detail.status": "Status",
	"detail.started": "Started",
	"detail.ended": "Ended",
	"detail.duration": "Duration",
	"detail.tool": "Tool",
	"detail.device": "Device",
	"detail.error": "Error",
	"detail.text": "Message",
	"detail.turn": "Turn",
	"detail.gapNote": "Time between two messages — model thinking plus tool execution",
	"detail.waitNote": "The host publishes no resolution for permission requests",
	"detail.close": "Close",
	"info.title": "Data sources",
	"info.live": "Live event channel",
	"info.delivered": "Events delivered to this panel",
	"info.subscribedAt": "Subscribed at",
	"info.lastEvent": "Last event",
	"info.toolHistoryNote":
		"The host exposes no tool-call history query, and 0.9.1 delivers no public events to plugin panels, so tool nodes can only come from live events — see README for the evidence.",
	"info.close": "Close",
};

const ZH: Record<MessageKey, string> = {
	title: "时间线",
	loading: "正在加载时间线…",
	unbound: "未绑定会话 — 请从会话面板打开此视图",
	error: "时间线不可用",
	forbidden: "尚未授予时间线权限",
	missingApi: "宿主桥接未就绪",
	emptyTrack: "暂无内容 — 会话运行过程中这里会逐步填充",
	emptyFiltered: "当前筛选没有匹配的节点",
	truncated: "只能读到最近 50 条消息；更早的记录宿主未开放",
	"live.delivering": "实时事件：正在投递",
	"live.subscribed": "实时事件：已订阅，宿主未投递任何事件",
	"live.unavailable": "实时事件：订阅失败",
	"live.denied": "实时事件：未授权",
	"storage.unavailable": "观测存储不可用",
	"history.failed": "消息历史读取失败 — {detail}",
	"summary.turn": "第 {n} 轮",
	"summary.noTurn": "暂无轮次",
	"summary.lastActivity": "最近活动 {ago} 前",
	"summary.idle": "空闲",
	"summary.observed": "观测：工具 {tools} · 消息 {messages}",
	"status.running": "运行中",
	"status.success": "成功",
	"status.fail": "失败",
	"status.waiting": "等待中",
	"status.unknown": "未知",
	"kind.turn": "轮次",
	"kind.message": "消息",
	"kind.tool": "工具",
	"kind.permission": "权限",
	"kind.attention": "提醒",
	"kind.lifecycle": "状态变化",
	"kind.gap": "活动段",
	"role.user": "用户",
	"role.assistant": "助手",
	"role.sys": "系统提示",
	"role.system": "系统",
	"role.disp": "展示",
	"role.other": "消息",
	"filter.tools": "工具",
	"filter.failures": "失败",
	"filter.waits": "等待",
	"filter.messages": "消息",
	"filter.currentTurn": "当前轮次",
	"filter.clear": "清除筛选",
	"counts.title": "各类别节点数（筛选前）",
	"legend.title": "配色",
	"legend.hint": "色相表示类别，叠加层表示状态",
	"control.zoomIn": "放大",
	"control.zoomOut": "缩小",
	"control.fit": "适应",
	"control.info": "数据源",
	"control.close": "关闭",
	"detail.title": "详情",
	"detail.kind": "类别",
	"detail.status": "状态",
	"detail.started": "开始",
	"detail.ended": "结束",
	"detail.duration": "耗时",
	"detail.tool": "工具",
	"detail.device": "设备",
	"detail.error": "错误",
	"detail.text": "消息内容",
	"detail.turn": "轮次",
	"detail.gapNote": "两条消息之间的时间 — 含模型思考与工具执行",
	"detail.waitNote": "宿主不为权限请求发布解除事件",
	"detail.close": "关闭",
	"info.title": "数据源事实",
	"info.live": "实时事件通道",
	"info.delivered": "投递到本面板的事件数",
	"info.subscribedAt": "订阅时间",
	"info.lastEvent": "最近事件",
	"info.toolHistoryNote":
		"宿主没有工具调用历史查询，且 0.9.1 不向插件面板投递公共事件，因此工具节点只可能来自实时事件 —— 证据见 README。",
	"info.close": "关闭",
};

const DICT: Record<Locale, Record<MessageKey, string>> = { en: EN, "zh-CN": ZH };

export function resolveLocale(raw?: string | null): Locale {
	if (!raw) return "en";
	return raw.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export type TParams = Record<string, string | number>;

export function translate(locale: Locale, key: MessageKey, params?: TParams): string {
	const template = DICT[locale][key] ?? EN[key] ?? key;
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match,
	);
}

export function makeT(locale: Locale): (key: MessageKey, params?: TParams) => string {
	return (key, params) => translate(locale, key, params);
}

export type TFn = ReturnType<typeof makeT>;

export function formatDuration(ms: number | undefined): string {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

/** Compact "how long ago" for the status line. */
export function formatAgo(ms: number, locale: Locale): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 5_000) return locale === "zh-CN" ? "数秒" : "seconds";
	if (ms < 60_000) {
		const seconds = Math.round(ms / 1000);
		return locale === "zh-CN" ? `${seconds} 秒` : `${seconds}s`;
	}
	if (ms < 3_600_000) {
		const minutes = Math.round(ms / 60_000);
		return locale === "zh-CN" ? `${minutes} 分钟` : `${minutes}m`;
	}
	const hours = Math.round(ms / 3_600_000);
	return locale === "zh-CN" ? `${hours} 小时` : `${hours}h`;
}

/** Localized label for a message role. */
export function roleLabel(role: string | undefined, t: TFn): string {
	switch (role) {
		case "user":
			return t("role.user");
		case "assistant":
			return t("role.assistant");
		case "sys":
			return t("role.sys");
		case "system":
			return t("role.system");
		case "disp":
			return t("role.disp");
		default:
			return role ? role : t("role.other");
	}
}

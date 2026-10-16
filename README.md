# NarraFork Session Timeline

[![CI](https://github.com/IUnlimit/nf-timeline/actions/workflows/ci.yml/badge.svg)](https://github.com/IUnlimit/nf-timeline/actions/workflows/ci.yml)
[![version](https://img.shields.io/github/package-json/v/IUnlimit/nf-timeline)](https://github.com/IUnlimit/nf-timeline/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

绑定单个叙述者会话的**单行道时间线**插件：一条轨道承载轮次、消息、活动段、工具调用与权限等待，用色相区分类别、用叠加层表示状态，可缩放、可筛选、可点开详情。

目标只有一个：**看清这次会话正在做什么**。宿主的真实能力边界写在「[数据来源与能力边界](#数据来源与能力边界)」一节，而不是让界面假装一切正常。

```
[时间线]  第 24 轮 · 最近活动 12 秒 前 · 观测：工具 0 · 消息 50        [− + 适应] [i]
────────────────────────────────────────────────────────────────────────────────
 09:31        09:45            10:02         10:18          10:33
  ▏  ▏▏▏▏━━━━━━▏▏  ▏▏▏━━━━━▏  ▏▏  ▏▏▏━━━━━━━━━━━━━▏  ▏▏
  ▲轮次  ▒活动段▒  ●消息  ■工具  ✚等待        │现在
```

## 特性

- **单行道 + 颜色区分**：轮次（蓝）、消息（青绿）、工具（靛蓝，失败转红）、等待（紫/琥珀脉冲）、状态变化（灰）同轨排布，只在时间重叠时分行；不再有多条泳道和永远为空的类别。
- **活动段**：两条消息之间的时间渲染为灰底虚边的时间段，标注时长——在宿主不提供工具历史的前提下，这是唯一能体现「这一段在干活」的载体（详情里明确说明它含模型思考与工具执行）。
- **双通道刷新**：消息轮询是骨架（活跃 3 秒 / 空闲 15 秒，后台自动暂停），事件订阅是增强（活跃 1.2 秒 / 空闲 4 秒）。任一条通道失效都不影响另一条。
- **观测持久化**：面板观察到的工具节点与轮次摘要写入宿主插件存储，关闭面板或刷新页面后重新打开仍在。只写标签、状态、时间、耗时、设备与错误摘要，**消息正文不落盘**。
- **不撒谎的状态**：状态条与 `i` 面板会直接写出事件通道的真实投递计数。宿主没投递事件时，面板不会伪装成「正在记录」。
- **零运行时依赖**：产物是单个 IIFE + 一份 CSS，无 CDN、无网络请求、无 `eval`，只通过宿主注入的 `window.narrafork` 访问能力。

## 安装

### 方式一：下载发布包

1. 在 [Releases](https://github.com/IUnlimit/nf-timeline/releases) 下载 `narrafork-dsh-timeline-<版本>.nfplugin`（CI 每次打 tag 自动构建并附到 Release）。
2. 在 NarraFork 中 `Install plugin` → 上传该文件 → 启用插件（frontend tier 需要管理员）。
3. 授予下列 5 项能力。
4. 打开任意 Narrator 会话，在面板菜单中打开 **Timeline** 视图。

> 覆盖安装会建立新的 installation，请重新确认授权。

### 方式二：从源码构建

```bash
bun install
bun run verify          # 检查 + 类型 + 测试 + 构建 + 校验 + 打包
# 产物：release/narrafork-dsh-timeline-<版本>.nfplugin
```

## 权限

| 能力 | 用途 |
| --- | --- |
| `ui.panel` | 宿主对任何 UI bridge 方法的前置校验 |
| `query.read.narrators` | 调用 `narrafork.narrator.messages.list` |
| `event.subscribe` | 订阅工具 / 消息 / 状态 / 等待事件 |
| `storage.read_self` / `storage.write_self` | 把观察到的节点写入本会话的插件存储 |

不申请网络、文件系统、进程或 secret 权限。UI 运行在 `sandbox="allow-scripts"` 的 iframe 中。`bun run validate` 会双向断言「代码实际调用的能力」与「manifest 声明的能力」一致。

## 数据来源与能力边界

以下内容对照 NarraFork **v0.9.1** 源码与本机运行实例逐条核对（`v0.9.2` / `main` 中相关文件与 0.9.1 相同）：

| 项 | 真实情况 |
| --- | --- |
| 消息 | `narrafork.narrator.messages.list`：**上限 50 行、无分页**，只给 `id / role / text(≤1000) / createdAt` |
| 工具**历史** | **不存在任何查询**能读历史工具调用 |
| 工具**实时** | `narrafork.narrator.tool.changed`：`{narratorId, toolUseId, toolName, status:"success"\|"fail", durationMs?, executionDeviceId?, errorMessage?}`；**只在终态发一次，无 startedAt/completedAt** |
| 子 Agent / 后台任务 | **没有任何公共 topic** |
| 权限等待 | `permission.changed` 只发 `state:"pending"`，永不发解除 |
| 轮次（turn） | 协议里不存在，面板用「user 消息开新轮」推导 |
| 事件传输 | 只有 poll：`events.poll` 返回**裸 `PublicEvent[]`**（无信封、无 `hasMore`），没有 push/SSE/WebSocket |
| 自动挂载 | manifest 没有 `autoOpen` 之类字段（schema `.strict()`），面板只能由用户从面板菜单打开 |
| 面板高度 | dockview 上 `panel.setHeight` 恒为 `NOT_SUPPORTED` |
| 错误形状 | 桥接错误是 `Error` 实例，带 `.code` / `.retryable` |

### 为什么「工具」计数可能是 0

因为在实测的 NarraFork 0.9.1 上，**公共事件从未被投递给插件面板**——不是插件逻辑问题。取证（2026-10-16，单个面板会话 `17:47:02 → 18:06:58`）：

| 证据 | 内容 |
| --- | --- |
| 订阅成功 | `integration_audit_events`：`event.subscribe … succeeded`，6 个 topic 逐个 `allowed` |
| 轮询存活 | 同表：`events.poll … allowed` 每 12.1 秒一次，全程无失败 |
| 订阅未被吊销 | 窗口末尾仍有 `event.revoke … session-disabled`（若被下发鉴权拒绝，订阅会被移除，就不会有这次收尾吊销） |
| 事件源在产出 | 同窗口内该叙述者 77 次工具调用到达终态、约 40 条 assistant 消息 |
| 插件侧零反应 | 整个窗口没有任何一次 `messages.list` 重载（`message.changed` 本应触发） |

结论：订阅成功、轮询成功、鉴权成功、事件源在产出，事件却一条也没到。因此本插件把工具/等待节点设计成**自动点亮的增强层**：宿主修好投递后它们会直接出现，不需要改动结构；在此之前「活动段 + 轮次 + 消息」承担全部可视化职责。

## 面板怎么读

| 元素 | 颜色 | 含义 |
| --- | --- | --- |
| 轮次标记 | 蓝 | 一条 `user` 消息 = 一轮的起点 |
| 消息 | 青绿 | 轮次内的消息刻度 |
| 活动段 | 灰（虚线上下边） | 两条消息之间的时间 = 模型思考 + 工具执行 |
| 工具 | 靛蓝 | 工具调用（来自实时事件）；失败转红 |
| 权限 / 提醒 | 紫 / 琥珀 | 等待态，脉冲动画；宿主不发布解除，因此不会假装有结束时间 |
| 状态变化 | 灰 | 会话 `lifecycle` 转变的零宽刻度 |

- 顶部状态行：`第 N 轮 · 最近活动 … 前 · 观测：工具 N · 消息 N`。
- 缩放：`+` / `−` / `Ctrl`+滚轮 / `适应`；未手动缩放时跨度随内容自适应，`follow` 让右缘贴住最新活动。
- 筛选 chip 是**并集**（勾上的类别都显示）；未勾选时默认显示「工具 + 等待 + 消息」。`当前轮次` 是叠加的范围开关，轮次与状态变化刻度属于结构上下文，任何筛选下都保留。
- 点任意节点打开详情：消息给出角色与正文摘要（≤300 字符），工具给出名称、耗时、执行设备与失败摘要。

## 刷新与持久化

| 通道 | 间隔 | 说明 |
| --- | --- | --- |
| 消息（骨架） | 活跃 3s / 空闲 15s | 判据：最近一条消息在 60 秒内；页面隐藏时暂停；失败指数退避（上限 15 秒） |
| 事件（增强） | 活跃 1.2s / 空闲 4s | 每批 ≤100 条，达到上限立即续拉 |

观测数据写入 `scope = {type:"narrator", id:<narratorId>}`、键 `timeline:v1`：单值预算 48 KiB（宿主硬上限 64 KiB），溢出时先丢最旧记录再减半重试，仍不满足则放弃本轮写入并提示——存储永远不会阻塞渲染。

## 项目结构

```
manifest.json          插件清单（schemaVersion 1）
src/
  index.ts             入口：状态机、两条刷新循环、storage 接线
  bridge.ts            宿主 UI bridge 适配层（错误形状、storage 读写）
  derive.ts            公共事件 → 时间线节点
  messages.ts          消息流 → 轮次与活动段
  store.ts             观测持久化（裁剪、预算、跨窗口轮次编号）
  render.ts            单行道渲染
  layout.ts            时间轴几何、缩放、分行
  filters.ts           筛选（并集 + 当前轮次范围）
  poll.ts              事件轮询与消息轮询两条循环
  i18n.ts              中英文案与格式化
  normalize.ts         纯工具函数（时间、状态、合并）
ui/timeline.css        样式（--nf-* token + 类别色相）
scripts/
  build.ts             IIFE 构建 + 打包目录组装
  zip.ts               零依赖 ZIP 写入器（确定性输出）
  pack.ts              产出 release/*.nfplugin
  validate.ts          包结构与能力一致性校验
tests/                 契约、推导、轮次、存储、布局、循环、ZIP、引导冒烟
```

## 开发

```bash
bun install
bun test --isolate     # 测试（含假 DOM 端到端引导测试）
bun run typecheck      # tsc --noEmit
bun run check          # Biome 检查 + 格式化检查
bun run build          # 构建到 dist/
bun run validate       # 校验 dist/ 的包结构
bun run pack           # 产出 release/narrafork-dsh-timeline-<版本>.nfplugin
bun run verify         # 以上全部串起来
```

### 关于宿主契约

本插件的每条宿主调用都必须在 NarraFork 源码中核实过再写进代码，`scripts/validate.ts` 会拒绝包内出现未经核实的宿主 id（`narrafork.*`）。核对入口：

- `server/services/plugin-public-api.ts`：可用的 query 与其字段
- `server/services/plugin-event-gateway.ts`：公共事件的负载字段
- `server/services/plugin-ui-host.ts`：UI bridge 方法、`events.poll` 返回形状、storage 的范围限制
- `frontend/components/plugins/*`：面板绑定解析、可用方法白名单

改宿主契约相关代码时，请同步更新 `tests/` 中的契约用例与 README 的边界表。

## 发布

版本号需要三处一致（`scripts/validate.ts` 会强制校验）：

1. `package.json` 的 `version`
2. `manifest.json` 的 `version`
3. Git tag `v<version>`

```bash
git tag v0.2.0
git push origin v0.2.0   # Release workflow 构建并附上 .nfplugin
```

推送到任意分支或发起 PR 时，CI 会跑检查、类型、测试、构建、校验与打包，并把 `.nfplugin` 作为构建产物上传。

## 已知限制

- **工具历史无法回填**：宿主没有对应查询，面板打开前的工具调用拿不到。
- **工具开始时间靠反推**：宿主只给 `durationMs`，开始时间 = 终态时刻 − 耗时；没有耗时则用终态时刻本身。
- **没有子 Agent / 后台任务 / 轮次事件**：协议里不存在，因此也没有对应泳道。
- **消息窗口 50 行**：更早的历史读不到，首轮会标记为截断并在状态条说明。
- **权限等待不会解除**：宿主只发 `pending`。

## 致谢与免责

交互思路（轮次分组、耗时显示、可折叠详情、保留终态）受 DeepSeek Harness 风格的运行时间线启发；本仓库不包含任何 DeepSeek 源码或界面资源。详见 [NOTICE](NOTICE)。

## 许可证

[MIT](LICENSE)

# players-unified 整合架构

> 本文档定义 localplayer / PluginPlayer / daily_player 三端的整合骨架与目录布局。
> **状态：已整合（物理合并）。** 三端源码已作为子目录并入本仓库（见 §0），领域模型 + 端口契约（§2–§5）作为后续统一工作的设计基线。
> 三端之外的**统一 Cordis 宿主**已落地在 `host/`（Phase 5 / S5，见 §1 末条与 §4 末节），它提供编排与后端面，不参与解码。

---

## 0. 背景与原则

本地已实现播放器的三个方向：

| 端 | 路径 | 形态 | 解码引擎 | UI | 媒体源 | 网络/投送 | 插件体系 |
|---|---|---|---|---|---|---|---|
| daily_player | `daily_player/` | 桌面 App（Python exe） | libVLC | tkinter | 本地文件/文件夹 | 无 | 无 |
| localplayer | `localplayer/` | 浏览器扩展（MV3） | 浏览器 `<video>`/hls.js | HTML/CSS/JS | 本地打包 + 远端 `server.py` | WebRTC 网页投送 | 最小 `plugin-api` |
| PluginPlayer | `pluginplayer/` | 桌面 App（C++，cordis） | FFmpeg + SDL3 | SDL3 + Cordis JS | Cordis 媒体插件 | 插件可扩展 | 完整「一切皆插件」 |

> 以上三个子目录即整合前的 `G:\repos\daily_player`、`G:\repos\localplayer`、`G:\repos\pluginplayer`，已整体复制进本仓库根目录，**不再跨仓库引用**。

**整合原则**

1. 三端语言/宿主不同（Python / JS / C++），**不做跨语言源码合并**；改为**物理整合**：三端源码作为独立子目录共存于本仓库，避免跨仓库引用（submodule / 外部路径依赖）。
2. 统一「**领域模型 + 端口（Port）接口**」，各宿主实现对应的**适配器（Adapter）**。
3. 优先统一复用率最高的点：**媒体枚举（MediaItem schema）**，其次统一 UX 控制契约。

---

## 1. 分层架构

```
Layer 0  领域模型（语言中立）        MediaItem / SubtitleTrack / PlayerState / Playlist
   │
Layer 1  端口（接口契约）            MediaSource / PlayerEngine / SubtitleProvider / CastTransport
   │
Layer 2  宿主适配器                  daily_player · localplayer · PluginPlayer 各自实现 Layer1
   │
Layer 3  共享 UX 契约                统一控制集 + 快捷键（三端对齐）
```

- **Layer 0/1 是跨端共享的「契约」**，以语言中立的 JSON Schema / 接口描述存在（本仓库维护）。
- **Layer 2 是各端自己的代码**，只需让既有实现「长得像」契约即可，不需要改引擎。
- **Layer 3 是 UI 层的弱约定**，不强制同一套控件实现，只对齐暴露的能力与快捷键。
- **「内核门面」是 Layer 2 内部的一种组织方式**（daily_player 已落地，`daily_player/kernel.py`）：
  同一份 UI 下面挂多个可换引擎时，把「选哪个内核 / 进程怎么管 / 能力差在哪」收进一个门面，
  UI 只依赖端口的超集 + **显式能力声明 `caps`**。差异**声明**而不是嗅探 —— 假装两个内核一样，
  问题只会在运行时炸。
- **统一宿主 `host/` 是 Layer 2 之上的「编排层」（Phase 5 / S5）**：它跑在 Node 上，用
  Cordis 把「三端各自的后端面」重写成可插拔插件。**它不参与解码、不合并运行时**，
  只做三件事：**枚举聚合**（`ctx.media`）、**深链分发**（`planOpen`/`open`）、
  **后端面托管**（`ctx.web` 上的 `/api/list`、`/media`、`/ws`、`/remote`）。
  配置形态学 dsh：基座 → bundle → profile → patch，`--dump-config` 打印实际启动后的插件树。
  它与 Layer 1/2 的关系是「**消费**」，不是「替换」：来源适配器照样调各端自己的实现，
  换掉的只是原先各自为政的 HTTP 后端（`localplayer/server.py` 已被它覆盖，见 §4）。

---

## 2. 领域模型（JSON Schema 草案）

### MediaItem
```json
{
  "id": "string  // 稳定标识（路径哈希或 URI），用于进度记忆/去重",
  "uri": "string  // 可播放地址：本地绝对路径 或 http(s) URL",
  "title": "string",
  "artist": "string | null  // 音频/曲目用",
  "kind": "\"audio\" | \"video\"",
  "durationMs": "number | null",
  "source": "string  // 来源标识：local-file / bundled / remote / plugin:<name>",
  "subtitleTracks": [
    { "id": "string", "label": "string", "lang": "string | null", "embedded": "boolean" }
  ],
  "thumbnail": "string | null"
}
```

### PlayerState
```json
{
  "playing": "boolean",
  "timeMs": "number",
  "durationMs": "number | null",
  "rate": "number  // 0.25..3",
  "volume": "number  // 0..100",
  "muted": "boolean",
  "fullscreen": "boolean"
}
```

### Playlist
```json
{ "items": "MediaItem[]", "cursor": "number  // 当前索引" }
```

---

## 3. 端口契约（接口描述，语言中立）

### MediaSource（媒体源）
```ts
interface MediaSource {
  id: string;                 // 来源标识，对应 MediaItem.source
  list(): MediaItem[] | Promise<MediaItem[]>;
}
```

### PlayerEngine（播放引擎）
```ts
interface PlayerEngine {
  load(item: MediaItem): void;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  setRate(rate: number): void;            // 0.25..3
  setVolume(vol: number): void;           // 0..100
  snapshot(path: string): void;           // 截图保存
  getState(): PlayerState;
}
```

### SubtitleProvider（字幕）
```ts
interface SubtitleProvider {
  parseSRT(path: string): SubtitleTrack[];   // 解析外部 .srt
  selectEmbedded(trackId: string): void;     // 切换内嵌轨
}
```

### CastTransport（投送，可选）
```ts
interface CastTransport {
  start(item: MediaItem): void;
  stop(): void;
  onViewerCount(cb: (n: number) => void): void;
}
```

---

## 4. 各宿主适配器映射

### daily_player（Python + tkinter；**默认内核 PluginPlayer**，可选 libVLC）
| 端口 | 映射方式 |
|---|---|
| `PlayerEngine` | ✅ 已落地，两条实现同一端口：`daily_player/player_engine.py` 的 `VlcPlayerEngine`（依赖注入 instance+player，**不 import vlc** 以便单测；`load`→`media_new`+`set_media`、`seek`→`set_time`、`snapshot`→`video_take_snapshot(0,path,0,0)`）、`daily_player/player_engine_rpc.py` 的 `PluginPlayerRpcEngine`（走 PluginPlayer 控制通道，TCP + 换行分隔 JSON-RPC）。rate 夹 0.25..3、volume 夹 0..100。 |
| `MediaSource` | ✅ 已落地：`daily_player/media_source.py` 的 `LocalFileSource.list()` 返回 `MediaItem[]`（见 `schema/media-item.schema.json`）。 |
| `SubtitleProvider` | 外部字幕复用 `parse_srt()`（面板自绘，内核无关）；内嵌轨经 `kernel.subtitle_tracks()` / `select_subtitle()`（两个内核各自映射到 `video_set_spu` / `player.select_track`）。 |
| `CastTransport` | 暂不支持（未来可加）。 |

> 现状：**内核选择与差异已收口在 `daily_player/kernel.py`**（`choose_kernel()` 决策 + `PluginPlayerProcess` 托管 + `Kernel` 门面与 `caps` 能力声明）。`play.py` 只依赖端口 + 能力声明，**已无 libVLC 专有调用**；默认 PluginPlayer，`--kernel=vlc|auto` 可切。

### localplayer（Chrome MV3 扩展）
| 端口 | 映射方式 |
|---|---|
| `PlayerEngine` | ✅ 已落地：`localplayer/player_engine.js`（经典脚本，挂 `globalThis.LpPlayerEngine`）把 offscreen 的 `<video>`/`<audio>` 适配成端口；秒↔毫秒、`volume 0..1`↔`0..100` 换算在适配器内完成。**`snapshot()` 返回 false**（浏览器无法按路径落盘，与 §5 的 UX 表一致）。 |
| `MediaSource` | 即 `plugins/plugin-api.collectMedia()` 的 fallback 链：本地打包源 + 「远端后端」源（`server.py /api/list`）。 |
| `SubtitleProvider` | hls.js / 原生 `<track>` + `textTracks` 切换。 |
| `CastTransport` | 已实现：offscreen `castStart`/`castStop` + WebRTC，`popup` 显示「投送中 · N 个接收端」。 |

> `server.py /api/list` 当前返回 `{name,type,path,tracks}`，已接近 `MediaItem`，仅缺 `id`/`artist`/`durationMs`，对齐成本低。

### PluginPlayer（C++ FFmpeg + SDL3 + Cordis）
| 端口 | 映射方式 |
|---|---|
| `PlayerEngine` | ✅ 已落地：`pluginplayer/host-js/player-engine.mjs` 的 `createPlayerEngine(ctx.player)`，把控制通道 RPC 适配成端口（`seek` 毫秒→秒、`volume` 0..100→0..1、`snapshot`→原生 `snapshot [dir]` 命令）。`volume/muted/fullscreen` 控制通道无 getter，由适配器本地跟踪。 |
| `MediaSource` | ✅ 已落地：Cordis JS 插件 `host-js/plugins/media-library.mjs` 扫描目录产出 `MediaItem[]`（`source: 'plugin:media-library'`），并提供 `GET /api/library`、`POST /api/library/rescan` HTTP 接口（令牌鉴权）。SDK 侧 `PP_MediaItem` 继续作为 C ABI 镜像。 |
| `SubtitleProvider` | 可作为 Cordis 插件（沿用现有 `PP_TOPIC_MEDIA_TRACKS` 事件）。 |
| `CastTransport` | 可作为 Cordis 插件（未来）。 |

> PluginPlayer 源码已并入 `pluginplayer/` 并实际阅读：C++ 引擎层以 `PP_MediaInfo` 承载当前媒体技术信息；媒体枚举/来源已通过 Cordis JS 插件 `media-library` 落地（扫描目录产出 `MediaItem[]`）。已在 SDK 定义 `PP_MediaItem` 作为 `MediaItem` 的 C ABI 镜像；该结构体为新增、不修改任何已有 `PP_*` 字段，**无需递增 `PP_ABI_VERSION`**。

### players-unified host（统一 Cordis 宿主，Phase 5 / S5）

`host/` 也是 Layer 2 的一个宿主，只是它**不是播放器**，而是「编排 + 后端面」宿主。
它与三端的关系、以及三端哪些东西被它接管，逐个端口列清楚：

| 端口 | 映射方式 |
|---|---|
| `MediaSource` | ✅ 已落地：三个来源适配器插件（`host/src/sources/{pluginplayer,localplayer,daily}.mjs`）各自把枚举函数注册进 `ctx.media`，注册是**可撤销副作用**（`ctx.effect`），所以整组来源能被 profile/patch 关掉。对应各端原有实现：PluginPlayer → `GET http://127.0.0.1:7913/api/library`（带 `X-PP-Token`）、localplayer → `GET /api/list`、daily_player → 子进程跑 `LocalFileSource.list()`。聚合结果与 `launcher.aggregate()` 在真实 fixture 上**逐项一致**（`host/tests/parity.mjs` 10/10）。 |
| `PlayerEngine` | ❌ 不实现，**有意为之**：宿主不解码。它只把「该由谁播放」算成一个动作（`planOpen`：`rpc` / `browser` / `spawn`）再分发。 |
| `CastTransport` | ✅ **信令侧**已接管：`host/src/web/remote.mjs` 提供 `/ws`（自写 RFC6455，`host/lib/ws.mjs`）与 `/remote` 观看页，状态机是 `localplayer/server.py` 的逐行移植（纯模块 `host/src/web/signaling.mjs`），A/B 对拍逐条一致（`host/tests/remote-parity.mjs` 16/16）。媒体面（WebRTC 编解码）仍在扩展侧，宿主不碰。 |
| `SubtitleProvider` | ❌ 不实现（属播放端）。 |
| localplayer 的 HTTP 后端 | ✅ **被接管**：`/api/list`、`/media/<file>`、`/ws`、`/remote` 现在由宿主同一端口（默认 5000）提供，**扩展端零改动**（它连的地址没变）。`server.py` 保留为「纯 python 环境下的退路」，但已是第二实现。 |

> 为什么值得这么做：原先「枚举聚合」在 `launcher/server.mjs`（独立进程、独立配置），
> 「媒体清单 + 信令」在 `localplayer/server.py`（Flask），两者各有一套来源配置、两套故障模型。
> 收进宿主后这些变成**同一棵插件树上的条目**：profile 决定谁在跑，`--dump-config` 一眼看到
> 实际启用了什么，`disabled` 能整组关掉，patch 能只改一个参数。
> 宿主**不做**的：跨语言源码合并、解码、UI 统一（§0 原则 1 与 §8 仍然成立）。

---

## 5. 共享 UX 契约（Layer 3，弱约定）

三端对齐「暴露的能力 + 快捷键」，不强求同一套控件：

| 能力 | 快捷键（建议统一） | daily | localplayer | PluginPlayer |
|---|---|---|---|---|
| 播放/暂停 | 空格 | ✅ | ✅ | 待探 |
| 快退/快进 10s | ← / → | ✅ | ✅ | 待探 |
| 音量 ± | ↑ / ↓ / 滚轮 | ✅ | ✅ | 待探 |
| 调速 | 0.25–3x | ✅ | ✅ | 待探 |
| 全屏 | F / F11 | ✅ | ✅ | 待探 |
| 主题切换 | T | ✅ | ❌ | 待探 |
| 截图 | 按钮 | ✅ | ❌ | 待探 |
| 系统托盘 | 按钮 | ✅(pystray) | ❌ | 待探 |
| 投送 | — | ❌ | ✅(WebRTC) | 待探 |

daily_player 已基本齐备；localplayer 的 `player.html` 已镜像多数；PluginPlayer 待探。

---

## 6. 建议的第一步（低风险、高复用）

**统一 `MediaItem` JSON schema**，让三端的媒体枚举都产出它。规范定义见 [`schema/media-item.schema.json`](schema/media-item.schema.json)（Layer 0 契约，三端对齐基准）。

1. **localplayer**：✅ `server.py /api/list` 已产出 `MediaItem`（`id`/`uri`/`title`/`artist`/`kind`/`durationMs`/`source`/`subtitleTracks`/`thumbnail`）；`background.js` 的远端源适配器已透传规范字段（并保留 `name`/`type`/`path` 过渡别名以兼容 popup）。
2. **daily_player**：✅ 新增 `media_source.py` 的 `LocalFileSource.list()` 返回 `MediaItem[]`（`play.py` 既有行为未改）。
3. **PluginPlayer**：✅ Cordis JS 插件 `host-js/plugins/media-library.mjs` 落地「媒体源」（扫描目录产出 `MediaItem[]`，HTTP `/api/library` 接口），SDK 侧 `PP_MediaItem` 作为 C ABI 镜像已就绪。

完成后，可做一个**「统一启动器」**：聚合三端 `MediaSource.list()`，在一个界面里列出全部可播媒体。这是整合的第一个真正可用的跨端产物。

---

## 7. 路线图（规划，未排期）

- **Phase 0**：定义领域模型 + 端口契约 + 本文档 + 三端源码物理整合进本仓库。✅ 已完成。
- **Phase 1**：`MediaItem` schema 三端对齐（见 §6）。✅ 已完成 —— localplayer / daily_player / PluginPlayer 三端均落地「媒体源」产出 `MediaItem[]`；并各含 schema 断言测试（`daily_player/tests`、`localplayer/tests`、`pluginplayer/host-js/plugins/lib`），零三方依赖、直跑真实代码路径。
- **Phase 2**：共享 UX 控制契约对齐（见 §5）。✅ 已完成 —— 三端均落地 `PlayerEngine` 适配器（`daily_player/player_engine.py`、`localplayer/player_engine.js`、`pluginplayer/host-js/player-engine.mjs`），并各含 `PlayerState` schema 断言测试；能力差异（如 localplayer 不支持 `snapshot`）已在适配器 `capabilities` 中显式声明。
- **Phase 3**：统一启动器（枚举聚合 + 深链跳转）。✅ 已完成 —— `launcher/server.mjs`（Node 零依赖 + `index.html` UI）聚合三端 `MediaSource.list()`，单个来源故障只降级为 error 不拖垮整体；`POST /api/open` 按来源端深链：PluginPlayer → 控制通道 `player.open`、localplayer → 浏览器打开远端 URL、daily_player → `spawn python play.py <path>`。端到端验证见 `launcher/tests/e2e.mjs`。
- **Phase 4（可选）**：跨宿主「引擎可替换」——用 PluginPlayer 的 FFmpeg 引擎驱动 daily_player 的 UI。✅ **评估完成 + S0/S1 已落地并实测通过**：可行性评估与实测数据见 [docs/phase4-kernel-assessment.md](docs/phase4-kernel-assessment.md)（§0 结论 / §8 实测）。结论要点：
  - **daily_player 端可行**：PluginPlayer 已有 `--hidden` 无人值守模式（`src/core/main.cpp:11`）+ 完整控制通道，且 Phase 2 的 `PlayerEngine` 端口正是替换缝 → S0 已落地 `daily_player/player_engine_rpc.py`（与 `VlcPlayerEngine` 同一端口，UI 可不改切换）。
  - **S1 尖峰已实测通过**（`daily_player/spike_s1.py`，无人值守，**18 项断言全绿**，耗时 10.69s；含 S3 新增的全屏组）：
    - RPC 往返 **p50 ≈ 16.65ms ≈ 1 帧 @60fps**（请求在主线程每帧开头抽干，`src/core/app.cpp:1058`）→ UI 控制够用，**逐帧驱动不行**；
    - `player.open` 1280x720 h264 8.0s ✅ / 进度单调推进 ✅ / seek·rate·volume·mute 往返一致 ✅；
    - 字幕 `subtitle.line` 事件链路打通 ✅（外部 UI 可自画字幕；内核只在文本变化时广播，`app.cpp:948`）；
    - 截图落盘 ✅（**需 `--write-dir`，否则被 `Host::isWriteAllowed` 拒**，`src/core/host.cpp:539`）；
    - `getState()` 与 `VlcPlayerEngine` 产出**同一个 PlayerState**（符合 schema）→ 换内核不动 UI 得到实测验证。
  - **形态 A 面板** `daily_player/spike_panel.py`：控制逻辑（`PanelController`）与 tkinter 分离，可无 GUI 回归（`tests/test_spike_panel.py` 14 项全绿）。窗口为「控制面板 + 播放器窗口」两个——单窗口需 S2。
  - **localplayer 端不成立，维持搁置**：MV3 扩展无 Node 运行时（Cordis 要求 Node ≥ 22）且无法承载原生 FFmpeg；若要让 PluginPlayer 当它的内核，需 PluginPlayer 学会推流（从播放器变服务器）并使扩展失去「离线免后端」特性。引入 MediaMTX 亦属多余（只转封装不转码）。
  - **S3（全屏）已补齐**：新增 `app.fullscreen` 方法（`{"value":0|1}` 设值 / `-1` 取反）+ `app.fullscreen` 事件；快捷键 F / ESC 收敛到同一个 `App::setFullscreen()` 入口（原来各自改 `fullscreen_` 不发事件）。`--hidden` 下明确返回失败而非假装成功。适配器新增 `setFullscreen()`，`getState().fullscreen` 由事件校正（能反映"用户在播放器窗口按 F"）。实测 6 项全绿，官方 `tools/rpc_client.py` **24/24**。详见评估文档 §10。
  - **S4（默认切内核）已落地**：`daily_player/kernel.py` 把"选哪个内核"收成一个入口 —— `choose_kernel()`（纯函数决策）+ `PluginPlayerProcess`（无人值守拉起 + 事件订阅）+ `Kernel` 门面（端口直通 + 能力声明 + 内核专属补差）。`play.py` **不再 `import vlc`**，默认走 PluginPlayer，`--kernel=vlc|auto` 可显式切换（**只有 `auto` 允许回落**；默认内核找不到时明确报错，不静默换引擎）。
    - **能力差异声明而非嗅探**：`embed`（vlc ✅ / pp ❌）、`externalFullscreen`（pp ✅）、`subtitleTracks`（两者 ✅）、`disableSubtitle`（vlc ✅ / pp ❌，RPC 不接受 `-1`）、截图落盘（pp 受写入白名单限制 → 门面内部中转）。
    - **实测三层**：门面单测 44 项全绿（`tests/test_kernel.py`）；真机 E2E **23/23**（`daily_player/e2e_kernel.py`，报告 `docs/kernel-e2e-report.json`）；GUI 冒烟（真实 Tk root、非嵌入路径）通过，`on_close()` 后残留进程 **0**。
    - **实测抓到并修掉 2 个真问题**：① 控制通道**默认不推任何事件**，不 `topic.subscribe(app.fullscreen)` 就永远收不到全屏事件（已加入 `DEFAULT_TOPICS` 并在接线层断言）；② snapshot 插件计数器**每进程归零**，会覆盖白名单目录里上一轮的同名文件 → 只比文件名的中转实现会误报"截图失败"（改为比 `mtime+size`，中转件复制后删除，已加回归）。详见评估文档 §11。
  - 剩余缺口（均非阻塞）：画面无法嵌入外部窗口（S2，需改 C++ 用 `SDL_CreateWindowFrom`）、播放列表需 UI 侧自建、分发需带预编译 exe。详见评估文档 §9。
- **Phase 5**：统一 Cordis 宿主（`host/`，把三端的「后端面」收成一棵可插拔插件树）。✅ **S5-1 / S5-2 / S5-3 全部落地并实测通过**，详见 `host/README.md` 与 [docs/phase4-kernel-assessment.md](docs/phase4-kernel-assessment.md) §12：
  - **S5-1 宿主骨架**：形态学 dsh（Profile → Bundle → Patch 分层合成）+ 自建嵌套分组插件（loader 自带的 `Group` 实测是**平铺**的，拿不到分层 id）+ `ctx.media` 服务 + `--dump-config` 溯源。`ctx.media.aggregate()` 与 `launcher.aggregate()` 在真实数据上逐项一致（10/10），loader 语义探针 27/27。
  - **S5-2 列表面**：`localplayer` 的 `/api/list` + `/media/<file>` 收成 Cordis 插件，与 python `media_lib.build_media_items()` **逐字段 + 键顺序**一致（27/27），并补了单段 Range。
  - **S5-3 投送面**：**零依赖手写 RFC6455**（`host/lib/ws.mjs`）+ `/ws` 信令中继 + `/remote` 观看页。帧级验收 36/36（含 undici 真客户端互操作与非法帧关闭码），信令状态机与 python `server.py` **跨语言 A/B 对拍逐条一致**（16/16）。
  - **对拍当场抓出的真 bug**：`server.py` 的 `ws_signaling()` 因 `_last_meta` 的局部变量语义必然抛 `UnboundLocalError` → **任何 viewer 一连接 `/ws` 就 500**，网页投送从接收端不可用。已修（`global _last_meta`，`localplayer/CHANGELOG.md`）。
  - 宿主**不做**的事（有意）：跨语言源码合并、解码、UI 统一。§0 原则 1（物理整合）与 §8 的硬约束因此未变。

## 8. 风险与未决

- 三端语言不同，只能共享 **schema/契约**，无法共享实现；适配器各自维护。
- daily_player 无插件/无网络，其适配器需要新增最小抽象层（仅结构调整）。
- PluginPlayer 内部接口已在 P0-1 读码探明并落地「媒体源」Cordis 插件（`media-library`），§4 映射已对齐；引擎层/UX（§5）快捷键等仍待补全。
- ~~统一启动器若要真正播放跨端媒体，需解决「谁来解码」：本地路径在浏览器端无法直接 `file://` 播放……Phase 3 需决策。~~ → **Phase 3 已决策并落地**：**不跨端解码**，改为**深链到拥有该媒体的那一端**（各端用自己的引擎播放）。启动器只负责「枚举聚合 + 路由」，本地路径不会被塞给浏览器端，§8 原硬约束因此消解。
- **宿主带来的新面（Phase 5）**：`localplayer` 的 python 后端已可被宿主完全替代，于是同一份能力有了**两套实现**（python / Node）—— 这会分叉。处理办法：宿主侧用 A/B 对拍把「一致」钉成可回归断言（`host/tests/library-parity.mjs`、`remote-parity.mjs`），
  并且**发现参照实现有 bug 时先修参照实现再做对拍**（S5-3 就撞上了 `_last_meta` 那个必崩 bug）。
  `server.py` 的定位相应变为「没有 Node 时的退路」，不再是唯一真相；若将来只留一条实现，应留宿主这条（它有三套验收报告 + 一个 `--check` 门禁）。
- **宿主不接管的部分**：PluginPlayer 的 `/api/library`（它自带 token 鉴权与写白名单）与 daily_player 的 `play.py`（它是终端的播放器进程）仍是各自独立进程，宿主只深链过去。统一到此为止是**有意**的取舍，不是没做完。

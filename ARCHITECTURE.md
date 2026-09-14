# players-unified 整合架构

> 本文档定义 localplayer / PluginPlayer / daily_player 三端的整合骨架与目录布局。
> **状态：已整合（物理合并）。** 三端源码已作为子目录并入本仓库（见 §0），领域模型 + 端口契约（§2–§5）作为后续统一工作的设计基线。

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

### daily_player（Python + libVLC）
| 端口 | 映射方式 |
|---|---|
| `PlayerEngine` | ✅ 已落地：`daily_player/player_engine.py` 的 `VlcPlayerEngine`（依赖注入 instance+player，**不 import vlc** 以便单测）。`load`→`media_new`+`set_media`、`seek`→`set_time`（毫秒直通）、`snapshot`→`video_take_snapshot(0,path,0,0)`、`getState`→`get_time/get_length/get_state/get_rate/audio_get_volume`；rate 夹 0.25..3、volume 夹 0..100。 |
| `MediaSource` | ✅ 已落地：`daily_player/media_source.py` 的 `LocalFileSource.list()` 返回 `MediaItem[]`（见 `schema/media-item.schema.json`）。`play.py` 既有 `open_folder` 行为未改（仅结构抽取，不动 libVLC）。 |
| `SubtitleProvider` | 复用现有 `parse_srt()` + `video_set_spu()`。 |
| `CastTransport` | 暂不支持（未来可加）。 |

> 现状：单文件 `play.py`，**无抽象层**。适配器需先抽出最小 `PlayerEngine`/`MediaSource` 接口（仅改结构，不改 libVLC 行为）。

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
  - **S1 尖峰已实测通过**（`daily_player/spike_s1.py`，无人值守，13 项断言全绿，耗时 9.68s）：
    - RPC 往返 **p50 ≈ 16.65ms ≈ 1 帧 @60fps**（请求在主线程每帧开头抽干，`src/core/app.cpp:1058`）→ UI 控制够用，**逐帧驱动不行**；
    - `player.open` 1280x720 h264 8.0s ✅ / 进度单调推进 ✅ / seek·rate·volume·mute 往返一致 ✅；
    - 字幕 `subtitle.line` 事件链路打通 ✅（外部 UI 可自画字幕；内核只在文本变化时广播，`app.cpp:948`）；
    - 截图落盘 ✅（**需 `--write-dir`，否则被 `Host::isWriteAllowed` 拒**，`src/core/host.cpp:539`）；
    - `getState()` 与 `VlcPlayerEngine` 产出**同一个 PlayerState**（符合 schema）→ 换内核不动 UI 得到实测验证。
  - **形态 A 面板** `daily_player/spike_panel.py`：控制逻辑（`PanelController`）与 tkinter 分离，可无 GUI 回归（`tests/test_spike_panel.py` 14 项全绿）。窗口为「控制面板 + 播放器窗口」两个——单窗口需 S2。
  - **localplayer 端不成立，维持搁置**：MV3 扩展无 Node 运行时（Cordis 要求 Node ≥ 22）且无法承载原生 FFmpeg；若要让 PluginPlayer 当它的内核，需 PluginPlayer 学会推流（从播放器变服务器）并使扩展失去「离线免后端」特性。引入 MediaMTX 亦属多余（只转封装不转码）。
  - 剩余缺口（均非阻塞）：控制通道**没有全屏/窗口方法**（S3）、画面无法嵌入外部窗口（S2，需改 C++ 用 `SDL_CreateWindowFrom`）、播放列表需 UI 侧自建、分发需带预编译 exe。详见评估文档 §9。

## 8. 风险与未决

- 三端语言不同，只能共享 **schema/契约**，无法共享实现；适配器各自维护。
- daily_player 无插件/无网络，其适配器需要新增最小抽象层（仅结构调整）。
- PluginPlayer 内部接口已在 P0-1 读码探明并落地「媒体源」Cordis 插件（`media-library`），§4 映射已对齐；引擎层/UX（§5）快捷键等仍待补全。
- ~~统一启动器若要真正播放跨端媒体，需解决「谁来解码」：本地路径在浏览器端无法直接 `file://` 播放……Phase 3 需决策。~~ → **Phase 3 已决策并落地**：**不跨端解码**，改为**深链到拥有该媒体的那一端**（各端用自己的引擎播放）。启动器只负责「枚举聚合 + 路由」，本地路径不会被塞给浏览器端，§8 原硬约束因此消解。

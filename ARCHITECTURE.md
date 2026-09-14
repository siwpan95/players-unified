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
| `PlayerEngine` | 把 `DailyPlayer.player`（libVLC `media_player`）包一层：`load`→`media_new`+`set_media`、`seek`→`set_time`、`snapshot`→`video_take_snapshot`、`getState`→`get_time/get_length/get_state`。 |
| `MediaSource` | ✅ 已落地：`daily_player/media_source.py` 的 `LocalFileSource.list()` 返回 `MediaItem[]`（见 `schema/media-item.schema.json`）。`play.py` 既有 `open_folder` 行为未改（仅结构抽取，不动 libVLC）。 |
| `SubtitleProvider` | 复用现有 `parse_srt()` + `video_set_spu()`。 |
| `CastTransport` | 暂不支持（未来可加）。 |

> 现状：单文件 `play.py`，**无抽象层**。适配器需先抽出最小 `PlayerEngine`/`MediaSource` 接口（仅改结构，不改 libVLC 行为）。

### localplayer（Chrome MV3 扩展）
| 端口 | 映射方式 |
|---|---|
| `PlayerEngine` | offscreen 文档里的 `<video>`/`<audio>` 元素即引擎；`popup.js`/`player.js` 已封装 play/pause/seek/rate/volume。 |
| `MediaSource` | 即 `plugins/plugin-api.collectMedia()` 的 fallback 链：本地打包源 + 「远端后端」源（`server.py /api/list`）。 |
| `SubtitleProvider` | hls.js / 原生 `<track>` + `textTracks` 切换。 |
| `CastTransport` | 已实现：offscreen `castStart`/`castStop` + WebRTC，`popup` 显示「投送中 · N 个接收端」。 |

> `server.py /api/list` 当前返回 `{name,type,path,tracks}`，已接近 `MediaItem`，仅缺 `id`/`artist`/`durationMs`，对齐成本低。

### PluginPlayer（C++ FFmpeg + SDL3 + Cordis）
| 端口 | 映射方式 |
|---|---|
| `PlayerEngine` | FFmpeg 解码 + SDL3 输出的宿主层，预期可包成 `PlayerEngine`。 |
| `MediaSource` | ✅ 契约已定义：`src/sdk/player_plugin.h` 新增 `PP_MediaItem`（对齐 `schema/media-item.schema.json`）。未来「媒体源插件」产出 `PP_MediaItem[]` 即 `MediaSource` 端口实现。 |
| `SubtitleProvider` | 可作为 Cordis 插件（沿用现有 `PP_TOPIC_MEDIA_TRACKS` 事件）。 |
| `CastTransport` | 可作为 Cordis 插件（未来）。 |

> PluginPlayer 源码已并入 `pluginplayer/` 并实际阅读：当前**尚无媒体源插件**（C++ 引擎层以 `PP_MediaInfo` 承载当前媒体技术信息，媒体枚举/来源插件尚未实现）。已在 SDK 定义 `PP_MediaItem` 作为 `MediaItem` 的 C ABI 镜像；该结构体为新增、不修改任何已有 `PP_*` 字段，**无需递增 `PP_ABI_VERSION`**。

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
- **Phase 1**：`MediaItem` schema 三端对齐（见 §6）。🔶 进行中 —— localplayer / daily_player 已落地，PluginPlayer 仅定义 SDK 契约（媒体源插件待实现）。
- **Phase 2**：共享 UX 控制契约对齐（见 §5）。
- **Phase 3**：统一启动器（聚合三端 `MediaSource`）。
- **Phase 4（可选）**：探索跨宿主「引擎可替换」（如用 PluginPlayer 的 FFmpeg 引擎驱动 daily_player 的 UI）——仅作长期设想。

## 8. 风险与未决

- 三端语言不同，只能共享 **schema/契约**，无法共享实现；适配器各自维护。
- daily_player 无插件/无网络，其适配器需要新增最小抽象层（仅结构调整）。
- PluginPlayer 内部接口**未探明**，§4 映射为推测，需读码回填。
- 统一启动器若要真正播放跨端媒体，需解决「谁来解码」：本地路径在浏览器端无法直接 `file://` 播放（localplayer 走打包/远端，不直接播本地文件），这是跨端启动器的硬约束，Phase 3 需决策。

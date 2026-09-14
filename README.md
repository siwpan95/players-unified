# players-unified

> 版本 **0.3.0** · Phase 1–3 均已完成（MediaItem / PlayerEngine 三端对齐 + 统一启动器）

本地三个播放器方向的**整合仓库**：三端源码已作为子目录并入本仓库根目录，统一承载、统一版本管理（不再跨仓库引用）。

## 三端（本仓库子目录）

| 项目 | 路径 | 方向 | 技术栈 |
|---|---|---|---|
| daily_player | [`daily_player/`](daily_player/) | 桌面视频播放器（本地） | Python 3.14 + tkinter + python-vlc（libVLC 引擎），PyInstaller 打包 exe |
| localplayer | [`localplayer/`](localplayer/) | 浏览器扩展（网页插件版） | Chrome MV3：popup/player.html + offscreen `<video>`，hls.js |
| PluginPlayer | [`pluginplayer/`](pluginplayer/) | 桌面应用（cordis 独立应用） | C++ FFmpeg + SDL3 原生宿主 + Cordis JS 插件层 |

## 统一启动器（Phase 3）

`launcher/`（Node，零三方依赖）：

```bat
node launcher/server.mjs            :: 默认读 launcher/config.json，监听 7920
```

- `GET /` — 聚合 UI；`GET /api/aggregate` — 汇总三端 `MediaItem[]`（每项带 `_end` 来源标记，单源故障降级为 error）
- `POST /api/open {id, dryRun?}` — 深链跳转：PluginPlayer → 控制通道 `player.open`、localplayer → 浏览器打开远端 URL、daily_player → `spawn python play.py <path>`

来源与打开方式在 `launcher/config.json` 配置；端到端验证：`node launcher/tests/e2e.mjs`。

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 整合架构：目录布局 + 领域模型 + 端口契约 + 各宿主适配器映射 + 共享 UX 契约 + 路线图。
- [docs/phase4-kernel-assessment.md](docs/phase4-kernel-assessment.md) — 「以 PluginPlayer 为内核」可行性评估 + **S1 实测数据**（§8）。
- [docs/s1-spike-report.json](docs/s1-spike-report.json) — S1 尖峰的结构化实测报告（由 `spike_s1.py` 生成）。

## 内核替换尖峰（Phase 4 / S1）

```bat
F:/Python314/python.exe daily_player/spike_s1.py          :: 无人值守实测，退出码 0 = 全绿
F:/Python314/python.exe daily_player/spike_panel.py       :: 形态 A tkinter 面板
F:/Python314/python.exe daily_player/spike_panel.py --no-gui --seconds 3
```

`spike_s1.py` 会自己拉起 `pluginplayer.exe --hidden`（不弹窗）跑 7 组测量后收进程。
实测结论：RPC 往返 p50 ≈ **16.65ms**（≈1 帧 @60fps，UI 控制够用、逐帧驱动不行）；
字幕 `subtitle.line` / 截图 / 进度 / `PlayerState` 契约**全部打通**。

## 状态

✅ **已整合（物理合并）** · ✅ **Phase 1 已完成**。三端源码已复制进本仓库子目录；`MediaItem` 跨端共享契约已落地（`schema/media-item.schema.json`），localplayer / daily_player / PluginPlayer 三端均产出 `MediaItem[]`（PluginPlayer 通过 Cordis 插件 `media-library` 扫描目录 + HTTP `/api/library` 接口）。三端均含 `MediaItem` schema 断言测试（`daily_player/tests`、`localplayer/tests`、`pluginplayer/host-js/plugins/lib`），零三方依赖、直跑真实代码路径。Phase 2 的 `PlayerEngine` 适配器亦已三端落地（`daily_player/player_engine.py`、`localplayer/player_engine.js`、`pluginplayer/host-js/player-engine.mjs`），并各含 `PlayerState` schema 断言测试。Phase 4 的 **S0 + S1 + S3 已落地并实测通过**：`daily_player/player_engine_rpc.py`（同一 `PlayerEngine` 端口的 PluginPlayer 控制通道适配器，使 daily_player 可不改 UI 切换内核）+ `daily_player/spike_s1.py`（真实播放器尖峰，**18 项断言全绿**，含 S3 全屏 6 项）+ `daily_player/spike_panel.py`（形态 A 面板，控制器可无 GUI 回归 14 项）。实测：RPC p50 ≈ 16.65ms、字幕/截图/进度/契约全通，两适配器产出同一个 `PlayerState`。S3 新增控制通道 `app.fullscreen`（真实切换 + 事件广播，`--hidden` 下明确失败），官方 `tools/rpc_client.py` **24/24**。可行性评估见 [docs/phase4-kernel-assessment.md](docs/phase4-kernel-assessment.md)。详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

> 说明：三端语言/宿主不同（Python / JS / C++），整合方式是**物理整合（子目录共存）**而非跨语言源码合并；统一层只共享 schema/契约，各端仍按各自技术栈独立演进。

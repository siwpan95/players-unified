# players-unified

> 版本 **0.1.0** · Phase 1（MediaItem 对齐）进行中

本地三个播放器方向的**整合仓库**：三端源码已作为子目录并入本仓库根目录，统一承载、统一版本管理（不再跨仓库引用）。

## 三端（本仓库子目录）

| 项目 | 路径 | 方向 | 技术栈 |
|---|---|---|---|
| daily_player | [`daily_player/`](daily_player/) | 桌面视频播放器（本地） | Python 3.14 + tkinter + python-vlc（libVLC 引擎），PyInstaller 打包 exe |
| localplayer | [`localplayer/`](localplayer/) | 浏览器扩展（网页插件版） | Chrome MV3：popup/player.html + offscreen `<video>`，hls.js |
| PluginPlayer | [`pluginplayer/`](pluginplayer/) | 桌面应用（cordis 独立应用） | C++ FFmpeg + SDL3 原生宿主 + Cordis JS 插件层 |

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 整合架构：目录布局 + 领域模型 + 端口契约 + 各宿主适配器映射 + 共享 UX 契约 + 路线图。

## 状态

✅ **已整合（物理合并）** · 🔶 **Phase 1 进行中**。三端源码已复制进本仓库子目录；`MediaItem` 跨端共享契约已落地（`schema/media-item.schema.json`），localplayer / daily_player 已产出 `MediaItem`，PluginPlayer 已在 SDK 定义 `PP_MediaItem`。详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

> 说明：三端语言/宿主不同（Python / JS / C++），整合方式是**物理整合（子目录共存）**而非跨语言源码合并；统一层只共享 schema/契约，各端仍按各自技术栈独立演进。

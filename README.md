# players-unified

本地三个播放器方向的**整合规划 meta 仓库**（仅文档，未实施）。

## 三端

| 项目 | 路径 | 方向 | 技术栈 |
|---|---|---|---|
| daily_player | `G:\repos\daily_player` | 桌面视频播放器（本地） | Python 3.14 + tkinter + python-vlc（libVLC 引擎），PyInstaller 打包 exe |
| localplayer | `G:\local\localplayer` | 浏览器扩展（网页插件版） | Chrome MV3：popup/player.html + offscreen `<video>`，hls.js |
| PluginPlayer | `G:\local\pluginplayer` | 桌面应用（cordis 独立应用） | C++ FFmpeg + SDL3 原生宿主 + Cordis JS 插件层 |

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 整合骨架：领域模型 + 端口契约 + 各宿主适配器映射 + 共享 UX 契约 + 路线图（**规划，未执行**）。

## 状态

📋 **规划阶段**。本仓库目前只承载 schema 与契约定义，**未对三端做任何代码改动**，也未排期。

> 说明：三端语言/宿主不同（Python / JS / C++），整合原则是「统一领域模型 + 端口接口，各宿主做适配器」，**不做源码合并**。

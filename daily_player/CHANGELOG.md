# Changelog

本项目所有值得注意的变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **版本线说明**：`1.0.0` 是 daily_player 作为**独立项目**发布时的版本（PyInstaller exe，2026-08-27）。
> 并入 `players-unified` 之后，本文件改为跟随**仓库版本线**（仓库根 `VERSION`），所以下面新增的
> 条目号小于 `1.0.0` —— 这是两条版本线，不是版本回退。

## [0.7.0] - 2026-09-15

**默认内核切到 PluginPlayer**（Phase 4 / S4）。

### Added

- `kernel.py` — 内核选择与统一门面：
  - `choose_kernel()` 纯函数决策（可单测），`create_kernel()` 工厂；
  - `PluginPlayerProcess` — 无人值守拉起 `pluginplayer.exe`（`--hidden` + 控制通道 + 写入白名单），
    并完成 `auth` 与事件订阅；
  - `Kernel` 门面 + `VlcKernel` / `PluginPlayerKernel` — 端口方法直通，内核差异以 `caps`
    显式声明（`embed` / `externalFullscreen` / `subtitleTracks` / `disableSubtitle`），
    内核专属补差（远端全屏、字幕轨映射、截图中转）在此收口。
- `--kernel=pluginplayer|vlc|auto` 命令行参数（`auto` 才允许回落）。
- `e2e_kernel.py` — 门面层端到端探针，产出 `docs/kernel-e2e-report.json`。
- `tests/test_kernel.py` — 44 项断言，零三方依赖。

### Changed

- **默认内核由 libVLC 改为 PluginPlayer**；`play.py` 移除对 libVLC 的所有直接调用
  （`import vlc` 已删除），全程只经 `self.kernel`（端口 + 能力声明）。
- 默认内核找不到 `pluginplayer.exe` 时**明确报错并给出修复提示**，不再静默回落 VLC。
- 音量/倍速/播放暂停/进度/截图/字幕轨全部改走端口，UI 与内核解耦。
- `requirements.txt`：`python-vlc` 由必需变为**可选**。

### Fixed

- **控制通道事件订阅缺失**：控制通道默认不推送任何主题，此前 `PluginPlayerRpcEngine`
  从未订阅，导致 `app.fullscreen` 事件永远收不到（"用户在播放器窗口按 F"同步不回来）。
  现由 `subscribeDefaults()` 在连接后订阅 `app.fullscreen`。
- **截图误报失败**：`snapshot_NNNN.png` 的序号是每进程的，新进程会覆盖白名单目录里上一轮的
  同名文件，导致按"文件名是否新增"判断的中转实现误报"截图失败"。改为按 `(mtime, size)`
  识别本次产物，并在复制后清理中转件（每张数 MB）。
- 事件缓冲加 `MAX_BUFFERED_EVENTS = 512` 上限，防"订阅了广播但没人取走"时无界增长。
- 载入媒体后延迟刷新一次字幕轨列表（内核打开文件是异步的，首帧前 `tracks()` 可能为空）。

## [1.0.0] - 2026-08-27

### Added

- 首个发行版：Windows 可执行程序（PyInstaller，Python 3.14）。
- 发布面：gitee [siwpan/daily_player](https://gitee.com/siwpan/daily_player) release `v1.0.0`（日常视频播放器 v1.0.0）。
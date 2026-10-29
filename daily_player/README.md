# 日常视频播放器 (Daily Player)

日常视频播放器，支持字幕、播放列表和快捷键。**内核可换**：默认用
PluginPlayer（FFmpeg 引擎），也可以切回 libVLC。

## 功能

- **视频播放** — 默认内核 PluginPlayer（经控制通道驱动），可选内核 libVLC（嵌入窗口）；支持 mp4/avi/mkv/mov/wmv/flv/webm/m4v
- **SRT 字幕** — 自动解析同目录 .srt 文件，实时显示字幕
- **内嵌字幕** — 支持切换内嵌字幕轨道（能否经内核关闭字幕见下表）
- **播放列表** — 添加文件/文件夹，双击切换，Delete 删除
- **进度条** — 拖拽跳转，实时时间显示
- **播放速度** — 0.25x ~ 3.0x 可调
- **快进快退** — +/-10 秒跳转
- **截图** — 视频瞬间截图保存为 PNG
- **全屏** — 双击视频区域或 F11 切换
- **音量控制** — 滑块 + 鼠标滚轮
- **主题切换** — 深色 / 浅色主题 (T 键切换)
- **系统托盘** — 最小化到系统托盘 (需 pystray)
- **配置记忆** — 自动记住音量、窗口大小、播放位置、所选内核
- **快捷键** — 空格暂停、左右键快进快退、上下键音量、F 全屏、T 主题

## 快速开始

```bash
# 启动（默认内核：PluginPlayer，需要 pluginplayer.exe）
python play.py

# 指定内核
python play.py --kernel=pluginplayer   # 显式用 PluginPlayer
python play.py --kernel=vlc            # 用 libVLC
python play.py --kernel=auto           # 有 PluginPlayer 就用，没有才回落 VLC
python play.py 某视频.mp4              # 直接载入（统一启动器深链用）
```

### 内核怎么找 PluginPlayer

按顺序找，第一个存在的胜出：

1. 环境变量 `DAILY_PLAYER_PP_EXE` 指向的 exe；
2. `daily_player/pluginplayer/pluginplayer.exe`（随本目录分发）；
3. `<仓库根>/pluginplayer/dist/pluginplayer.exe`（本仓库构建产物）；
4. `G:\repos\pluginplayer\dist\pluginplayer.exe`（原仓库历史路径）。

都没找到时，**默认内核会直接报错并提示怎么修，而不是悄悄换回 VLC** —— 想允许回落请用 `--kernel=auto`。

### 用 libVLC 内核（可选）

```bash
pip install python-vlc
# 并安装 VLC 播放器（必需）：https://www.videolan.org/vlc/
python play.py --kernel=vlc
```

### 可选：系统托盘

```bash
pip install pystray Pillow
```

## 两个内核的能力差异

差异在 `kernel.py` 里以 `caps` **显式声明**，UI 按能力分支而不是猜：

| 能力 | `vlc` | `pluginplayer` | UI 表现 |
|---|---|---|---|
| `embed` 画面嵌入本窗口 | ✅ | ❌ | 非嵌入时明确提示"画面在 PluginPlayer 窗口" |
| `externalFullscreen` 播放器窗口全屏 | ➖ 不需要 | ✅ | 面板全屏时同步切播放器窗口 |
| `subtitleTracks` 读内嵌轨道 | ✅ | ✅ | 统一的下拉框 |
| `disableSubtitle` 经内核关字幕 | ✅ | ❌（RPC 不接受 `-1`） | 显示"关闭（仅面板字幕）" |
| 截图写到任意目录 | ✅ | ⚠️ 受 `--write-dir` 白名单限制 | 门面内部中转，对 UI 无感 |

PluginPlayer 内核的画面在**播放器自己的窗口**里（无法嵌入 tk 窗口，见
[docs/phase4-kernel-assessment.md](../docs/phase4-kernel-assessment.md) §2.2），面板负责控制条 + 字幕层。

## 快捷键

| 按键 | 功能 |
|------|------|
| 空格 | 播放 / 暂停 |
| ← → | 后退 / 前进 10 秒 |
| ↑ ↓ | 音量加减 |
| F / F11 | 全屏切换 |
| T | 主题切换 |
| Enter | 全屏 |
| Esc | 退出全屏 |
| 鼠标滚轮 | 调节音量 |
| 双击视频 | 全屏切换 |

## 依赖

- Python >= 3.8（本机实测 `/Python314`，3.14.6，自带 Tk）
- 默认内核：`pluginplayer.exe`（无需 pip 包）
- 可选内核：`python-vlc >= 3.0` + VLC 播放器
- 可选：`pystray`, `Pillow`（系统托盘）

## 测试

```bash
# 单测（零三方依赖，不需要播放器 exe）
/Python314/python.exe tests/test_kernel.py

# 门面端到端（需要真实 pluginplayer.exe + 媒体；缺条件则跳过）
/Python314/python.exe e2e_kernel.py
```

`e2e_kernel.py` 会验证：默认内核命中 PluginPlayer、进程拉起、经端口驱动播放、
`getState()` 报出真实进度与时长、`PlayerState` 通过 schema、音量/静音/倍速/跳转往返一致、
截图中转落盘、能力声明与实际行为一致（`--hidden` 下全屏如实返回失败）、退出无残留进程。
结果写入 `docs/kernel-e2e-report.json`。


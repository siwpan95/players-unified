# 可行性评估：以 PluginPlayer 为内核实现「三合一」

> 评估对象：把 `daily_player` 从 VLC 换成 PluginPlayer 内核；`localplayer` 引入 Cordis / MediaMTX；
> 最终以 `pluginplayer` 为唯一内核达成三端合一。
> 对应 ARCHITECTURE §7 的 **Phase 4（可选）**。
> 方法：**本地代码实证 + 联网核实组件现状**。所有结论均附可复核的 `文件:行` 或外部来源。

---

## 0. 结论速览（TL;DR）

| 命题 | 判定 | 关键依据 |
|---|---|---|
| Codis 有用 | ❌ 完全无关 | Redis 分布式代理，与本地播放器零交集（localplayer README L186 已述） |
| Cordis 引入 localplayer | ❌ 不可行（不止是过度设计） | Cordis 要求 **Node.js ≥ 22 / ESM-only**；MV3 扩展无 Node 运行时 |
| MediaMTX 引入 localplayer | ❌ 本地文件场景仍属多余 | MediaMTX 是**媒体路由器**，只转封装不转码，且不直接读本地文件 |
| daily_player 换 PluginPlayer 内核 | ✅ **可行，且 S1 已实测通过** | PluginPlayer 已有 `--hidden` 无人值守模式 + 完整控制通道；S1 尖峰 13 项断言全绿（见 §8） |
| 以 PluginPlayer 为内核做「三合一」 | ⚠️ **部分成立（≈2.5 合 1）** | 桌面端可真合流；浏览器端受 MV3 沙箱限制，只能"接流"不能"装内核" |

**一句话**：内核替换这条线**值得做**（且 Phase 1/2 刚建的 `PlayerEngine` 端口正好就是替换缝）；
但"三端都采用 Cordis/MediaMTX"这条线**不成立**——Cordis 跑不进浏览器扩展，MediaMTX 是给直播源做桥的。

> **2026-09-15 更新**：S0（适配器）与 S1（真实播放器尖峰）已完成并全绿，实测数据见 **§8**。
> 关键数字：**控制通道往返 ≈ 16.7ms（正好一帧 @60fps）**，字幕 / 截图 / 进度 / 契约全部打通。

---

## 1. 前提核验（先确认你说的两份 README）

| 项 | 结论 | 证据 |
|---|---|---|
| localplayer 有「架构选型笔记」且结论为"三者都不相关" | ✅ 原文属实 | `localplayer/README.md:182-193` |
| 其中 Codis = Redis 分布式集群方案 | ✅ | `localplayer/README.md:186` |
| 其中 Cordis = Koishi 可逆插件元框架（Node/TS 服务端） | ✅ | `localplayer/README.md:187` |
| 其中 MediaMTX = 多协议流媒体服务器，只转封装不转码 | ✅ | `localplayer/README.md:188` |
| daily_player 自述"基于 VLC…支持字幕、播放列表和快捷键" | ✅ 原文属实 | `daily_player/README.md:3` |

**重要**：那条结论的作用域是 **localplayer 单端**——原文理由是"本项目是纯前端、单机、无后端、无共享状态的 MV3 浏览器扩展"（L186）。
换成三合一视角后，作用域变了，结论需要重算（下面 §3 逐项重算）。

---

## 2. 本地代码实证（决定性证据）

### 2.1 PluginPlayer **本来就被设计成"可被外部 UI 驱动的引擎"** ✅

```
src/core/main.cpp:11   --hidden   不显示窗口（配合控制通道做无人值守控制）
src/core/main.cpp:190  else if (a == "--hidden") hidden = true;
src/core/main.cpp:303  app.init(winW, winH, hidden || listPlugins || selfTest || ..., !noAudio)
src/core/app.cpp:122-124  if (hidden) flags |= SDL_WINDOW_HIDDEN;
                          win_ = SDL_CreateWindow("PluginPlayer — 插件版播放器", winW, winH, flags);
```

这是对"内核化"最有利的证据：**官方已把"隐藏窗口 + 控制通道"作为既定的无人值守控制形态**。
即 PluginPlayer 不是"必须自带窗口的一体机"，而是可以被别的进程/UI 远程驱动的解码播放内核。

### 2.2 但画面**无法嵌入**外部窗口（今天的硬限制）⚠️

- 全仓 `src/` 检索 `CreateWindowFrom|SDL_HINT|foreign|HWND|parent|embed|set_hwnd` → **零命中**。
- 唯一建窗点是 `app.cpp:124` 的 `SDL_CreateWindow`，始终创建自己的顶层窗口。

→ 对比 daily_player 现在 `play.py:266` 用 VLC 的 `set_hwnd(int(self.video.winfo_id()))` 把画面塞进 tkinter frame。
**换内核后这一招没有了**，画面要么留在 PluginPlayer 自己的窗口（双窗口），要么得改 C++ 加嵌入（见 §4）。

### 2.3 控制通道能力面（`src/core/control.cpp` 全量 method）

`auth` `ping` `player.info` `player.stats` `player.play/pause/toggle/stop` `player.seek`
`player.volume` `player.mute` `player.speed` `player.open`
**`player.tracks`（L527-531）/ `player.select_track`（L533-541）**
`audio.devices` `audio.set_device` `command.invoke` `command.list`
`service.list` `plugin.list` `topic.subscribe` `app.quit`

要点与缺口：

| 能力 | 状态 | 说明 |
|---|---|---|
| 播放控制 / seek / 音量 / 倍速 | ✅ | `player.*` 齐备 |
| 多轨（含字幕轨） | ✅ | `listTracksJson()` 返回 `{video,audio,subtitle}`（L529），`selectTrack(type,index)` 可切 |
| 截图 | ⚠️ 间接 | 无专用 method，走 `command.invoke {name:'snapshot', args:[dir]}`（原生 snapshot 插件） |
| **全屏 / 窗口控制** | ❌ **缺口** | 全量 method 里没有任何 window/fullscreen 方法 |
| 播放列表 | ❌ 内核无 | `player.open` 一次一片；播放列表需 UI 侧自己维护 |

### 2.4 字幕：不但不丢，还多一条路 ✅（超出预期）

```
src/core/app.cpp:31-42    subtitle.load 命令：加载外部字幕文件并解析 cues
src/core/app.cpp:148-149  把字幕 ASS 事件经事件总线转发，"供 subtitles 插件用 libass 渲染"
src/core/app.cpp:943-953  内核不渲染（架构红线）；改发 "subtitle.line" 事件，载荷 {"text":"..."}
src/core/app.cpp:1550     自检项：验证 subtitle.line 事件 → subtitles 插件把字画到屏幕
```

含义：
1. 外挂字幕有了（`subtitle.load` 命令，可经 `command.invoke` 触发）；
2. 内嵌字幕轨有了（`player.tracks`/`select_track`）；
3. **外部 UI 可以直接订阅 `subtitle.line` 自己画字幕** —— 这与 daily_player 现在用 `parse_srt()` + tk Label 画字幕的做法几乎同构，迁移成本很低。

### 2.5 现成的替换缝：刚落地的 `PlayerEngine` 端口 ✅

Phase 2 已在三端落地 `PlayerEngine` 适配器（`daily_player/player_engine.py`、`localplayer/player_engine.js`、
`pluginplayer/host-js/player-engine.mjs`），且 `getState()` 统一返回 schema 里的 `PlayerState`。
**daily_player 换内核 = 把 UI 绑定的 `VlcPlayerEngine` 换成一个 `PluginPlayerRpcEngine`，端口不变、UI 不动。**
（后者目前只有 JS 版，需补一个 Python 版控制通道适配器 —— 工作量很小。）

---

## 3. 三个组件的联网核实

### 3.1 Codis — ❌ 完全无关
Redis 分布式集群代理（README L186 已定性）。本地单用户播放器没有任何 Redis/缓存/水平扩容诉求，**任何视角下都不相关**。

### 3.2 Cordis — ❌ 进不了浏览器扩展（硬约束，非"过度设计"）
- 官方定位：Koishi 作者 Shigma 的 TypeScript 插件元框架，MIT，核心约 2–3k 行。
- **运行要求：`Node.js ≥ 22`、ESM-only**；其热重载明确是"**Node 环境下**"的实现（备份→清空缓存→重导入）。
- MV3 扩展的 service worker / offscreen 文档**没有 Node 运行时**（无 `fs`/`net`/原生模块），且 CSP 禁止远程代码。

→ 所以 localplayer "采用 Cordis" 不是"值不值"，而是"跑不起来"。README 的结论方向对，但理由应升级为**运行时不兼容**。
→ 正确定位：**Cordis 留在 PluginPlayer 侧当统一插件层**（它已经在用了），另外两端是"被它驱动"，而不是"各自也装一套"。

### 3.3 MediaMTX — ❌ 本地文件场景仍属多余
- 定位："**媒体路由器**"，**不做转码（transcode），只做转封装（remux）**；转码必须外挂 FFmpeg（如 `runOnDemand` 钩子、`-ffmpeg` 镜像）。
- 形态是**发布/订阅服务器**：本地文件不能直接当源，得先 `ffmpeg -re -i file -f rtsp ...` 推进去。
- 现状（2026-08）：v1.20.x、约 19.9k stars、MIT、Go 单文件、跨平台。

→ 对本地静态媒体：要先 ffmpeg 推给 MediaMTX、再让浏览器拉 HLS —— 比"ffmpeg 直接出 HLS、Flask 静态托管"多一跳。
→ **唯一仍成立的触发条件**就是 README L193 自己写的那条：接入**直播源**（RTSP 摄像头 / RTMP / SRT / OBS）。
→ 补充：即便走到"一个内核喂多个消费端"的扇出场景，MediaMTX 也只是候选之一，且它可能**绕开 PluginPlayer**（直接 ffmpeg 出流），此时"PluginPlayer 是内核"这一前提就不成立了。

---

## 4. 「以 PluginPlayer 为内核」的三种集成形态（这才是三合一的真身）

| 端 | 能否承载内核 | 现实形态 | 代价 / 阻塞 |
|---|---|---|---|
| **PluginPlayer 自身** | 本身就是 | — | — |
| **daily_player**（Python 桌面） | ✅ 能（外部进程） | `pluginplayer.exe --rpc-port 7911` + Python 侧 RPC 适配器驱动 | 见 §4.1 |
| **localplayer**（MV3 浏览器） | ❌ **不能** | 浏览器装不下原生 FFmpeg；只能"接流" | 见 §4.2 |

### 4.1 daily_player 换内核：两个可选形态

- **形态 A：双窗口（零 C++ 改动，今天就能做）**
  tkinter 继续当控制面板（播放列表/进度/字幕/托盘/主题），画面留在 PluginPlayer 自己的 SDL 窗口。
  - 优点：不动 PluginPlayer 一行代码；`--hidden` 反而**不能**用（要用画面）。
  - 缺点：不再单窗口；全屏要全屏 PluginPlayer 的窗口，而 RPC **没有全屏方法**（§2.3 缺口，需新增 `app.fullscreen` 或用原生插件命令兜）。

- **形态 B：嵌入（需改 C++，单窗口）**
  给 PluginPlayer 加 `--embed <hwnd>`，把 `app.cpp:124` 的 `SDL_CreateWindow` 换成
  `SDL_CreateWindowFrom`（Windows 传 HWND；SDL3 新版用 `win32.hwnd` 属性）。
  - 技术上可行：SDL 官方支持从既有原生窗口创建 SDL 窗口。
  - 风险（官方提示）："SDL 的渲染与输入系统在非 SDL 窗口上**可能不完全工作**"；且 PluginPlayer 的 OSD/渲染需实测。
  - 成本：小改动 + 重编（MinGW）+ 实测验证。

### 4.2 localplayer：三合一论点里最弱的一环

浏览器端既不能加载原生库，也不能跑 Node（§3.2）。要让 PluginPlayer 成为它的内核，只有一条路：
**PluginPlayer 学会"发布流"**（它现在只会播，不会发），localplayer 再以 HLS（已有 hls.js）或 WebRTC（v1.3.0 已有接收端 `/remote`）消费。

代价清单：
1. PluginPlayer 需要新增"推流输出"能力 —— 这是**从播放器变成服务器**的产品级改动；
2. localplayer 将从"随扩展打包、完全离线可用"（README 模式 A）变成**必须常驻一个本地守护进程**；
3. 多一跳编码/封装 = 延迟与 CPU 成本；
4. 若只是为了让浏览器放 mkv/flac，直接用 ffmpeg 转码出 HLS 更短，且**不需要 PluginPlayer**——此时"内核是 PluginPlayer"名不副实。

---

## 5. 风险清单（换内核前必须知道）

| 风险 | 说明 |
|---|---|
| **分发变重** | 现状 `pip install python-vlc` + 装 VLC；换成 PluginPlayer 需 MinGW 构建 + FFmpeg/SDL3 vendor。对终端用户，VLC 反而更省事（除非发布预编译 exe）。 |
| **可能被拖成 Windows-only** | PluginPlayer 当前构建脚本面向 MinGW/Windows；daily_player 是 Python+tkinter 本可跨平台。 |
| **IPC 脆弱性** | 外部进程 + 令牌 + 端口 + 崩溃/僵尸进程，比进程内 VLC 多一整类故障面。 |
| **逐帧能力无法远程驱动** | 控制通道请求在主线程**每帧开头**抽干一次（`app.cpp:1058`），**S1 实测 p50 = 16.65ms ≈ 1 帧 @60fps**（见 §8.2）。UI 控制够用（≤60 次/秒），逐帧特效/OSD 不行。 |
| **功能缺口** | 全屏无 RPC 方法；截图要绕 `command.invoke`；播放列表要 UI 侧自建。 |
| **截图受写入白名单限制**（S1 新发现） | `Host::isWriteAllowed`（`host.cpp:539`）默认只放行 **exeDir**；要截图到别处，启动播放器**必须**加 `--write-dir <DIR>`，否则静默失败。 |
| **`--rpc-token` 有长度下限**（S1 踩坑） | 少于 16 字符 → 启动即 `exit 2`（`main.cpp:249`）。 |
| **子进程 stdout 不能用 PIPE**（S1 踩坑） | 启动日志远超 4KB，PIPE 无人读 → 播放器阻塞在插件加载中途，表现为"控制通道永远起不来"。**必须重定向到文件**。 |
| **VLC 的隐性能力** | VLC 的网络流、DVD、均衡器、libass 字幕渲染等是多年积累；FFmpeg 覆盖面广不等于等价替换，需按实际媒体样本实测。 |

---

## 6. 建议的推进顺序（低风险、可验证）

| 步骤 | 动作 | 状态 / 验证 |
|---|---|---|
| **S0** | 补 `daily_player/player_engine_rpc.py`：Python 版控制通道 `PlayerEngine` 适配器（对齐现有 JS 版） | ✅ **已完成**（v0.4.0）。协议级测试：真 TCP 假控制通道，覆盖 auth/换算/夹取/事件帧干扰/错令牌 |
| **S1** | 形态 A 尖峰：起 `pluginplayer.exe --hidden --rpc-port`，用最小 tkinter 面板驱动播放 | ✅ **已完成**（v0.5.0）。**13 项断言全绿**，实测数据见 §8；另附无 GUI 回归 14 项 |
| **S2** | 若必须单窗口：给 PluginPlayer 加 `--embed <hwnd>`（`SDL_CreateWindowFrom`） | ⏸ 未启动。**仅在"必须单窗口"时才需要**——S1 证明双窗口形态已可用，故降级为可选 |
| **S3** | 补齐 RPC 缺口：`app.fullscreen`（或原生插件命令兜底） | ⏸ 未启动。唯一影响：daily_player 的全屏按钮对 PluginPlayer 内核无效（本地跟踪，不报错） |
| **搁置** | localplayer 引入 Cordis / MediaMTX | 运行时不兼容 / 场景不匹配；若将来接直播源再按 README L193 触发 |

---

## 7. 需要修正的既有文档表述（若采纳）

- ✅ **已修**（v0.5.0）`localplayer/README.md:187` Cordis 一条：理由已从"当前规模不需要完整插件市场"
  升级为 **"MV3 扩展无 Node 运行时，而 Cordis 要求 Node ≥ 22，运行时不兼容"**，
  并补充"Cordis 归 PluginPlayer，不归浏览器端"。
- ✅ **已修** `ARCHITECTURE.md` §7 Phase 4：已更新为"已评估 + S0/S1 完成"。

---

## 8. S1 实测结果（2026-09-15，全部通过）

复现方式（无人值守，不弹窗）：

```bash
F:/Python314/python.exe daily_player/spike_s1.py
```

脚本会自己拉起 `pluginplayer.exe --hidden --no-audio --rpc-port <随机> --rpc-token <随机> --write-dir <out>`，
跑完 7 组测量后 `app.quit` 收进程，并把结构化结果写到 `docs/s1-spike-report.json`。
**退出码 0 = 全绿**；实际耗时 9.68s。

### 8.1 连接与握手

| 项 | 结果 |
|---|---|
| auth + ping | ✅ `abi=3`，`app=pluginplayer` |
| 插件加载 | 11 个全部 loaded（含 `subtitles` / `snapshot` / `track_selector`） |

### 8.2 RPC 往返延迟（各 30 次采样，本地回环）

| method | min | avg | p50 | p95 | max |
|---|---|---|---|---|---|
| `ping` | 16.528ms | **16.666ms** | **16.653ms** | 16.825ms | 16.832ms |
| `player.stats` | 16.398ms | **16.695ms** | **16.674ms** | 17.004ms | 17.544ms |

**判读**：p50 ≈ **16.65ms ≈ 1 帧 @60fps**，且方差极小（max-min < 1.2ms）。
这不是网络抖动，而是**架构使然**——控制通道请求在主线程**每帧开头**抽干一次
（`app.cpp:1058` 注释明写"必须在每帧开头把队列抽干，否则 RPC 客户端会等到超时"）。

含义：
- ✅ 对 **UI 控制**（播放/暂停/seek/音量/倍速）完全够用，人手点击感知不到 16ms。
- ✅ 对 **进度轮询**够用，但要按 ≥100ms 节流（5~10Hz 即可，别每帧问）。
- ❌ 对 **逐帧驱动**（每帧一次 RPC 做特效/OSD）不行：上限就被锁在 60 次/秒，
  且会把主线程请求队列顶满。这类能力必须留在**插件内**（进程内），不能走 RPC。

### 8.3 打开媒体与进度推进

| 项 | 结果 |
|---|---|
| `player.open` | ✅ 1280x720 h264 / aac，8.0s，30fps，2.87Mbps |
| 进度推进 | ✅ 采样 `[0.416, 0.800, 1.166, 1.566, 1.933, 2.316]` 单调前进 |

### 8.4 控制类往返

| 动作 | 结果 |
|---|---|
| `seek(1000ms)` | ✅ 实际落在 `1.200s`（seek 到关键帧 + 采样延迟，符合预期） |
| `setRate(1.5)` | ✅ `speed=1.5` 读回一致 |
| `setVolume(42)` | ✅ 本地跟踪 `volume=42`（控制通道无 getter，S0 已约定） |
| `setMuted(True)` | ✅ 本地跟踪 `muted=True` |

### 8.5 字幕链路 `subtitle.line` ✅

订阅 `subtitle.line` → `command.invoke {name:'subtitle.load', args:[<srt>]}` →
播放 4 秒内收到 **1 帧非空事件**，文本 = `SUBTITLE 字幕测试 你好世界`。

**1 帧是正确结果，不是丢事件**：内核只在文本**变化时**广播
（`app.cpp:948` `if (line != lastSubLine_)`）。测试用的 srt 全程只有一行，
所以从头到尾就该只有 1 次"变化"。换多行字幕会按行切换各来一次。

结论：**外部 UI 可以自己画字幕**，这是比"只能靠内核 OSD 渲染"更好的形态。

### 8.6 截图链路 ✅（含写入白名单验证）

`command.invoke {name:'snapshot', args:[<out>]}` → 落盘 `snapshot_0003.png`，**3,687,468 B**。

这里验证了 §5 新记的那条风险：截图目录**必须**在写入白名单内。
启动时传了 `--write-dir <out>` 才写成功；不传则目标在 exeDir 之外时会被
`Host::isWriteAllowed`（`host.cpp:539`）静默拒掉。

### 8.7 端口契约

`getState()` 返回
`{'playing': True, 'timeMs': 6201, 'durationMs': 8000, 'rate': 1.0, 'volume': 42, 'muted': True, 'fullscreen': False}`，
**符合** `schema/media-item.schema.json` 的 `definitions.PlayerState`。

→ 即：**VlcPlayerEngine 与 PluginPlayerRpcEngine 产出同一个 PlayerState**，
上层 UI 换适配器即可，这验证了 Phase 2 建端口的价值。

### 8.8 S1 踩到的三个坑（已写进代码注释 / 本文档）

1. **子进程 stdout 不能用 PIPE**：启动日志 >4KB，PIPE 无人读 → 播放器阻塞在"插件 #2"，
   控制通道永远起不来（表现为"端口超时"）。必须重定向到**文件**。
2. **`--rpc-token` 至少要 16 字符**（`main.cpp:249`），短了直接 `exit 2`。
3. **冷启动要留足等待**：11 个插件 + 1.6MB 字体，实测可达 10s 以上；等端口的 deadline 给 15s 会误判。

### 8.9 形态 A 面板

`daily_player/spike_panel.py`：
- **控制逻辑与 tkinter 分离**（`PanelController` 不 import tkinter）→ 可在无 GUI 环境回归，
  `tests/test_spike_panel.py` **14 项断言全绿**。
- 面板 5Hz 轮询（200ms），与 §8.2 的延迟结论匹配。
- 自带 `--no-gui` 冒烟模式，已对真实播放器跑通（`exit 0`）。

---

## 9. S1 之后的判断

| 问题 | 结论 |
|---|---|
| 内核替换可行吗？ | ✅ **可行且已跑通**，不是纸面结论 |
| 需要立刻做 S2（单窗口嵌入）吗？ | ⏸ **不必**。双窗口形态功能完整；S2 只在"必须单窗口"时才值得动 C++ 重编译 |
| daily_player 现在就可以默认切到 PluginPlayer 吗？ | ⚠️ **还早**。缺 `app.fullscreen`、播放列表需 UI 侧自建、分发要带预编译 exe；建议先保持双内核可切换 |
| localplayer 端？ | ⏸ 维持搁置 |

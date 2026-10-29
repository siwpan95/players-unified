# players-unified

## 仓库角色定位（投资组合分级 ②）

> 本仓在 siwpan 投资组合（D:/projects/repos，共 133 仓）中定级为 **② 保留**，领域 **播放器**。
> **角色**：播放器归口。
> **维护策略**：② 旗舰 / 枢纽仓库打磨保留，作为能力展示或收敛点；② 保留类仓库低优先维持、不主动扩张。
> 投资组合统一分级索引（多机可查）：[组合分级决策索引 · allin 事实源](https://gitee.com/siwpan/allin/blob/master/docs/事实源/组合分级决策索引.md)。

> 版本 **0.8.0** · Phase 1–3 已完成；Phase 4 的 S0/S1/S3/S4 已实测通过；Phase 5 的 S5-1/S5-2/S5-3 已落地

本地三个播放器方向的**整合仓库**：三端源码已作为子目录并入本仓库根目录，统一承载、统一版本管理（不再跨仓库引用）。

## 三端（本仓库子目录）

| 项目 | 路径 | 方向 | 技术栈 |
|---|---|---|---|
| daily_player | [`daily_player/`](daily_player/) | 桌面视频播放器（本地） | Python 3.14 + tkinter；**默认内核 PluginPlayer**（可选 libVLC），PyInstaller 打包 exe |
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

## 统一 Cordis 宿主（Phase 5 / S5）

`host/`（Node + Cordis，形态参考 deepseek harness）：把「三端各自的后端面」收成**一棵可插拔插件树**，
配置是分层的（基座 → bundle → profile → patch），`--dump-config` 打印**实际启动后**的树而不是配了什么。

```bat
cd host
node src/cli.mjs --profile desktop --check           :: 门禁：启用的条目必须都装载成功
node src/cli.mjs --profile desktop --dump-config     :: 实际启动后的插件树 + 每项来自哪一层
node src/cli.mjs --profile desktop --aggregate       :: 聚合三端媒体（与 launcher 同形）
node tests/run-all.mjs                               :: 全套验收：5 个文件 / 116 项
```

`--profile desktop` 启动后，宿主就是 `localplayer` 那个 Flask 后端的**替代品**（同一端口 5000，
**扩展端零改动**）：

| 路径 | 内容 | 验收 |
|---|---|---|
| `GET /api/list` | 媒体清单 `MediaItem[]`，与 python `media_lib` **逐字段 + 键顺序**一致 | 27/27 → `docs/s5-library-face-report.json` |
| `GET /media/<file>` | 媒体文件（比 python 侧多支持单段 Range，`<video>` 可拖动） | 同上 |
| `GET /remote` | 网页投送观看页（专用 CSP） | 16/16 → `docs/s5-remote-parity.json` |
| `WS /ws` | WebRTC 信令中继 —— **零依赖手写 RFC6455**（`host/lib/ws.mjs`） | 36/36 → `docs/s5-ws-rfc6455-report.json` |

两条最硬的证据：`ctx.media.aggregate()` 与 `launcher.aggregate()` 在真实 fixture 上**逐项一致**
（10/10，`docs/s5-host-parity.json`）；`/ws` 信令状态机与 python `server.py` **跨语言 A/B 对拍逐条一致**
（16/16）。宿主**不做**跨语言源码合并、不做解码、不统一 UI。

> **对拍当场抓出一个真 bug**：`localplayer/server.py` 的 `ws_signaling()` 里 `_last_meta = msg` 让该名字
> 变成函数局部变量，于是前面那句 `if _last_meta is not None:` 必然抛 `UnboundLocalError` ——
> **任何接收端一声明角色，`/ws` 就 500 断连**，网页投送从接收端根本用不了。已修（`global _last_meta`）。

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 整合架构：目录布局 + 领域模型 + 端口契约 + 各宿主适配器映射（含 `host/`）+ 共享 UX 契约 + 路线图。
- [host/README.md](host/README.md) — 统一宿主的用法、分层合成语义、目录、**14 条实测踩坑**、验收证据。
- [docs/phase4-kernel-assessment.md](docs/phase4-kernel-assessment.md) — 「以 PluginPlayer 为内核」可行性评估 + **实测数据**（§8 S1 / §10 S3 / §11 S4 / §12 S5）。
- [docs/s1-spike-report.json](docs/s1-spike-report.json) — S1 尖峰的结构化实测报告（由 `spike_s1.py` 生成）。
- [docs/kernel-e2e-report.json](docs/kernel-e2e-report.json) — S4 内核门面的端到端报告（由 `e2e_kernel.py` 生成）。
- [docs/s5-host-parity.json](docs/s5-host-parity.json) · [docs/s5-library-face-report.json](docs/s5-library-face-report.json) · [docs/s5-ws-rfc6455-report.json](docs/s5-ws-rfc6455-report.json) · [docs/s5-remote-parity.json](docs/s5-remote-parity.json) — S5 三段的验收报告（由 `host/tests/*.mjs` 生成）。

## 内核替换（Phase 4）

daily_player **默认内核已是 PluginPlayer**（`daily_player/kernel.py` 收拢内核选择 + 进程托管 +
能力门面），`--kernel=vlc|auto` 可切换，只有 `auto` 才允许回落。

```bat
:: 门面层端到端（需要真实 pluginplayer.exe + 媒体；缺条件则跳过）→ docs/kernel-e2e-report.json
/Python314/python.exe daily_player/e2e_kernel.py

:: 门面单测（零三方依赖，不需要 exe，44 项）
/Python314/python.exe daily_player/tests/test_kernel.py

:: S1 尖峰：无人值守实测控制通道协议，退出码 0 = 全绿
/Python314/python.exe daily_player/spike_s1.py
/Python314/python.exe daily_player/spike_panel.py       :: 形态 A tkinter 面板
/Python314/python.exe daily_player/spike_panel.py --no-gui --seconds 3
```

`spike_s1.py` 会自己拉起 `pluginplayer.exe --hidden`（不弹窗）跑 8 组测量后收进程。
实测结论：RPC 往返 p50 ≈ **16.65ms**（≈1 帧 @60fps，UI 控制够用、逐帧驱动不行）；
字幕 `subtitle.line` / 截图 / 进度 / `PlayerState` 契约**全部打通**。
`e2e_kernel.py` 则验证门面层：默认命中 PluginPlayer、真实时长与进度、端口往返一致、
截图中转、退出无残留进程（实测 **23/23**）。

## 状态

✅ **已整合（物理合并）** · ✅ **Phase 1 已完成**。三端源码已复制进本仓库子目录；`MediaItem` 跨端共享契约已落地（`schema/media-item.schema.json`），localplayer / daily_player / PluginPlayer 三端均产出 `MediaItem[]`（PluginPlayer 通过 Cordis 插件 `media-library` 扫描目录 + HTTP `/api/library` 接口）。三端均含 `MediaItem` schema 断言测试（`daily_player/tests`、`localplayer/tests`、`pluginplayer/host-js/plugins/lib`），零三方依赖、直跑真实代码路径。Phase 2 的 `PlayerEngine` 适配器亦已三端落地（`daily_player/player_engine.py`、`localplayer/player_engine.js`、`pluginplayer/host-js/player-engine.mjs`），并各含 `PlayerState` schema 断言测试。Phase 4 的 **S0 + S1 + S3 + S4 已落地并实测通过**：`daily_player/player_engine_rpc.py`（同一 `PlayerEngine` 端口的 PluginPlayer 控制通道适配器）+ `daily_player/kernel.py`（**默认内核切到 PluginPlayer**：内核选择 / 进程托管 / 能力门面，`play.py` 已无 libVLC 专有调用）+ `daily_player/spike_s1.py`（真实播放器尖峰，**18 项断言全绿**，含 S3 全屏 6 项）+ `daily_player/e2e_kernel.py`（门面层端到端 **23/23**）+ `daily_player/spike_panel.py`（形态 A 面板，控制器可无 GUI 回归 14 项）。实测：RPC p50 ≈ 16.65ms、字幕/截图/进度/契约全通，两适配器产出同一个 `PlayerState`；S3 新增控制通道 `app.fullscreen`（真实切换 + 事件广播，`--hidden` 下明确失败），官方 `tools/rpc_client.py` **24/24**；S4 门面单测 44 项 + 真机 E2E 23 项 + GUI 冒烟全过，过程中修掉「事件订阅缺失」「截图同名覆盖」两个真问题。可行性评估见 [docs/phase4-kernel-assessment.md](docs/phase4-kernel-assessment.md)。**Phase 5（统一 Cordis 宿主）的 S5-1/S5-2/S5-3 已落地并实测通过**：`host/` 用 Cordis 把「枚举聚合 + 深链分发 + localplayer 的后端面」收成一棵可插拔插件树（Profile → Bundle → Patch 分层合成 + `--dump-config`）；列表面与 python `media_lib` 逐字段一致（27/27）、聚合与 `launcher` 逐项一致（10/10）、**零依赖手写 RFC6455** 帧级验收 36/36、信令中继与 python `server.py` **跨语言 A/B 对拍逐条一致**（16/16），全程 **116 项断言全绿**（`node host/tests/run-all.mjs`）。对拍过程中**抓出并修掉 `server.py` 一个必崩 bug**（`_last_meta` 局部变量语义 → 任何接收端一连接 `/ws` 就 500）。详见 [ARCHITECTURE.md](ARCHITECTURE.md) §4/§7 与 [host/README.md](host/README.md)。

> 说明：三端语言/宿主不同（Python / JS / C++），整合方式是**物理整合（子目录共存）**而非跨语言源码合并；统一层只共享 schema/契约，各端仍按各自技术栈独立演进。新增的 `host/` 是**编排层**（Node），它消费各端的实现而不替换它们 —— 唯一的例外是 localplayer 的 Flask 后端面（已被宿主同端口覆盖，扩展端零改动），`server.py` 相应降级为「无 Node 时的退路」。

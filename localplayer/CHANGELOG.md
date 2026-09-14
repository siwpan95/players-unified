# Changelog

所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **提交前自检**：运行 `python check_version.py` 校验 `manifest.json` 的 `version` 与本文档最新 `## [x.y.z]` 一致（已配 git pre-commit 钩子，不一致将阻止提交）。

## [1.3.4] - 2026-09-14

### 修复
- **网页投送状态滞后**：后端 `server.py` 停止后，信令 WebSocket 断开但 popup 仍显示「投送中」。现 offscreen 在直连 `onclose` 与 background 中转 `onclose` 时检测并清理投送状态，popup 同步复位开关与按钮，不再需要手动关停。
- **后端根路径 404**：`server.py` 新增 `/` 落地页（列出 `/api/list`、`/remote`、`/ws` 用途）与 `/favicon.ico`（返回 204），消除浏览器打开根地址与 favicon 请求的 404 噪音。

## [1.3.3] - 2026-09-14

### 修复 / 变更
- **修复 `server.py` 启动崩溃**：`requirements.txt` 显式约束 `Werkzeug>=3.1`。此前仅约束 `Flask>=3.0`，在 Werkzeug 过旧（如 0.16.0）的环境中 Flask 3.x 用到 `LocalProxy(unbound_message=...)` 会直接崩溃；重装依赖（`pip install -r requirements.txt`）即可启动。
- **移除侧边栏播放器**：实测 Chrome / Edge 下侧边栏均无法打开，且「独立全页播放器」（`player.html`）已满足常驻界面需求，故移除 `side_panel` 声明、`background.js` 的「打开侧边栏播放器」右键菜单，并删除 `sidepanel.html`。

## [1.3.2] - 2026-09-14

### 改进（投送可用性补全）
- 接收端 `/remote` 页显示当前曲目信息（标题 — 艺术家，由发送端经信令 `meta` 下发；晚加入的接收端也可从 server.py 缓存补到），并在发送端断开时提示「发送端已断开」。
- 发送端 ↔ 接收端连通状态回传：server.py 在接收端上下线时经 `viewer-count` 通知发送端，popup 据此显示「📡 投送中 · N 个接收端 / 等待接收端连接」；投送开始/停止亦同步状态到 popup。
- 信令层增强：`server.py` 新增 `_notify_sender` 与 `_last_meta` 缓存（曲目元数据补发），发送端断开时主动通知接收端。

### 修复
- 媒体源收集静默降级：后端（`server.py`）未启动/不可达时，「远端后端」插件不再刷 `console.warn`（此前每次加载都会报「后端清单为空或未配置」）；仅真实错误（如 `chrome.runtime.lastError`、HTTP 5xx）才告警，并自动回落「本地打包」源。

## [1.3.1] - 2026-09-14

### 改进（网页投送健壮性）
- WebRTC 信令「直连优先 + background 中转兜底」：offscreen 先直连 `ws://127.0.0.1:5000/ws`，2.5s 超时或报错则回落经 `chrome.runtime` → background 持有的中转 WS（绕开 offscreen 直连本地 WS 可能被 `host_permissions`/扩展限制拦截的未知风险）。background.js 新增 `ensureCastRelay` 与 `castRelay` 消息分支；offscreen.js 信令收发统一走 `signalingSend`/`handleSignalingMessage`，新增 `castRelayIn` 接收分支。
- popup 投送开关开启前先做后端可达性校验（fetch `http://127.0.0.1:5000/api/list`，1.5s 超时），不可达则弹窗提示先执行 `python server.py`，避免静默挂起。
- 投送按钮可用性 UX：后端不可达时 `castBtn` 自动置灰（CSS `.extra-btn:disabled`）+ hover 提示「需要 server.py」；每 5s 复查，后端就绪后自动恢复可用。`manifest.json` 版本号补登为 1.3.1（此前 chrome://extensions 仍显示 1.2.7）。

## [1.3.0] - 2026-09-14

### 新增 / 完善（持久化界面 + 网页投送）
- **常驻界面（修复「切标签页自行回退」）**：新增 `sidepanel.html`（侧边栏，窗口锚定、切标签不关）与 `player.html`（全页独立应用，对应 GitHub/DSH 的「独立插件应用」），两者并存且复用 `popup.js` 播放逻辑与 `app-layout.css` 布局。`manifest.json` 增加 `side_panel` 声明与 `contextMenus` 权限；右键扩展图标可「打开侧边栏播放器 / 打开独立播放器页面」。
- **网页投送（WebRTC）**：offscreen 升级为音视频统一主运行时（新增隐藏 `<video id="bgVideo">`），可经 WebRTC 把当前播放投送到外部网页。扩展界面新增「🔊 网页投送」开关，开启后 offscreen 加载并串流当前媒体、本地界面静音避免双声；`server.py` 增加 `/ws` 信令中继与 `/remote` 观看页（新增 `flask-sock` 依赖）。

### 已知限制
- 同时打开多个扩展界面（popup/侧栏/全页）时，各自会独立解码播放（视频可能多份解码；音频由 offscreen 主运行时统一，界面本地静音）。
- WebRTC 投送需先启动 `server.py`（默认 `127.0.0.1:5000`）；offscreen 直连 `ws://127.0.0.1:5000/ws` 依赖 `host_permissions`，需在浏览器中实测。
- 网页投送与本地界面同机时，外部 `/remote` 页会再播放一份音频（典型投送语义：投到异机/另一设备），同机请静音 `/remote` 页。

## [1.2.7] - 2026-09-14

### 新增 / 完善
- 完善后台音频进度落盘：offscreen 直接将播放进度写入 `chrome.storage.local` 的 `lp_progress`（与 popup 内播放共用同一缓存键），重开扩展后再次播放同一文件自动恢复；续播时回传已记忆进度；重开 popup 若后台仍在播则接管状态而非重复加载本地媒体。
- README 新增「播放交互增强（C 类）」章节（投屏 / Chromecast 评估为暂不实现），并将 B 类「已知限制」更新为进度已落盘。

## [1.2.6] - 2026-09-14

### 新增
- B 类播放交互增强（原生能力，无新依赖）：
  - 后台音频续播：新增 offscreen.html / offscreen.js + manifest `offscreen` 权限，关闭 popup 后音乐继续；popup 显示后台状态面板，媒体键经 service worker 转发控制；不支持时回退 popup 内播放。
  - 字幕 / 多语言：媒体项支持 `tracks`，视频渲染为多个 `<track>`（WebVTT），后端与本地清单均可透传。
  - 搜索与排序：播放列表支持按名称搜索、按名称/类型排序。
- popup.html / popup.css 增加搜索框、排序下拉与后台音频状态面板样式。

## [1.2.5] - 2026-09-14

### 新增
- 播放交互增强（A 类，均为原生 Web 能力，无新依赖）：
  - 媒体会话 Media Session API：锁屏元数据 + 硬件媒体键（播放/暂停/上下曲/快进快退跳转）；
  - 画中画（Picture-in-Picture）按钮（仅视频模式）；
  - 键盘快捷键：空格/k 播放暂停，←/→ 快退快进 5 秒，↑/↓ 音量，n/p 上下曲；
  - 进度记忆（chrome.storage.local）：按路径记录进度，重开自动恢复。
- popup.html / popup.css 增加画中画控件与样式。

## [1.2.4] - 2026-09-14

### 新增
- 最小自定义插件接口（plugins/plugin-api.js，约 40 行，无外部框架）：媒体源以插件注册，按优先级 fallback 链取数；内置「远端后端 / 本地打包」两个源，loadMedia 改为走插件收集。示例插件见 plugins/sample-source.js。
- README 补充「插件式媒体源」用法与「Codis / Cordis 架构选型笔记」。

## [1.2.3] - 2026-09-14

### 新增
- 接入 hls.js（本地打包于 `lib/hls.min.js`，Apache-2.0）实现 `.m3u8` / HLS 播放；`popup.js` 检测到 HLS 源时自动接管，Safari / iOS 走原生 HLS。
- 修正 manifest 版本号（v1.2.2 漏改，停留在 `1.2.1`）。

## [1.2.2] - 2026-09-14

### 修复
- 修正本地媒体列表写死四个示例文件名（`LOCAL_MEDIA`）导致用户自行放入的媒体不显示的问题。
  改为由 `media/manifest.json` 动态列出实际文件，并提供 `gen_media_manifest.py` / `.bat`
  扫描 `media/` 生成清单；放入新文件后重新运行脚本并刷新扩展即可列出。

## [1.2.1] - 2026-09-14

### 新增
- 选项页「测试连接」按钮：直接探测当前输入框地址的 `/api/list`，
  成功显示返回的媒体数量，失败显示错误原因，保存前即可确认后端可达。

## [1.2.0] - 2026-09-14

### 新增
- 扩展选项页 `options.html` / `options.css` / `options.js`（`manifest.json` 加 `options_page`）。
- 可视化配置后端地址，存储于 `chrome.storage.sync.backendUrl`；
  `background.js` 每次拉清单时实时读取，保存即对新 popup 生效。

## [1.1.0] - 2026-09-14

### 新增
- 混合媒体模式：background service worker（`background.js`）从后端拉取 `/api/list` 清单，
  并与随扩展打包的 `web_accessible_resources` 媒体并存。
- `manifest.json` 加入 `background`、`web_accessible_resources`、`storage` 与 `host_permissions`。
- `popup.js` 改为 `loadMedia()`：远端清单优先，本地打包兜底。
- 配套 Flask 示例后端 `server.py`（`/api/list` + `/media/<file>`）。

## [1.0.0] - 2026-09-14

### 初始版本
- 将单文件 HTML 播放器拆分为 Chrome / Edge 通用扩展（Manifest V3）：
  `manifest.json` + `popup.html` + `popup.css` + `popup.js`。
- 支持视频 / 音频混排播放列表、自动下一曲、音视频模式自动切换。
- 工程文件：`.gitignore`、`LICENSE`（MIT）、`requirements.txt`、`README.md`。



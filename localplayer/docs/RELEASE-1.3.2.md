# 发版说明 · v1.3.2

- 发布日期：2026-09-14
- 分支模型：`feature/cast-availability` → `develop` → `release/1.3.2` →（合并入 `master` + `develop`）
- 标签：`v1.3.2`（打在 `master` `c5c3d44`）
- 相对 `v1.3.1` 的变更：投送可用性补全 + 媒体源静默降级（修复 warn 噪音）

## 一句话摘要

投送可用性补全（接收端曲目信息 / 连接状态 + 发送端接收端计数回传），并修复「后端未启动时媒体源收集刷 `console.warn`」的噪音问题。

## 包含的变更

### 新增 / 改进
- 接收端 `/remote` 页显示当前曲目信息（标题 — 艺术家，由发送端经信令 `meta` 下发；晚加入的接收端也可从 `server.py` 缓存补到），发送端断开时提示「发送端已断开」。
- 发送端 ↔ 接收端连通状态回传：`server.py` 在接收端上下线时经 `viewer-count` 通知发送端，popup 据此显示「📡 投送中 · N 个接收端 / 等待接收端连接」；投送开始 / 停止亦同步状态到 popup。
- 信令层增强：`server.py` 新增 `_notify_sender` 与 `_last_meta` 缓存（曲目元数据补发），发送端断开时主动通知接收端。

### 修复
- 媒体源收集静默降级：后端（`server.py`）未启动 / 不可达时，「远端后端」插件不再刷 `console.warn`（此前每次加载都会报「后端清单为空或未配置」）；仅真实错误（如 `chrome.runtime.lastError`、HTTP 5xx）才告警，并自动回落「本地打包」源。
  - 实现：`background.js` 的 `fetchMediaList` 返回 `{ ok:true, files }` 或 `{ ok:false, unreachable:true }`；`popup.js` 远端后端插件在未启动时抛 `LP_SILENT:` 哨兵错误；`plugins/plugin-api.js` 的 `collectMedia` 抑制 `LP_SILENT:` 前缀日志。

## 升级方式
1. 拉取 `master` 或检出 `v1.3.2` 标签对应代码，按 README「加载方式」重新加载已解压的扩展。
2. 如需网页投送，先 `python server.py` 启动后端，再在界面开启「🔊 网页投送」。

## 已知遗留
- 同机 `/remote` 与扩展共用一份音频解码，可能出现双音频（界面本地已静音，但接收端为独立网页，仍需在真实环境实测确认）。
- 多扩展界面（popup / 侧栏 / 全页）同时打开时各自独立解码。
- 网页投送依赖本地 WebSocket / WebRTC，需先在浏览器中实测直连与 background 中转两条路径。

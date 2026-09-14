# 本地验证步骤（Local Testing）

扩展类改动无法用命令行跑测试，需加载到浏览器开发者模式手动验证。本文记录核心能力的本地验证清单。

> 注：`node --check` 仅能校验纯 JS 语法，不能替代浏览器内手动验证。

## 0. 前置

- Chrome / Edge（同一套 MV3 规范，通用，无需改动）。
- Python 3（用于可选后端 `server.py`）。安装依赖：
  ```bash
  pip install -r requirements.txt
  ```
  含 Flask、`flask-sock`（提供 `/ws` 信令与 `/remote` 观看页）。

## 1. 加载扩展

1. 打开 `chrome://extensions`（Edge：`edge://extensions`）。
2. 右上角开启「开发者模式」。
3. 「加载已解压的扩展程序」→ 选择本目录 `localplayer`。
4. 点击工具栏图标，弹出播放器。

## 2. 准备本地媒体（可选）

- 把媒体文件放进 `media/`，运行 `gen_media_manifest.py`（或 `gen_media_manifest.bat`）生成 `media/manifest.json`；
  刷新扩展后 popup 才会列出这些文件。
- 不准备也可：起后端后走「远端后端」源。

## 3. 验证播放

- popup 内点击任意媒体即可播放；测试：播放/暂停、上一曲/下一曲、画中画、硬件媒体键、搜索/排序。
- 刷新扩展后进度应恢复到上次位置（`chrome.storage.local` 的 `lp_progress`）。
- 切到独立页（右键图标 → 打开独立播放器页面），确认**切标签页不丢播放**（常驻界面能力）。

## 4. 启动可选后端（投送 / 远端源需要）

```bash
python server.py
```

默认监听 `http://127.0.0.1:5000`，提供：

- `GET /api/list`：媒体清单（供「远端后端」源）
- `GET /media/<file>`：媒体文件
- `WS  /ws`：WebRTC 信令中继
- `GET /remote`：接收端观看页

后端地址可在选项页配置（默认即此），「测试连接」可先探测可达性。

## 5. 验证「远端后端」媒体源 + 静默降级

- 后端**已启动**：popup 优先用远端清单（priority 10）。
- 后端**未启动**：自动回落「本地打包」源。
- 校验 v1.3.2 修复：后端未启动时打开 popup，**控制台不应再出现**
  `插件「远端后端」获取失败… 后端清单为空或未配置` 这类 `console.warn`
  （已改为静默回落，仅真实错误如 `chrome.runtime.lastError`、HTTP 5xx 才告警）。

## 6. 验证网页投送（WebRTC）

1. 扩展界面点「🔊 网页投送」开关（后端不可达时按钮置灰，提示先起 `server.py`）。
2. 另开标签页 / 同网另一设备浏览器，访问 `http://127.0.0.1:5000/remote`。
3. 发送端 popup 应显示「📡 投送中 · N 个接收端 / 等待接收端连接」；
   接收端 `/remote` 显示当前曲目信息（标题 — 艺术家）与连接状态；
   关闭接收端标签页，发送端计数应实时回退。
4. 接收端应能看到 / 听到实时串流（发送端本地静音，避免双声）。

### 信令路径（两条，自动兜底）

- **直连优先**：offscreen 直接连 `ws://127.0.0.1:5000/ws`，约 2.5s 超时或报错则回落。
- **background 中转兜底**：直连失败时，经 `chrome.runtime` → `background.js` 持有的中转 WebSocket 与 server 通信。
- 观察方式：在扩展 offscreen 文档 / 后台页的 DevTools 控制台查看信令日志；
  可临时阻断直连（如调整 `host_permissions` 或停掉直连路径）强制走中转，确认仍能投送。

## 7. 发版自检

- 改 `manifest.json` 的 `version` 后**必须**同步 `CHANGELOG.md` 顶部版本号。
- 提交前启用钩子（本仓库）：
  ```bash
  git config core.hooksPath hooks
  ```
  提交时会跑 `check_version.py` 校验 `manifest` 与 `CHANGELOG` 一致，不一致将阻止提交。

## 已知遗留（验证时留意）

- 同机 `/remote` 与扩展可能共用一份音频解码，出现双音频（界面本地已静音，接收端为独立网页，仍需实测确认）。
- 多界面（popup / 侧栏 / 全页）同时打开时各自独立解码。
- 网页投送依赖本地 WebSocket / WebRTC，直连与 background 中转两条路径均需在真实浏览器中实测。

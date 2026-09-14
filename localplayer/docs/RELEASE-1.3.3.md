# 发版说明 · v1.3.3

- 发布日期：2026-09-14
- 分支模型：`develop` → `release/1.3.3` →（合并入 `master` + `develop`）
- 标签：`v1.3.3`（打在 `master`）

## 一句话摘要

修复 `server.py` 在 Werkzeug 过旧环境下启动崩溃，并移除实测无法打开的侧边栏播放器（常驻界面由 `player.html` 承担）。

## 包含的变更

### 修复
- `requirements.txt` 显式约束 `Werkzeug>=3.1`：`server.py` 在 Werkzeug 0.16.0 + Flask 3.1.3 组合下启动即抛
  `TypeError: LocalProxy.__init__() got an unexpected keyword argument 'unbound_message'`；重装依赖后正常。
  - 验证：环境执行 `pip install -r requirements.txt`（确保 Werkzeug>=3.1 且 `flask-sock` 已装），再 `python server.py` 应监听 `http://127.0.0.1:5000`。

### 变更
- 移除侧边栏播放器：删 `side_panel` 声明、`background.js` 的「打开侧边栏播放器」右键菜单项与处理分支、文件 `sidepanel.html`。
  常驻界面由「打开独立播放器页面」（`player.html`）满足。

## 升级方式
1. 拉取 `master` 或检出 `v1.3.3`，按 README「加载方式」重新加载扩展。
2. 启用网页投送前：`pip install -r requirements.txt` 确保后端依赖就绪，再 `python server.py`。

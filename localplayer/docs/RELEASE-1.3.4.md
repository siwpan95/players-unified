# 发版说明 · v1.3.4

- 发布日期：2026-09-14
- 分支模型：`develop` → `release/1.3.4` →（合并入 `master` + `develop`）
- 标签：`v1.3.4`（打在 `master`）

## 一句话摘要

修复网页投送在后端停止后状态滞后（自动复位），以及后端根路径 `/` 与 `/favicon.ico` 的 404。

## 包含的变更

### 修复
- **投送状态自动复位**：后端 `server.py` 关闭 → 信令 WebSocket 断开 → offscreen 直连 `onclose` 与 background 中转 `onclose` 均触发 `onSignalingLost()`，清理 PC/WS 并向 popup 发出 `active:false`；popup 收到后复位「投送中」开关与按钮，无需手动关停。
  - 切换中转（2.5s 超时/直连错误走 relay）时不会误触发（由 `useRelay` 守卫）；用户主动停止也不受影响。
- **后端根路径**：`server.py` 新增 `GET /` 落地页（说明各接口用途并链接 `/api/list`、`/remote`）与 `GET /favicon.ico`（返回 `204`），消除根地址与 favicon 的 404 日志噪音。

## 升级方式
1. 拉取 `master` 或检出 `v1.3.4`，按 README「加载方式」重新加载扩展。
2. 启投送前：`pip install -r requirements.txt` 确保后端就绪，再 `python server.py`。
3. 根地址 `http://127.0.0.1:5000/` 现在会显示落地页而非 404。

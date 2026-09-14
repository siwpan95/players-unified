# 轻量播放器 · 本地媒体（Chrome / Edge 通用扩展）

一个以浏览器扩展（Manifest V3）形式分发的轻量本地媒体播放器，
支持视频 / 音频混排播放列表、自动下一曲、音频 / 视频模式自动切换。

Chrome 与 Edge 使用同一套 MV3 规范，本扩展在两者上通用，无需改动。

## 目录结构

```
localplayer/
├── manifest.json     # MV3 扩展清单（popup + options_page + side_panel + background + offscreen + web_accessible_resources）
├── popup.html        # 弹窗页面结构
├── popup.css         # 弹窗样式
├── app-layout.css    # 各播放器界面（popup / 侧栏 / 全页）共用的布局样式
├── popup.js          # 播放逻辑（混合加载：远端优先 + 本地打包兜底）
├── player.html       # 独立全页播放器（复用 popup 播放逻辑，对应「独立插件应用」）
├── lib/hls.min.js     # 本地打包的 hls.js（Apache-2.0），用于播放 .m3u8
├── plugins/           # 最小自定义插件接口（插件式媒体源）
│   ├── plugin-api.js  # LocalPlayer.plugins 注册表 + collectMedia（fallback 链）
│   └── sample-source.js  # 示例插件模板（默认不加载，按注释启用）
├── options.html      # 选项页结构
├── options.css       # 选项页样式
├── options.js        # 选项页逻辑（读写后端地址到 chrome.storage.sync）
├── background.js     # MV3 service worker（拉取后端 /api/list 清单 + 信令中转 + offscreen 管理）
├── offscreen.html    # 后台音频 / WebRTC 主运行时文档
├── offscreen.js      # 后台音频续播 + 网页投送（WebRTC 串流当前媒体）
├── server.py         # 可选 Flask 后端（/api/list + /media/<file> + /ws 信令 + /remote 观看页）
├── gen_media_manifest.py       # 扫描 media/ 生成本地媒体清单 media/manifest.json
├── gen_media_manifest.bat      # 同上（Windows 双击运行）
├── media/            # 随扩展打包的媒体（含 README 说明与 manifest.json 清单）
├── requirements.txt  # 可选 Flask 后端依赖
├── CHANGELOG.md      # 版本变更记录
├── docs/             # 文档（分支模型 branching.md、发版说明 RELEASE-*.md 等）
├── LICENSE           # MIT
└── README.md
```

> `deepseek_html_20260914_584fc0.html` 为拆分前的单文件源，保留作参考。

## 近期版本变更（v1.3.x 一览）

v1.3.x 完成了「常驻界面 + 网页投送」两大能力升级（完整记录见 [CHANGELOG.md](CHANGELOG.md)）：

- **v1.3.0 常驻界面 + 网页投送**：新增独立全页播放器（`player.html`），修复「切标签页 popup 自行回退」；新增 WebRTC「网页投送」，可将当前播放投送到外部网页观看。
- **v1.3.1 投送健壮性**：WebRTC 信令「直连优先 + background 中转兜底」；开启投送前做后端可达性校验，不可达时按钮置灰并提示先启动 `server.py`；版本号补登为 1.3.1。
- **v1.3.2 投送可用性 + 静默降级**：接收端 `/remote` 页显示曲目信息与连接状态，发送端显示「投送中 · N 个接收端」；媒体源在后端未启动时静默回落本地源，不再刷 `console.warn`。

## 加载方式

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）。
2. 右上角开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本目录 `localplayer`。
4. 点击工具栏图标，弹出播放器。

## 选项页（配置后端地址）

右键扩展图标 → 「选项」，或在 `chrome://extensions` 详情页点击「扩展选项」，打开设置页：

- **后端地址 (Backend URL)**：填写你的 Flask 后端基址（默认 `http://127.0.0.1:5000`）。
  `background.js` 每次拉清单时都会读取 `chrome.storage.sync.backendUrl`，保存后立即对新打开的 popup 生效。
- 留空或格式无效 → popup 回退到随扩展打包的本地媒体。
- 「测试连接」：直接探测当前输入框地址的 `/api/list`（与是否保存无关），
  成功时显示返回的媒体数量，失败给出错误原因，便于保存前确认后端可达。
- 「恢复默认」一键重置为 `http://127.0.0.1:5000`。

## 媒体来源（两种模式）

`popup.js` 的 `loadMedia()` 决定媒体清单来源。两种模式可同时存在（见下文「混合模式」）。

### 模式 A：随扩展打包 + `web_accessible_resources`

把媒体文件放进 `media/` 目录，并在 `manifest.json` 声明：

```json
"web_accessible_resources": [{
  "resources": ["media/*"],
  "matches": ["<all_urls>"]
}]
```

扩展运行时**无法枚举自身包内目录**，所以本地媒体清单由 `gen_media_manifest.py`（或 `gen_media_manifest.bat`）
扫描 `media/` 生成 `media/manifest.json`，`popup.js` 读取该清单得到实际文件，路径形如
`chrome-extension://<扩展ID>/media/xxx.mp4`。**放入新文件后需重新运行生成脚本并刷新扩展**，popup 才会列出它们。
媒体随扩展分发，无需后端，完全离线可用。

### 模式 B：走 background service worker 拉取后端清单

1. 用 `requirements.txt` 里的 Flask 起一个后端，提供 `/media/<file>` 与 `/api/list`。
2. 新增 `background.js`（MV3 service worker）暴露
   `chrome.runtime.onMessage` 监听，由它 `fetch` 后端清单后回传。
3. `popup.js` 通过 `chrome.runtime.sendMessage` 取清单，再逐条播放。
   后端地址等可存于 `chrome.storage`。

### 混合模式（A + B 已同时实现）

两者并不冲突，已默认开启：

- `web_accessible_resources`（`manifest.json`）解决「扩展内打包文件如何被 popup 访问」；
- background service worker（`background.js`）解决「如何异步从远端后端拿清单」。

**实现（`popup.js` 的 `loadMedia()`）**：popup 启动先 `chrome.runtime.sendMessage({action:'getMediaList'})`
向 `background.js` 取远端清单；`background.js` 用 `fetch` 调用后端 `/api/list`（地址来自
`chrome.storage.sync.backendUrl`，默认 `http://127.0.0.1:5000`，可覆盖）。若远端返回非空 →
用后端模式（B）；若拉取失败 / 后端未起 → 回退到 `media/manifest.json` 列出的本地打包文件（A）。
两种来源互不干扰，最终统一进 `files` 数组。

**配套 Flask 后端**：`server.py` 提供 `GET /api/list`（返回 `{name,path,type}` 数组，
`path` 为完整 URL）与 `GET /media/<file>`。运行见文件头注释。

## HLS（.m3u8）播放

`index.m3u8` 这类 HLS 播放列表，Chrome 原生 `<video>` 无法直接播放。本项目在 `lib/hls.min.js`
本地打包 [hls.js](https://github.com/video-dev/hls.js)（Apache-2.0；因 MV3 禁止运行时加载远程脚本，必须本地打包），
`popup.js` 检测到 `.m3u8` 源时自动用 hls.js 接管播放（Safari / iOS 走原生 HLS）。

> 注意：`.ts` 分片由 `.m3u8` 引用，无需（也不应）单独列出，生成清单时已被 `gen_media_manifest.py` 跳过。

## 插件式媒体源（最小自定义接口）

本项目不引入任何插件框架（如 Cordis），而是用约 40 行代码提供**最小自定义插件接口**，满足「可插拔媒体源」诉求。一个媒体源插件就是一个对象，向 `LocalPlayer.plugins` 注册即可：

```js
LocalPlayer.plugins.register({
  id: 'my-source',                 // 唯一
  name: '我的媒体源',
  priority: 5,                     // 越大越优先（后端=10，本地打包=0）
  async getMedia() {               // 返回 {name,path,type}[]；失败时抛错以便 fallback
    return [/* ... */];
  }
});
```

- 注册表与取数逻辑见 [`plugins/plugin-api.js`](plugins/plugin-api.js)。
- 内置两个源：**远端后端**（priority 10，走 background 拉 `/api/list`）与**本地打包**（priority 0，读 `media/manifest.json`）。
- `loadMedia()` 调用 `LocalPlayer.plugins.collectMedia()`，按优先级取**第一个返回非空列表**的插件（fallback 链）。
- 示例插件（从 `chrome.storage.sync` 读自定义列表）见 [`plugins/sample-source.js`](plugins/sample-source.js)；默认不加载，按其文件头注释在 `popup.html` 加入对应 `<script>` 即可启用。

## 播放交互增强（A 类）

围绕「单用户本地播放」做的最小增强，均为原生 Web 能力，不引入任何依赖：

- **媒体会话（Media Session API）**：播放时写入锁屏元数据（标题 / 来源），并接管硬件媒体键——播放 / 暂停、上一曲 / 下一曲、快进 / 快退 / 跳转。键盘与锁屏控制统一复用现有 `playByIndex` 与进度逻辑。
- **画中画（Picture-in-Picture）**：视频模式下显示「⧉ 画中画」按钮，点击将视频浮窗化（音频模式自动隐藏按钮），再次点击退出。
- **键盘快捷键**（popup 聚焦时生效）：
  - `空格` / `k`：播放 / 暂停
  - `←` / `→`：后退 / 前进 5 秒
  - `↑` / `↓`：音量 ±0.1
  - `n` / `p`：下一曲 / 上一曲
- **进度记忆（chrome.storage.local）**：按媒体路径记录播放位置，重开扩展后自动恢复到上次进度（误差 < 1 秒处不跳）。所有文件进度缓存在 `lp_progress` 中。

## 播放交互增强（B 类）

在 A 类基础上，用原生能力做的进阶增强（均不引入新依赖）：

- **后台音频续播（offscreen）**：新增 `offscreen.html` / `offscreen.js`，通过 `chrome.offscreen`（manifest 需 `offscreen` 权限）承载 `<audio>`。点击音频后，声音改由 offscreen 文档播放，**关闭 popup 后音乐继续**；popup 内显示后台状态面板（标题 / 播放暂停 / 进度条），键盘与锁屏媒体键经 service worker 转发到 offscreen 控制。浏览器不支持 offscreen 时自动回退为 popup 内播放。
  - 进度落盘：后台音频的播放进度由 offscreen 直接写入 `chrome.storage.local` 的 `lp_progress`（与 popup 内播放共用同一缓存键），重开扩展后再次播放同一文件会自动恢复到上次位置；offscreen 单曲播完若 popup 已关闭则不会自动续播下一集。
- **字幕 / 多语言**：媒体项可携带 `tracks`（如 `[{src, srclang, label, default}]`），`attachSource` 在视频元素上渲染为多个 `<track>`（WebVTT）。媒体源插件 / 后端 `/api/list` 返回 `tracks` 即生效。
- **搜索与排序**：播放列表上方提供搜索框（按名称过滤）与排序下拉（默认 / 名称 / 类型），实时过滤与重排。

## 播放交互增强（C 类）

**投屏 / Chromecast（暂不实现，标记为 future / stretch）**：技术上可通过 Google Cast SDK 将本地媒体投到电视；但 MV3 扩展内集成 sender 需注入脚本并对 receiver 应用做白名单，集成成本较高。本项目是本地单用户播放器，投屏属于低频诉求，且引入 Cast SDK 与 README「不过度设计」原则冲突，故**当前不值得**。

### 什么时候才值得考虑
- 当用户确有「把本地媒体投到 Chromecast / 智能电视」的真实诉求时，再评估；届时可作为新的媒体输出插件（复用最小插件接口），而非修改播放核心。

> 注：上面的「投屏 / Chromecast」评估针对的是电视 / Cast 协议；**「网页投送」（WebRTC 投到外部网页）已在 v1.3.0 实现，见下节**，两者方案与诉求不同，互不影响。

## 网页投送（将当前播放投到外部网页，v1.3.0+）

把扩展内正在播放的视频 / 音频，通过 WebRTC 实时串流到任意「打开 `http://127.0.0.1:5000/remote` 的网页」上观看（如手机 / 平板 / 同网另一台电脑的浏览器），本质是一个轻量「投屏到网页」方案，与 Chromecast 无关。

- **前置**：需先启动可选后端 `python server.py`（默认 `http://127.0.0.1:5000`），它提供 `/ws` 信令中继与 `/remote` 观看页。
- **使用**：在 popup / 侧边栏 / 独立播放器界面点「🔊 网页投送」开关；开启后 offscreen 将当前媒体经 WebRTC 串流、本地界面静音避免双声，接收端打开 `/remote` 即可观看。
- **信令兜底**：offscreen 先直连 `ws://127.0.0.1:5000/ws`，超时或报错则回落经 background 持有的中转 WebSocket，提升兼容性。
- **状态可见**：接收端 `/remote` 显示当前曲目信息（标题 — 艺术家）与连接状态；发送端 popup 显示「📡 投送中 · N 个接收端 / 等待接收端连接」，接收端上下线实时回传。
- **后端不可达**：开启前会做可达性校验，不可达时投送按钮置灰并提示先执行 `python server.py`，避免静默挂起。

> 验证门槛：扩展类改动无法在命令行跑测试；加载到 `chrome://extensions` 开发者模式手动验证；`node --check` 仅校验纯 JS 语法。

## 架构选型笔记：Codis / Cordis / MediaMTX 对本项目有帮助吗？

结论：**三者现阶段都不相关（MediaMTX 抛开 WebRTC 看其本体亦然），引入属过度设计。**

- **Codis**：基于代理的 Redis 分布式集群方案，解决单机 Redis 的容量 / 高可用 / 水平扩容，是后端基础设施。本项目是纯前端、单机、无后端、无共享状态的 MV3 浏览器扩展，既不存数据也不服务多用户，没有需要 Codis 兜底的 Redis。
- **Cordis**：Koishi 的可逆插件系统元框架（插件可加载 / 卸载 / 销毁），是 Node/TS 服务端框架；而扩展是浏览器 JS，MV3 本身已有轻量能力组合方式（background / content script / message passing / options_page），当前规模远不需要一个完整插件市场。
- **MediaMTX**：自带多协议的流媒体服务器（RTSP / RTMP / HLS / WebRTC / SRT），本质是一个**协议桥**——把直播源（RTSP 摄像头、OBS 的 RTMP 推流、SRT 等）收流后再以多种协议重分发；它只转封装（transmux）不转码。本项目播放的是本地静态文件（mp4 / mp3 / m3u8），浏览器已能直接播放，无需任何流媒体服务器中转；其 HLS 输出是给直播流转封装设计的，用 Flask + 扩展自带 URL 直接服务静态文件更简单，且已经这么做。

### 什么时候才值得考虑
- **Codis**：仅当项目演进为「带后端的多人云媒体服务」、需要缓存与水平扩容时才有意义。
- **Cordis**：仅当真正需要插件生态时。即便如此，本项目采用上面的**最小自定义插件接口**即可满足，远比引入 Cordis 整个体系轻量。
- **MediaMTX**：仅当项目要接入**直播源**（RTSP 摄像头、RTMP / SRT 推流、OBS 等）时才有意义——届时它是最合适的「收流 → 转封装为 HLS」桥梁，而我们已接入的 hls.js 正好能消费它产出的 `.m3u8`。纯静态本地媒体场景下它纯属多余。

## 开发约定

### 版本号与 CHANGELOG 必须同步
每次发版改 `manifest.json` 的 `version` 时，**必须**同步在 `CHANGELOG.md` 顶部新增一条 `## [x.y.z]` 记录，且顶部第一条版本号应与 `manifest.json` 一致（`check_version.py` 取文件顶部第一条为"最新"）。

- 自检脚本 `check_version.py`：比对 `manifest.json` 的 `version` 与 `CHANGELOG.md` 顶部版本号，一致退出码 0，不一致退出码 1。
  ```bash
  python check_version.py
  ```
- 提交前自检钩子已纳入版本管理（位于 `hooks/pre-commit`，与 `check_version.py` 同仓库跟踪）。启用方式二选一：
  - **推荐**：在本仓库执行 `git config core.hooksPath hooks`，此后 git 直接读取跟踪目录里的钩子，且与提交内容始终同步（无需手动复制）。
  - 或手动复制：`cp hooks/pre-commit .git/hooks/pre-commit`（Windows 用 `copy hooks\pre-commit .git\hooks\pre-commit`）。
- 钩子行为：提交时自动运行 `check_version.py`，版本不一致会**阻止提交**并提示对齐；找不到 python 时仅警告放行。

> 历史教训：v1.2.2、v1.3.1 都曾因只改了 CHANGELOG 或只改了 manifest 一方，导致扩展列表显示的版本号与文档脱节；此自检即为防止再犯。

## 许可

MIT License，见 [LICENSE](LICENSE)。

第三方依赖：[hls.js](https://github.com/video-dev/hls.js)（Apache-2.0）以本地资源 `lib/hls.min.js` 打包，用于 `.m3u8` 播放。

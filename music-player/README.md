# Music Player · Python + VLC

> 一个本地优先的桌面音乐播放器：tkinter 做界面，python-vlc（libVLC）做内核。全格式播放、真实 seek、LRC 歌词滚动、音频可视化、拖放导入、网络电台 / HLS，并复用本机 `ncmturnmp3` 解密导入本人已购买的加密音乐。**不造轮子**——播放内核完全交给 VLC，UI 只负责呈现与编排。

---

## 快速开始

```bash
# 1. 安装 VLC 运行时（libVLC）—— 播放内核依赖它
#    Windows: https://www.videolan.org/vlc/  （脚本会自动探测安装位置）
#    若自动探测失败，启动前设置环境变量： set VLC_DIR=<你的 VLC 安装目录>

# 2. 安装 Python 依赖
pip install -e .

# 3. 运行
python main.py
# 或： python -m music_player
```

| 步骤 | 命令 | 说明 |
| --- | --- | --- |
| 安装依赖 | `pip install -e .` | 安装 python-vlc / mutagen / numpy / Pillow |
| 可选可视化 | `pip install -e ".[viz]"` | 启用 librosa 频谱（默认用 numpy STFT，零额外依赖） |
| 打包桌面版 | `pip install -e ".[packaging]"` | 安装 PyInstaller，用于 `build.spec` 内嵌 VLC 出 exe |

---

## 功能概览

| 功能 | 说明 | 依赖 |
| --- | --- | --- |
| 全格式播放 | 借助 libVLC，支持 mp3/flac/ogg/wav/m4a/aac/opus/ape/wma 等 | python-vlc |
| 真实 seek | 进度条任意拖动定位，非近似 | python-vlc |
| LRC 歌词滚动 | 自动加载同名 `.lrc`，高亮当前行 | 内置 LrcParser |
| 音频可视化 | 预计算频谱 / 波形，随播放进度渲染 | numpy + tkinter Canvas |
| 拖放导入 | 从资源管理器拖文件/文件夹进窗口，零依赖 | ctypes `WM_DROPFILES` |
| 网络电台 / HLS | 直接播放 `.m3u` 电台与 `http(s)://*.m3u8` 直播流 | python-vlc 原生支持 |
| 加密音乐导入 | 复用本机 `ncmturnmp3`，解密**本人已购买**的 `.ncm` 等文件 | ncmturnmp3（路径注入，不复制代码） |
| 播放模式 | 顺序 / 列表循环 / 单曲循环 / 随机 | 内置 PlaylistModel |
| 10 段均衡器 | flat/rock/pop/jazz/classical/bass/vocal 预设 + 自定义 | python-vlc AudioEqualizer |
| 无头 RPC 控制 | 本地 TCP JSON-RPC，供外部脚本/程序控制 | 标准库 asyncio，无三方依赖 |

---

## 使用方式

```text
1. 文件 → 添加文件 / 添加文件夹，或把文件直接拖进窗口
2. 双击播放列表中的曲目开始播放
3. 文件 → 导入加密音乐：先合规确认（仅限本人已购买内容），选择 .ncm 等文件
4. 工具 → 均衡器：选预设或拖 10 段滑块实时调音
5. 工具 → 开启 RPC 控制：监听 127.0.0.1:7700，供外部程序控制
6. 右键电台面板可导入 .m3u，双击电台即播
```

| 场景 | 操作 |
| --- | --- |
| 播本地歌单 | 添加文件夹 → 双击播放 → 控制栏切歌/调音量 |
| 看歌词 | 把 `xxx.lrc` 放在与 `xxx.mp3` 同目录，自动加载并滚动 |
| 看可视化 | 切到「频谱/波形」由 Visualizer 自动预计算（首次加载略耗时） |
| 听电台 | 电台面板填名称+URL 添加，或导入 `.m3u`，双击即播 |
| 解密本人音乐 | 文件 → 导入加密音乐（合规弹窗确认后执行） |

---

## 键盘快捷键

| 快捷键 | 功能 | 快捷键 | 功能 |
| --- | --- | --- | --- |
| `Space` | 播放 / 暂停 | `←` | 后退 5 秒 |
| `→` | 前进 5 秒 | `↑` / `↓` | 音量 ±5 |
| `N` | 下一首 | `P` | 上一首 |
| `M` | 静音切换 | `S` | 停止 |

| 播放模式 | 含义 | 播放模式 | 含义 |
| --- | --- | --- | --- |
| 顺序 | 按列表顺序播完停止 | 列表循环 | 播完回到开头续播 |
| 单曲循环 | 重复当前曲 | 随机 | 随机选下一首 |

---

## 项目结构

```text
music-player/
├── main.py                      # 入口：from music_player.__main__ import main
├── build.spec                   # PyInstaller 打包（内嵌 VLC）
├── pyproject.toml               # 依赖与打包元数据
├── music_player/
│   ├── __main__.py              # main()：VLC 导入失败弹出致命错误
│   ├── engine/                  # 播放内核层（唯一持有 python-vlc）
│   │   ├── player_state.py      # PlayerState 契约（UI 只读）
│   │   ├── media_item.py        # MediaItem 契约（本地/解密缓存/电台）
│   │   ├── play_mode.py         # next_index/prev_index 纯函数
│   │   ├── events.py            # EventBus（RPC-ready 观察者）
│   │   ├── player_engine.py     # PlayerEngine（VLC 门面 + 事件收敛）
│   │   ├── equalizer.py         # 10 段均衡器预设（不依赖 VLC）
│   │   └── rpc_bridge.py        # 无头 JSON-RPC 控制桥
│   ├── library/                 # 媒体库与导入
│   │   ├── playlist_model.py    # 播放列表 + 播放模式
│   │   ├── scanner.py           # 目录递归扫描
│   │   ├── encrypted_import.py  # 复用 ncmturnmp3 解密导入
│   │   └── radio_manager.py     # 电台管理 / .m3u 导入
│   ├── metadata/                # 元数据与封面
│   │   ├── metadata_cache.py    # mutagen 读取标签/时长
│   │   ├── cover.py             # 封面提取（APIC/FLAC/MP4）
│   │   └── lrc_parser.py        # LRC 解析 + 二分定位当前行
│   ├── viz/                     # 可视化
│   │   └── visualizer.py        # numpy STFT 频谱 / 波形预计算
│   ├── utils/                   # 工具
│   │   ├── vlc_runtime.py       # VLC 运行时自动探测（含 _MEIPASS）
│   │   ├── ffmpeg.py            # ffmpeg 定位（可视化用）
│   │   ├── paths.py             # 缓存目录（封面/解密/可视化）
│   │   ├── threads.py           # 后台 worker
│   │   └── dragdrop.py          # ctypes 拖放
│   ├── ui/                      # Tkinter 界面
│   │   ├── app_window.py        # 总装配 + RPC 调度
│   │   ├── controls.py          # 控制栏
│   │   ├── now_playing.py       # 封面 + 进度
│   │   ├── playlist_panel.py    # 播放列表
│   │   ├── lyrics_panel.py      # 歌词滚动
│   │   ├── visualizer_panel.py  # 可视化画布
│   │   ├── radio_panel.py       # 电台面板
│   │   └── equalizer_panel.py   # 均衡器窗口
│   └── tests/                   # pytest（19 项非网络用例全过）
└── tools/
    └── fetch_gitee_readmes.py   # 下载本人全部 Gitee 仓库 README
```

---

## 依赖

| 库 | 用途 | 是否必需 |
| --- | --- | --- |
| python-vlc | libVLC 绑定，播放内核 | 必需 |
| VLC 运行时 | libvlc.dll + plugins，需单独安装 | 必需 |
| mutagen | 标签 / 封面读取 | 必需 |
| numpy | 可视化 STFT 计算 | 必需 |
| Pillow | 封面显示 | 必需 |
| librosa / scipy | 进阶频谱（可选可视化后端） | 可选 `[viz]` |
| pyinstaller / imageio-ffmpeg | 桌面打包 | 可选 `[packaging]` |

---

## 无头 RPC 控制

播放器支持通过本地 TCP 暴露 JSON-RPC 2.0 接口（`工具 → 开启 RPC 控制`，默认 `127.0.0.1:7700`）。
每个请求一行 JSON，响应同样一行 JSON：

```text
请求: {"jsonrpc":"2.0","method":"play","params":{},"id":1}
响应: {"jsonrpc":"2.0","result":{...状态快照...},"id":1}
```

| 方法 | 参数 | 说明 |
| --- | --- | --- |
| `play` | — | 播放 / 暂停切换 |
| `pause` / `resume` | — | 暂停 / 继续 |
| `stop` | — | 停止 |
| `next` / `prev` | — | 下一首 / 上一首 |
| `play_index` | `index` | 播放指定索引 |
| `seek` | `position_ms` 或 `fraction` | 定位（毫秒或 0~1 比例） |
| `volume` | `value` (0-100) | 设置音量 |
| `mute` | `value` (bool) | 静音 |
| `set_mode` | `mode` | sequential/loop/single/random |
| `equalizer` | `preset` 或 `bands` | 均衡器（预设名或 10 段增益） |
| `add_files` | `paths` | 加入播放列表 |
| `status` | — | 当前状态快照 |
| `playlist` | — | 播放列表清单 |
| `ping` | — | 健康检查 |

---

## 合规声明

加密音乐导入**仅用于解密本人已购买或合法拥有的文件**。本工具不内置任何解密算法，
仅以路径注入方式复用你本机已有的 `ncmturnmp3` 项目，且不传输、不上传任何文件。
详见 `COMPLIANCE.md`。

---

## 打包为桌面 exe

```bash
pip install -e ".[packaging]"
pyinstaller build.spec --clean
# 产物在 dist/music-player/，含内嵌 VLC，可直接拷贝到未装 VLC 的机器运行
```

`build.spec` 会把 `VLC_DIR`（默认 `E:/VLC`）整目录内嵌进 `<MEIPASS>/vlc`，
`music_player/utils/vlc_runtime.py` 在运行时自动从 `sys._MEIPASS/vlc` 识别。

---

## License

MIT — siwpan

---

## 仓库索引标注（2026-09-30 · siwpan 统一治理）

> 本播放器为全新独立项目，非 fork/copy 任何既有仓库。
> - 播放内核采用 **python-vlc（libVLC）**，全格式与真实 seek 直接受益于此，不重复造轮子。
> - 加密音乐导入**复用**本机 `ncmturnmp3`（Gitee: siwpan/ncmturnmp3），通过路径注入调用其 `audio_core.process_one`，
>   来源与许可证随该仓库，范围限定为「仅解密本人已购买内容」，不复制其代码。
> - 界面/编排/元数据/可视化/均衡器/RPC 桥均为本项目自有实现，MIT 开源。
> - 配套脚本 `tools/fetch_gitee_readmes.py` 可下载本人全部 Gitee 仓库 README 至 `docs/reference-readmes/`。

## PyPI 定性（2026-10-20 · 治理结论）

> **本项目不推送 PyPI**，理由两条，均已核实：
> 1. **播放内核完全由 python-vlc（libVLC）承担**——本项目自有代码只做界面 / 编排 / 元数据 / 可视化 /
>    均衡器 / RPC 桥，且强依赖 VLC 运行时（`libvlc.dll` + plugins，需单独安装或 PyInstaller 内嵌）。
>    离开 libVLC 即无法工作，属于「依赖外部运行时内核的桌面应用」，不是可独立分发的 Python 库。
> 2. **依赖兄弟仓 `ncmturnmp3`**（以路径注入方式复用），发到 PyPI 后安装方拿不到该上游，功能直接缺失。
>
> 分发渠道：Gitee Release 源码 / PyInstaller 桌面 exe（见上文「打包为桌面 exe」）。
> 若未来要把某个**不依赖 libVLC 的纯函数模块**（如 `equalizer.py` 的预设、`lrc_parser.py`）单独抽出发布，
> 应拆成独立仓库再评估，不要在应用壳内切包。


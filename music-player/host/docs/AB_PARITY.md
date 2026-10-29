# A/B 行为等价对拍报告（Cordis Node host ↔ Python 原版）

## 结论

**25 一致 / 0 差异**。同一份 JSON-RPC transcript 分别打 A 侧（Python 无头 harness，
`tools/ab_harness.py`）与 B 侧（Node host 的 `RpcService`），逐观测点比对返回序列，
确定性字段全部一致。

复现：`cd host && node test/ab_parity.mjs`

## 方法

- **A 侧**：`tools/ab_harness.py` —— 用 `PlayerEngine + PlaylistModel` 复刻
  `ui/app_window.py` 的 `_rpc_execute` 命令面，经 `engine/rpc_bridge.py` 的
  TCP JSON-RPC 2.0 暴露；所有 VLC 操作串行在专用引擎线程（等价于原实现的
  `root.after` 主线程切换）。
- **B 侧**：`host/src/services/rpc.js` —— 同一协议、同一命令面、同一返回契约。
- **transcript**：14 个方法 × 25 个观测点（ping / add_files / status / play_index /
  pause / resume / volume / mute / set_mode / seek / equalizer×2 / playlist / next /
  prev / stop），覆盖播放、暂停、恢复、音量、静音、模式、定位、均衡器开关、切歌。
- **归一化**：易变字段（播放进度、URI 表示、命令即时返回的 status）归一化为语义
  哨兵后比对；确定性字段（current_index / volume / mute / play_mode / equalizer_on /
  mode / index / title / radio / added / pong）逐位精确比对。

## 有意差异（已归一化，非缺陷）

| 观测点 | A 侧（Python/libvlc） | B 侧（Node/VLC RC） | 理由 |
| --- | --- | --- | --- |
| `current_uri` / `uri` | 本地绝对路径 `D:\…\a.wav` | `file:///D:/…/a.wav` | RC `add` 需要 file:/// URI；libvlc `media_new_path` 收本地路径 |
| `position_ms` 精度 | libvlc 毫秒、同步查询 | RC `get_time` 秒级、400ms 轮询 | RC 接口只返回整数秒 |
| 命令即时返回的 `status` | `load` 后仍 `stopped`，靠 VLC 事件回调才变 `playing` | 乐观同步置 `playing` | 两侧 settle 后一致（均 `playing`） |

## 修复的参照实现 bug（A 侧，对拍前修）

1. **`current_index` 从未维护** —— `PlayerState.current_index` 定义后全程无赋值
   （恒 `-1`），`_rpc_current()` 却读它，导致 `next/prev/play_index` 返回的
   `index` 恒为 `-1`。harness 改为读 `PlaylistModel.index()`。
2. **`status`/`play_mode` 枚举不可 JSON 序列化** —— `snapshot().__dict__` 里两者是
   枚举对象，`json.dumps` 在 `RpcServer` 的 try 块外抛 `TypeError`，连接被异常关闭、
   客户端超时。harness 改为 `.value` 字符串。

## 覆盖 / 未覆盖

- **已覆盖**：RPC 命令面（14 方法）、sequential 模式端到端切歌、均衡器开/关、
  状态契约字段（status/current_index/volume/mute/play_mode/equalizer_on）。
- **未覆盖（单测已补，非端到端）**：loop/single/random 的 next/prev 纯逻辑
  （`test/playlist.test.mjs` + `test/lib.test.mjs`）、LRC 解析、均衡器预设/clamp、
  m3u 解析。
- **未覆盖（需外部依赖/网络）**：加密导入（需真实 .ncm + ncmturnmp3）、电台 HLS
  直播（需网络）、可视化频谱逐浮点（FFT 实现级精度差异，波形 RMS 与 duration_ms
  可精确比对）。

# host —— players-unified 统一 Cordis 宿主

三端（`daily_player` / `localplayer` / `pluginplayer`）的统一**编排层**。形态参考
DeepSeek Harness（dsh）：配置不是「一个文件」，而是若干层叠出来的；`--dump-config`
打印的也不是「我配了什么」，而是**实际启动后**的插件树。

只做编排，不做合并：三个运行时（C++ 原生内核 / Chromium MV3 / Node）仍然各自独立，
宿主负责的是「谁在跑、枚举怎么汇总、深链怎么发、后端面由谁提供」。详见
`ARCHITECTURE.md` §1（分层里的宿主位置）/ §4（适配器映射）/ §7（路线图 Phase 5）。

## 用法

```bash
cd host

node src/cli.mjs --profile desktop --dump-config     # 打印实际启动后的插件树
node src/cli.mjs --profile desktop --dump-config=json
node src/cli.mjs --profile desktop --check           # 门禁：启用的条目必须都装载成功
node src/cli.mjs --profile desktop --aggregate       # 真去连各来源汇总媒体
node src/cli.mjs --profile desktop --patch patches/local-fast.json --dump-config
node src/cli.mjs --list-profiles

node tests/run-all.mjs                               # 全部验收（5 个文件，116 项）
node tests/run-all.mjs --only=ws                     # 只跑名字里带 ws 的
PU_REPORT=1 node tests/run-all.mjs                   # 另外刷新 docs/*.json 证据（默认不写盘，见下）
```

启动起来之后（`--profile desktop` 默认值），宿主就是 localplayer 原 Flask 后端的**替代品**，
同一端口 5000 上同时提供：

| 路径 | 说明 | 来源 |
|---|---|---|
| `GET /api/list` | 媒体清单 `MediaItem[]`（与 python `media_lib` 逐字段一致） | S5-2 |
| `GET /media/<file>` | 媒体文件（比 python 侧多支持单段 Range） | S5-2 |
| `GET /remote` | 网页投送观看页 | S5-3 |
| `WS  /ws` | WebRTC 信令中继（**自写 RFC6455**，见 `lib/ws.mjs`） | S5-3 |

扩展端（`localplayer/`）**零改动**：它连的就是 `ws://127.0.0.1:5000/ws` 与 `/api/list`。

## 合成语义：基座 → bundle → profile → patch

```
cordis.json            基座：只声明宿主自身核心服务（core/media），不含任何具体来源
bundles/*.json         可复用的一组插件（sources：三端来源；web-face：宿主 HTTP 面）
profiles/*.json        选哪些 bundle + 本 profile 的局部改动
patches/*.json         有序覆盖层，命令行给，后叠的赢
```

合并规则：

- 按 **分层 id** 寻址，`sources:pluginplayer`。层里写完整路径，条目自身的 `id`
  自动归一为最后一段（否则装载后会变成 `sources:sources:pluginplayer`）。
- `config` 深度合并（只写要改的键，其余继承）；数组按 `id` 递归合并。
- `disabled` 可正可反 —— 整个来源/整组都能靠一层关掉。
- **不允许**在覆盖层改插件本体（`name` 变了就报错）；覆盖只改参数与启停。
- `$group` / `$note` 是合成指令；合成器会算出 `$layer`（最后一次改到该条目的是哪一层）
  并留在 options 上，`--dump-config` 的溯源就靠它。

`profile` / `patch` 的实测效果：

```
$ node src/cli.mjs --profile library-only --dump-config
  sources:pluginplayer   [disabled inactive]  ← profiles/library-only.json
  sources:localplayer    [disabled inactive]  ← profiles/library-only.json
  sources:daily          [active]             ← bundles/sources.json

$ node src/cli.mjs --profile desktop --patch patches/local-fast.json --dump-config
  sources:pluginplayer   timeoutMs: 800      ← patches/local-fast.json   # 其余键继承 bundle
```

## 目录

```
cordis.json              基座层
bundles/  profiles/  patches/
src/cli.mjs              入口（--profile / --patch / --dump-config / --check / --aggregate / --open）
src/compose.mjs          分层合并（两阶段：先并层数据到「路径→节点」表，再一次性构建树）
src/dump.mjs             --dump-config 渲染 + 令牌打码
src/logging.mjs          把 cordis 日志接到 stdout/stderr（**不接就是静默失败**）
src/core/group.mjs       分组插件：自建嵌套配置树
src/core/media.mjs       ctx.media 服务：来源注册表 + 聚合 + 深链分发
src/core/transport.mjs   枚举/打开原语（从 launcher/server.mjs 移植的独立实现）
src/core/web.mjs         ctx.web 服务：**一个端口承载所有 HTTP 面 + WS 升级**（Host/Origin 闸门在这里）
src/sources/*.mjs        三端来源适配器 + bloodmusic（第四来源，P1 生态收编：BloodMusic 生成物经其自身仓库 host-js/python/list_media.py 枚举，深链 file:/// 直开；transport 新增通用 python-script kind，launcher/server.mjs 侧镜像实现保持双跑对拍口径）
src/web/library-core.mjs localplayer media_lib 的纯移植（清单构建）
src/web/library-face.mjs 列表面：/api/list + /media/<file>（Range）
src/web/signaling.mjs    WebRTC 信令中继的**纯状态机**（server.py `ws_signaling` 的逐行移植）
src/web/remote.mjs       投送面：/ws 升级 + /remote 观看页
lib/ws.mjs               手写 RFC6455（零依赖；帧编解码 / 握手 / 连接）
tests/run-all.mjs        全部验收的总入口
tests/loader-semantics.mjs  loader 语义探针
tests/parity.mjs            S5-1 双跑验收（聚合/深链 vs launcher）
tests/library-parity.mjs    S5-2 列表面验收（vs python media_lib）
tests/ws-rfc6455.mjs        S5-3 帧级验收（vs undici 真客户端 + raw 非法帧）
tests/remote-parity.mjs     S5-3 信令跨语言 A/B 对拍（vs python flask-sock）
tests/helpers/raw-ws.mjs    手写 raw WS 客户端（构造合法帧测不了的那些畸形帧）
tests/helpers/report.mjs    报告落盘闸门（默认不写，`PU_REPORT=1` / `--report` 才写）
tests/fixtures/*.mjs        测试替身（echo 插件等）
```

## 踩坑（都实测过，别再踩）

这些坑的共同特征是**症状与原因不相干**，所以记下来：

1. **`inject` 必须写在对象形态插件上。** `export default { name, inject, apply }`，
   不要写「函数 + 模块级 `export const inject`」。loader 的 `unwrapExports()` 取的是
   `default`，模块级导出留在 namespace 上，registry 看不到 → fiber 的 inject 为空 →
   插件访问 `ctx.media` 时以 **FAILED** 收场（报的是 "cannot get property media without
   inject"，很容易误以为是服务作用域问题）。
2. **别用赋值改函数/类的 `name`。** `name` 是 `writable: false`，严格模式下
   `apply.name = 'x'` 直接抛 `TypeError: Cannot assign to read only property 'name'`
   —— 而且这个错误发生在模块求值期，表现是「条目连 fiber 都没有」。
3. **cordis 默认不打印任何日志。** 插件 import 失败、apply 抛错都走
   `ctx.logger.error()`，没有 exporter 就是全丢。`src/logging.mjs` 必须接上，
   否则排查时间会被浪费在「条目静默不生效」上。
4. **`cordis:group`（loader 自带的 `Group`）不是嵌套树。** 实测：它的子条目注册在
   **根 store**，id 不加前缀、`resolve('父:子')` 直接失败。分层 id 只能来自
   「插件自己 `new EntryTree`」（`EntryTree` 构造里 `ctx.fiber.entry.subtree = this`）。
   所以宿主自建 `src/core/group.mjs`。
5. **条目 options 里不要写 `group: true`。** loader 的 `Entry.disabled` 第一行是
   `if (this.options.group) return false` —— 带这个标记的条目**永远停用不了**，
   `disabled: true` 会被静默忽略。而认出它是 group 靠的是 `EntryGroup.key`
   这个 symbol，与 `group: true` 无关。另外 `cordis:xxx` 需要自己往
   `ctx.loader.builtins` 里塞实现，loader 从不填充它。
6. **插件回调不能让 `Fiber._execute` 收到非函数返回值。** 返回 Promise 时它会
   `then(safeCollect)`，resolve 出的值必须是函数或 `null`，否则抛
   `TypeError: Invalid effect`；异步 `apply` 里 `return tree` 就会踩到。
7. **分组插件清理时只遍历本树的直接子条目**（`tree.store`），别用递归的 `tree.entries()`
   —— 否则嵌套子树会被内外层各 dispose 一次（trace 里能看到同一个 id 出现两次）。
8. **`fiber.dispose()` 只保证「发起顺序」。** 它不 await 各 effect 返回的 promise，
   所以「完成顺序」不确定。要断言卸载顺序，就断言**发起顺序**（分组插件为此发了
   `host/group-teardown` 事件）。
9. 裸模块名解析：本机 `ModuleLoader.fromInternal()` 返回 undefined（需
   `--expose-internals`），loader 会退回在 scope 里生成 `.cordis/resolve.mjs`
   垫片，所以 `host/.cordis/` 是运行时产物，已加进 `.gitignore`。
10. **解析器要区分「数据不足」与「消费了但没事件」两个返回值。** `lib/ws.mjs` 里
    分片帧的解析循环曾把两者混用同一个 `null`：客户端把握手与第一帧一口气写出、
    或把握手与分片消息一次性写出来时，第一帧之后的帧会被 `break` 掉，消息要等到
    下一个字节到达才交付（`ws-rfc6455` 的 C11/C12/C13 抓出来的）。三态：
    `undefined`=数据不足 / `null`=消费了但无事件 / 对象=事件。
11. **`server.on('upgrade')` 的 `head` 要在监听器接好之后再喂。** 客户端可能把握手
    与第一帧一次性写出来，那第一帧就在 `head` 里。`lib/ws.mjs` 的
    `upgrade(req, socket, head, { onConnection })` 把「接监听器」做成喂 `head` 之前的
    钩子 —— 否则 `conn.on('message')` 挂上之前事件已经发完，第一条消息静默消失。
12. **CSP 要按面给。** `ctx.web` 的默认安全头是 `default-src 'none'`（对 JSON/静态
    文件正合适），但观看页有内联脚本 + 同源 `ws://`，套同一个 CSP 会变成「页面加载
    成功但什么都不发生」。`src/web/remote.mjs` 给 `/remote` 单独一份 CSP。
    另外**别用 WebSocket 的 Origin 白名单去套浏览器扩展**：浏览器在 WS 握手时一定带
    `Origin: chrome-extension://<id>`，`ctx.web.checkUpgrade()` 因此对扩展来源单开一路
    （这是相对 python 侧的收紧，不是放宽 —— python 完全不看 Origin）。
13. **一次性 CLI 必须自己退干净。** `ctx.web` 持有监听 handle，只设 `process.exitCode`
    的话事件循环永不空、`--dump-config` 会挂住。`src/cli.mjs` 收尾时逆向卸载所有根条目
    （触发各插件 effect 清理），并留一个 `unref()` 的 2 秒兜底强退。
14. **`port: 0` 时白名单要重算。** Host/Origin 白名单是按端口算的，内核分配端口后
    必须重算一次，否则白名单里全是 `:0`，所有请求都被自己挡掉。

## 验收证据

一个入口跑全套：`node tests/run-all.mjs` → **5 个文件 / 116 项全绿**（约 8 秒）。

报告默认**不写盘**（`tests/helpers/report.mjs`）：`docs/s5-*.json` 是被 git 跟踪的发版证据，
而报告里天然含有**逐次运行都会变**的坐标（`generatedAt`、夹具随机端口、`mkdtemp` 临时目录名、
客户端随机 key 导出的 accept 回显），随手跑一次测试就会把这 4 个文件改脏，而这些差异没有信息量。
要刷新证据得显式 `PU_REPORT=1`。**可复现的是判定结果**（断言名 / ok / 计数 / conclusion），
**不是夹具坐标** —— 确认一次重跑没有实质改动，看 `git diff --stat docs/` 有没有超出坐标的变更。

- `tests/loader-semantics.mjs` —— **27/27**。把上面第 4/5/6/7/8 条语义钉成可回归的断言。
- `tests/parity.mjs` —— **10/10**，报告落在 `docs/s5-host-parity.json`。
  自起 fixture（两个本地 HTTP 服务 + 真实 `LocalFileSource` Python 子进程 + 一个死端口），
  宿主 `ctx.media.aggregate()` 与 `launcher.aggregate()` 在真实数据上
  **items / sources / total / planOpen 逐项一致**，故障降级文案也一致。
  这不是「拿一个函数跟自己比」：`src/core/transport.mjs` 是从 launcher 移植的
  **独立实现**，两条路径各自跑一遍才有意义。
- `tests/library-parity.mjs` —— **27/27**，报告 `docs/s5-library-face-report.json`。
  真值直接跑 python 的 `media_lib.build_media_items()`（扩展端实际消费的那个函数），
  与 JS 移植版**逐字段 + 键顺序**比对（含「名叫 `fake.mp4` 的目录也入列」这种 python 怪癖），
  再用真 HTTP 验字节 / `Content-Type` / Range 切片 / 三种路径穿越变体 / Host·Origin·OPTIONS。
- `tests/ws-rfc6455.mjs` —— **36/36**，报告 `docs/s5-ws-rfc6455-report.json`。
  三组锚点：RFC6455 §1.3 官方 accept-key 向量；**Node 内置 undici WebSocket**（第三方
  真客户端）做双向互操作；手写 raw 客户端构造 undici 造不出的畸形帧（未掩码 / RSV /
  未知 opcode / 控制帧分片 / 非法 UTF-8 / 非法关闭码 / 跨分片切断的多字节字符）。
  非法帧按 RFC 用 1002 / 1007 / 1009 关闭，逐条断言。
- `tests/remote-parity.mjs` —— **16/16**，报告 `docs/s5-remote-parity.json`。
  同一份剧本（5 个对端、13 步）分别打 **python `server.py`（flask-sock）** 和宿主 `/ws`，
  逐条比对每个对端收到的消息序列：结果**完全一致**。剧本特意覆盖 python 那套
  「单槽位、后来者覆盖」语义里最容易写错的地方（发送端晚于接收端上线不发 count、
  孤儿接收端掉线仍再发一次 count:0、未声明角色者的消息中继给 sender、meta 既缓存又转发、
  sender 掉线只通知槽位里的接收端）。

> **这次对拍当场抓出一个真 bug**：python `server.py` 的 `ws_signaling()` 里
> `_last_meta = msg` 让该名字变成函数局部变量，于是前面那句 `if _last_meta is not None:`
> 必然抛 `UnboundLocalError` —— **任何 viewer 一声明角色，`/ws` 就 500 断连**，
> 网页投送从接收端根本用不了。已修（`global _last_meta`）。宿主的 JS 移植版没有这个问题，
> 但「参照实现本身是坏的」意味着不修就没法做对拍 —— 对拍的价值恰在此。

## 待办

- 宿主目前只覆盖 `localplayer` 的后端面（清单 + 信令 + 观看页）。**PluginPlayer 的
  `/api/library` 与 daily_player 的 `play.py` 仍是各自独立进程**，宿主只做深链，不接管。
- `/ws` 未做鉴权（与 python 侧一致）：它只中继信令，不含敏感数据；接收端会拿到投送流，
  所以保留了 Host/Origin 白名单挡任意网页。若要更严，可加一次性 token。
- S2（单窗口嵌入，需改 C++ 用 `SDL_CreateWindowFrom`）、daily_player 播放列表 UI、
  分发带预编译 exe —— 均**非阻塞**，未排期。
- `pluginplayer/host-js/package.json` 里那份 `@cordisjs/plugin-loader` 声明仍是**死依赖**
  （该子项目只 import `cordis` 的 `Context`/`Service`；真正用 loader 的是本目录）。
  没有在这轮删它，是因为删它得重建它的 `package-lock.json`，而
  `npm install --package-lock-only` 会把 `cordis@^4.0.0-rc.9` 重解析到 rc.10 ——
  那是一次动 PluginPlayer JS 宿主运行时版本的独立改动，该单独做、单独验。

/**
 * S5-1 验收：**双跑对比** —— 宿主 `ctx.media.aggregate()` 必须与
 * `launcher /api/aggregate` 逐项一致。
 *
 * 为什么这不是「拿一个函数跟自己比」：
 *   `src/core/transport.mjs` 是从 `launcher/server.mjs` **移植**出来的独立实现
 *   （刻意不复用，见该文件顶部说明），两条代码路径各自独立地跑一遍，结果必须相同。
 *
 * 为了让对比有**真实数据**而不是「两边都连不上、报一样的错」，
 * 测试自己起 fixture：
 *   · 两个本地 HTTP 服务，分别扮演 localplayer 的 /api/list 与 PluginPlayer 的 /api/library
 *     （后者校验 X-PP-Token，顺带验证两侧都会带上令牌）
 *   · 一个临时媒体目录 + 真实的 `LocalFileSource` Python 子进程
 *   · 一个死端口，验证「来源故障时两侧的降级结果也一致」
 * 然后写一个**临时 patch 层**把三端来源都指向 fixture，宿主按正常合成流程启动。
 *
 * 报告写到 docs/s5-host-parity.json（与其它 docs/*.json 一样是实测产物）。
 *
 * 运行：node host/tests/parity.mjs
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

import { compose, HOST_DIR } from '../src/compose.mjs'
import { attachConsoleLogger } from '../src/logging.mjs'
import { writeReport } from './helpers/report.mjs'
import * as launcher from '../../launcher/server.mjs'

const PYTHON = 'F:/Python314/python.exe'
const TOKEN = 'parity-test-token-0123456789'
const REPORT = path.resolve(HOST_DIR, '..', 'docs', 's5-host-parity.json')

const results = []
let failures = 0
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail ?? null })
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined && detail !== null) console.log(`        ${detail}`)
}

/* ============================ fixture ============================ */

/** 造一批 MediaItem，两侧都应当原样报出来 */
function fixtureItems(prefix) {
  return [
    {
      id: `${prefix}-1`,
      uri: `http://127.0.0.1/fixture/${prefix}-1.mp4`,
      title: `${prefix} 一号`,
      artist: null,
      kind: 'video',
      durationMs: 12345,
      source: prefix === 'lp' ? 'localplayer' : 'pluginplayer',
      subtitleTracks: [{ index: 2, codec: 'subrip', lang: 'chi', title: '简体' }],
      thumbnail: null,
    },
    {
      id: `${prefix}-2`,
      uri: `http://127.0.0.1/fixture/${prefix}-2.mp3`,
      title: `${prefix} 二号`,
      artist: '全哥',
      kind: 'audio',
      durationMs: 6789,
      source: prefix === 'lp' ? 'localplayer' : 'pluginplayer',
      subtitleTracks: [],
      thumbnail: null,
    },
  ]
}

function startJsonServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = handler(req)
      if (body === undefined) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** 找一个当前没人监听的端口，用来验证两侧的故障降级是否一致 */
function findDeadPort() {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

/* ============================ 主流程 ============================ */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'puh-parity-'))
const mediaDir = path.join(tmpRoot, 'library')
fs.mkdirSync(mediaDir, { recursive: true })
for (const name of ['b 第二集.mp4', 'a 第一集.mkv', 'c 插曲.mp3', 'note.txt']) {
  fs.writeFileSync(path.join(mediaDir, name), '')
}

const lp = await startJsonServer(() => fixtureItems('lp'))
const pp = await startJsonServer((req) =>
  req.headers['x-pp-token'] === TOKEN ? fixtureItems('pp') : undefined,
)
const deadPort = await findDeadPort()

/** 与 launcher/config.json 同形的描述符（这就是 launcher 侧的输入） */
const descriptors = [
  {
    id: 'pluginplayer',
    label: 'PluginPlayer · 媒体库',
    list: { kind: 'http', url: `http://127.0.0.1:${pp.port}/api/library`, token: TOKEN, timeoutMs: 3000 },
    open: { kind: 'rpc', host: '127.0.0.1', port: 7911, token: TOKEN },
  },
  {
    id: 'localplayer',
    label: 'localplayer · 远端后端',
    list: { kind: 'http', url: `http://127.0.0.1:${lp.port}/api/list`, timeoutMs: 3000 },
    open: { kind: 'browser' },
  },
  {
    id: 'daily',
    label: 'daily_player · 本地目录',
    list: { kind: 'python', dir: mediaDir, moduleDir: 'daily_player', python: PYTHON, recursive: false, timeoutMs: 20000 },
    open: { kind: 'spawn', cmd: PYTHON, args: ['play.py'], cwd: 'daily_player' },
  },
  {
    id: 'dead',
    label: '死端口来源（故障降级对比）',
    list: { kind: 'http', url: `http://127.0.0.1:${deadPort}/api/list`, timeoutMs: 1200 },
    open: { kind: 'browser' },
  },
]

const hasPython = fs.existsSync(PYTHON)
if (!hasPython) {
  console.log(`！ 找不到 ${PYTHON}，daily 来源将以「目录枚举失败」形式参与对比（跳过条件已记录）`)
}

/** launcher 侧描述符 → 宿主 source 插件 config（两边最终会构造出同样的内部描述符） */
function hostConfigFrom(d) {
  const shared = { id: d.id, label: d.label, timeoutMs: d.list.timeoutMs, open: d.open }
  if (d.list.kind === 'http') return { ...shared, url: d.list.url, token: d.list.token, tokenFile: d.list.tokenFile }
  if (d.list.kind === 'python') {
    return { ...shared, dir: d.list.dir, moduleDir: d.list.moduleDir, python: d.list.python, recursive: d.list.recursive }
  }
  throw new Error(`parity 不支持 list.kind=${d.list.kind}`)
}

/* ---------- 宿主侧：写临时 patch 层，走正常合成 + 启动流程 ---------- */
// 三端来源在 bundles/sources.json 里已有，patch 只改它们的 config 指向 fixture；
// 「新增一个来源」这件事另用 `extras` 组验证（patch 层可以引入新条目与新分组）。
const patchFile = path.join(tmpRoot, 'parity-fixture.json')
fs.writeFileSync(
  patchFile,
  JSON.stringify(
    {
      $note: 'parity 测试生成的临时覆盖层：把三端来源指向 fixture，并额外挂一个死端口来源',
      entries: [
        ...descriptors.slice(0, 3).map((d) => ({ id: `sources:${d.id}`, config: hostConfigFrom(d) })),
        {
          id: 'extras',
          $group: true,
          name: './src/core/group.mjs',
          config: [{ id: 'dead', name: './src/sources/localplayer.mjs', config: hostConfigFrom(descriptors[3]) }],
        },
      ],
    },
    null,
    2,
  ),
)

const ctx = new Context()
ctx.baseUrl = pathToFileURL(path.join(HOST_DIR, 'cordis.json')).href
attachConsoleLogger(ctx)
await ctx.plugin(Loader, { baseUrl: ctx.baseUrl })

const composed = compose({ profile: 'desktop', patches: [patchFile] })
for (const entry of composed.entries) await ctx.loader.create(entry)
await ctx.loader.await()

check('宿主按「基座 → bundle → profile → patch」合成后，来源注册顺序与描述符一致',
  ctx.media.ids().join(',') === descriptors.map((d) => d.id).join(','),
  `media.ids() = ${JSON.stringify(ctx.media.ids())}`)

/* ---------- 两侧各跑一遍 ---------- */
const hostResult = await ctx.media.aggregate()
const launcherResult = await launcher.aggregate(descriptors)

const strip = ({ generatedAt, ...rest }) => rest
check('total 一致', hostResult.total === launcherResult.total,
  `host=${hostResult.total} launcher=${launcherResult.total}`)
check('total > 0（确认 fixture 真的产出了数据，不是「两边都空」）', hostResult.total > 0)

check('sources[] 状态逐项一致',
  JSON.stringify(hostResult.sources) === JSON.stringify(launcherResult.sources),
  JSON.stringify({ host: hostResult.sources, launcher: launcherResult.sources }))

check('items[] 逐项一致（顺序、字段、_end 标记）',
  JSON.stringify(hostResult.items) === JSON.stringify(launcherResult.items),
  hostResult.items.length === launcherResult.items.length
    ? JSON.stringify(hostResult.items.filter((it, i) => JSON.stringify(it) !== JSON.stringify(launcherResult.items[i])).slice(0, 2))
    : `长度不同 host=${hostResult.items.length} launcher=${launcherResult.items.length}`)

check('除 generatedAt 外整体一致',
  JSON.stringify(strip(hostResult)) === JSON.stringify(strip(launcherResult)))

/* ---------- planOpen 逐项对比（纯决策，无副作用） ---------- */
const planMismatches = []
for (const item of hostResult.items) {
  const src = descriptors.find((d) => d.id === item._end)
  const a = ctx.media.planOpen(item._end, item)
  const b = launcher.planOpen(src, item)
  if (JSON.stringify(a) !== JSON.stringify(b)) planMismatches.push({ item: item.id, host: a, launcher: b })
}
check(`planOpen 对全部 ${hostResult.items.length} 项一致`, planMismatches.length === 0,
  planMismatches.length ? JSON.stringify(planMismatches.slice(0, 2)) : '（含 rpc / browser / spawn 三种动作）')

/* ---------- 故障降级一致 ---------- */
const hostDead = hostResult.sources.find((s) => s.id === 'dead')
const launcherDead = launcherResult.sources.find((s) => s.id === 'dead')
check('来源不可达时两侧都降级为 ok=false / count=0，且不影响其它来源',
  hostDead?.ok === false && launcherDead?.ok === false && hostDead.count === 0 && launcherDead.count === 0
  && hostResult.total === launcherResult.total,
  `host.error=${hostDead?.error} / launcher.error=${launcherDead?.error}`)
check('两侧的故障文案一致', hostDead?.error === launcherDead?.error)

/* ---------- Token 真的带上了 ---------- */
check('PluginPlayer 来源带上了 X-PP-Token（fixture 会拒绝无令牌请求）',
  hostResult.sources.find((s) => s.id === 'pluginplayer')?.ok === true,
  JSON.stringify(hostResult.sources.find((s) => s.id === 'pluginplayer')))

/* ---------- 报告 ---------- */
const report = {
  schema: 'players-unified/s5-host-parity/1',
  generatedAt: new Date().toISOString(),
  profile: composed.profile,
  layers: composed.layerNames,
  fixtures: {
    localplayerUrl: descriptors[1].list.url,
    pluginplayerUrl: descriptors[0].list.url,
    pluginplayerTokenChecked: true,
    mediaDir,
    python: hasPython ? PYTHON : null,
    deadPort,
  },
  host: { total: hostResult.total, sources: hostResult.sources },
  launcher: { total: launcherResult.total, sources: launcherResult.sources },
  checks: results,
  passed: results.length - failures,
  failed: failures,
  conclusion: failures === 0 ? 'ctx.media.aggregate 与 launcher.aggregate 逐项一致' : '存在不一致，见 checks',
}
fs.mkdirSync(path.dirname(REPORT), { recursive: true })
writeReport(REPORT, report)

/* ---------- 清理 ---------- */
lp.server.close()
pp.server.close()
fs.rmSync(tmpRoot, { recursive: true, force: true })

console.log(`\n${failures === 0 ? '== 全部通过 ==' : '== 有失败项 =='}  ${results.length - failures}/${results.length}`)
process.exit(failures ? 1 : 0)

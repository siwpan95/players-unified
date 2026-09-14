/**
 * 统一启动器端到端验证（P2 / Phase 3）
 *
 * 真实起 HTTP 服务并用 fetch 打过去，验证：
 *   - 枚举聚合：三端（含一个不可用的来源）汇总，单项故障降级为 error 不拖垮整体
 *   - 深链跳转：按来源端给出正确的打开动作（dryRun 校验决策，不产生副作用）
 *
 * 零三方依赖。运行：node launcher/tests/e2e.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLauncher, REPO_ROOT } from '../server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PY = process.env.PYTHON_BIN || 'F:/Python314/python.exe'
const STUB_PORT = 59311      // 桩「远端后端」（模拟 localplayer /api/list）
const APP_PORT = 59312       // 启动器自身
const DEAD_PORT = 59999      // 必定连不上：用来验证单源故障降级

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/* ---- 1. 桩 localplayer 后端 ---- */
const STUB_ITEMS = [
  { id: 'lp-remote-0001', uri: 'http://127.0.0.1:5000/media/a.mp4', title: 'remote A', artist: null, kind: 'video', durationMs: null, source: 'remote', subtitleTracks: [], thumbnail: null },
  { id: 'lp-remote-0002', uri: 'http://127.0.0.1:5000/media/b.mp3', title: 'remote B', artist: null, kind: 'audio', durationMs: null, source: 'remote', subtitleTracks: [], thumbnail: null },
]
const stub = http.createServer((req, res) => {
  if (req.url === '/api/list') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(STUB_ITEMS))
    return
  }
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))

/* ---- 2. daily_player 来源：临时目录 + 真实 LocalFileSource（经 python）---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pu-launcher-'))
for (const fn of ['local one.mp4', 'local two.mp3', 'not-media.txt']) {
  fs.writeFileSync(path.join(tmp, fn), 'x')
}

const config = {
  port: APP_PORT,
  sources: [
    { id: 'localplayer', label: 'localplayer 桩', list: { kind: 'http', url: `http://127.0.0.1:${STUB_PORT}/api/list`, timeoutMs: 3000 }, open: { kind: 'browser' } },
    { id: 'daily', label: 'daily_player 本地', list: { kind: 'python', dir: tmp, moduleDir: path.join(REPO_ROOT, 'daily_player'), python: PY, recursive: true, timeoutMs: 20000 }, open: { kind: 'spawn', cmd: PY, args: ['play.py'], cwd: path.join(REPO_ROOT, 'daily_player') } },
    { id: 'dead', label: '不可用来源', list: { kind: 'http', url: `http://127.0.0.1:${DEAD_PORT}/api/list`, timeoutMs: 1500 }, open: { kind: 'none' } },
  ],
}

/* ---- 3. 起启动器 ---- */
const launcher = createLauncher(config)
await launcher.listen(APP_PORT)
const base = `http://127.0.0.1:${APP_PORT}`

try {
  /* ---- 4. 枚举聚合 ---- */
  const aggRes = await fetch(`${base}/api/aggregate`)
  assert(aggRes.status === 200, `GET /api/aggregate 应 200，实际 ${aggRes.status}`)
  const agg = await aggRes.json()

  const byId = Object.fromEntries(agg.sources.map((s) => [s.id, s]))
  assert(byId.localplayer.ok === true && byId.localplayer.count === 2,
    `桩来源应 ok 且 2 项，实际 ${JSON.stringify(byId.localplayer)}`)
  assert(byId.daily.ok === true && byId.daily.count === 2,
    `daily 来源应扫描到 2 个媒体（txt 不算），实际 ${JSON.stringify(byId.daily)}`)
  assert(byId.dead.ok === false && byId.dead.error,
    `不可用来源应标记 ok:false 并带 error，实际 ${JSON.stringify(byId.dead)}`)

  assert(agg.total === 4, `合计应 4 项，实际 ${agg.total}`)
  assert(agg.items.length === 4, `items 应 4 条，实际 ${agg.items.length}`)

  for (const it of agg.items) {
    for (const k of ['id', 'uri', 'title', 'kind', 'source']) {
      assert(k in it, `聚合项缺字段 ${k}：${JSON.stringify(it)}`)
    }
    assert(typeof it._end === 'string' && it._end, '聚合项应带 _end 来源标记')
  }
  const dailyItems = agg.items.filter((i) => i._end === 'daily')
  assert(dailyItems.every((i) => i.source === 'local-file'), 'daily 端产出的 source 应为 local-file')
  const stubItems = agg.items.filter((i) => i._end === 'localplayer')
  assert(stubItems.every((i) => i.source === 'remote'), '远端端产出的 source 应为 remote')

  /* ---- 5. 深链跳转（dryRun，只校验决策不产生副作用）---- */
  const post = async (body) => {
    const r = await fetch(`${base}/api/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: r.status, data: await r.json() }
  }

  // daily → spawn（把文件路径作为 play.py 的参数）
  const dailyOne = dailyItems[0]
  let r = await post({ id: dailyOne.id, dryRun: true })
  assert(r.status === 200, `open daily 应 200，实际 ${r.status}`)
  assert(r.data.ok === true, 'open daily 应 ok')
  assert(r.data.action.action === 'spawn', `daily 应为 spawn 动作，实际 ${r.data.action.action}`)
  assert(r.data.action.args[r.data.action.args.length - 1] === dailyOne.uri,
    `spawn 参数末位应是该媒体的 uri：${JSON.stringify(r.data.action.args)}`)
  assert(r.data.executed === false, 'dryRun 不应真正执行')

  // localplayer → browser
  const stubOne = stubItems[0]
  r = await post({ id: stubOne.id, dryRun: true })
  assert(r.data.action.action === 'browser', `远端应为 browser 动作，实际 ${r.data.action.action}`)
  assert(r.data.action.url === stubOne.uri, `browser url 应等于 uri：${r.data.action.url}`)

  // 未知 id → 404
  r = await post({ id: 'no-such-id', dryRun: true })
  assert(r.status === 404, `未知 id 应 404，实际 ${r.status}`)

  /* ---- 6. UI 首页 ---- */
  const home = await fetch(`${base}/`)
  assert(home.status === 200, `GET / 应 200，实际 ${home.status}`)
  const html = await home.text()
  assert(html.includes('统一启动器'), '首页应包含标题')

  console.log('[e2e] 聚合：4 项（daily 2 + 远端桩 2），不可用来源正确降级为 error ✅')
  console.log('[e2e] 深链：daily→spawn(play.py <uri>)、远端→browser(uri)、未知 id→404 ✅')
  console.log('[e2e] 统一启动器端到端全部断言通过 ✅')
} finally {
  await launcher.close()
  await new Promise((r) => stub.close(r))
  fs.rmSync(tmp, { recursive: true, force: true })
}

process.exit(0)

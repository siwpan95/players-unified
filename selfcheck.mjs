/**
 * players-unified 无头自检（不启动 launcher 服务、不开窗口）。
 *
 * 只 import 纯逻辑模块：launcher 的 planOpen/aggregate、合成器 compose、
 * schema 校验器、以及 host 手写 RFC6455 帧编解码。验证四件事：
 *
 *   1. 深链决策 planOpen：三种来源端各给出正确动作，未知配置降级为 none；
 *   2. MediaItem 契约校验：合法项通过、缺字段/坏枚举/坏类型被拒；
 *   3. 聚合与降级：本地假来源汇总出带 _end 标记的条目，故障来源降级为 error；
 *   4. 分层合成 compose：profile→bundle 铺开、patch 覆盖生效且 $layer 溯源正确；
 *   5. RFC6455 帧编解码往返：7/16/64 位长度、分片重组、close、未掩码拒绝。
 *
 * 用法：node selfcheck.mjs
 * 退出码：0 成功 / 1 失败。
 */

import http from 'node:http'
import { fileURLToPath } from 'node:url'

import { aggregate, planOpen } from './launcher/server.mjs'
import { compose, ComposeError } from './host/src/compose.mjs'
import { FrameDecoder, OPCODE, closePayload, encodeFrame } from './host/lib/ws.mjs'
import { validateMediaItem, validatePlayerState } from './schema/validate.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))

function fail(msg) {
  console.error('FAIL: ' + msg)
  process.exit(1)
}

/* ===================== 1. planOpen ===================== */

function checkPlanOpen() {
  const item = { id: 'i1', uri: 'G:/media/a.mp4', title: 'A', kind: 'video', source: 'local-file' }

  const rpc = planOpen({ open: { kind: 'rpc', host: '127.0.0.1', port: 7911 } }, item)
  if (rpc.action !== 'rpc' || rpc.method !== 'player.open') fail('rpc 决策不对：' + JSON.stringify(rpc))
  if (rpc.params?.path !== item.uri) fail('rpc 未把 uri 放进 params.path')
  if (rpc.port !== 7911) fail('rpc 端口丢失')

  const browser = planOpen({ open: { kind: 'browser' } }, item)
  if (browser.action !== 'browser' || browser.url !== item.uri) fail('browser 决策不对：' + JSON.stringify(browser))

  const spawn = planOpen(
    { open: { kind: 'spawn', cmd: 'python', args: ['play.py'], cwd: 'daily_player' } },
    item,
  )
  if (spawn.action !== 'spawn') fail('spawn 决策不对：' + JSON.stringify(spawn))
  if (spawn.args[0] !== 'play.py' || spawn.args[spawn.args.length - 1] !== item.uri) {
    fail('spawn 未把 uri 追加到 args 末尾：' + JSON.stringify(spawn.args))
  }
  if (!spawn.cwd || !spawn.cwd.endsWith('daily_player')) fail('spawn cwd 未解析成仓库内路径：' + spawn.cwd)

  const none = planOpen({ open: {} }, item)
  if (none.action !== 'none') fail('未配置打开方式时未降级为 none：' + JSON.stringify(none))
  return 4
}

/* ===================== 2. schema 校验 ===================== */

function checkSchema() {
  const good = {
    id: 'abc', uri: 'G:/media/a.mp3', title: 'A', artist: null, kind: 'audio',
    durationMs: 1234, source: 'local-file',
    subtitleTracks: [{ id: 's1', label: '中文', lang: 'zh', embedded: true }],
    thumbnail: null,
  }
  if (validateMediaItem(good) !== true) fail('合法 MediaItem 未通过校验')

  const rejects = [
    [{ ...good, title: undefined }, '缺必需字段 title 应被拒'],
    [{ ...good, kind: 'image' }, 'enum 外的 kind 应被拒'],
    [{ ...good, durationMs: '1234' }, 'durationMs 类型错误应被拒'],
    [{ ...good, subtitleTracks: [{ id: 's1' }] }, '字幕轨缺 label 应被拒'],
  ]
  for (const [bad, why] of rejects) {
    let threw = false
    try { validateMediaItem(bad) } catch { threw = true }
    if (!threw) fail(why)
  }

  let stateThrew = false
  try { validatePlayerState({ playing: 'yes', timeMs: 0 }) } catch { stateThrew = true }
  if (!stateThrew) fail('PlayerState.playing 类型错误应被拒')
  validatePlayerState({ playing: true, timeMs: 0, durationMs: null, rate: 1, volume: 80, muted: false, fullscreen: false })

  return 1 + rejects.length + 1
}

/* ===================== 3. aggregate 与降级 ===================== */

async function checkAggregate() {
  const items = [
    { id: 'a', uri: 'G:/media/a.mp3', title: 'A', kind: 'audio', source: 'local-file' },
    { id: 'b', uri: 'G:/media/b.mp4', title: 'B', kind: 'video', source: 'local-file' },
  ]
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(items))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const sources = [
      { id: 'fake', label: '假来源', list: { kind: 'http', url: `http://127.0.0.1:${port}/api/list` } },
      { id: 'broken', label: '故障来源', list: { kind: 'http', url: 'http://127.0.0.1:1/none', timeoutMs: 800 } },
    ]
    const result = await aggregate(sources)
    if (result.total !== items.length) fail('聚合总数不对：' + result.total)
    if (!result.items.every((it) => it._end === 'fake' && it._endLabel === '假来源')) {
      fail('聚合条目缺少 _end 来源标记：' + JSON.stringify(result.items[0]))
    }
    if (result.sources.length !== 2) fail('来源状态条数不对：' + result.sources.length)
    const fake = result.sources.find((s) => s.id === 'fake')
    const broken = result.sources.find((s) => s.id === 'broken')
    if (!fake?.ok || fake.count !== items.length) fail('正常来源状态不对：' + JSON.stringify(fake))
    if (broken?.ok !== false || !broken.error) fail('故障来源未降级为 error：' + JSON.stringify(broken))
    if (!result.generatedAt || Number.isNaN(Date.parse(result.generatedAt))) fail('generatedAt 不是合法时间')
    return { total: result.total, sources: result.sources.length }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/* ===================== 4. compose 分层合成 ===================== */

function flatten(entries, parent = '', out = []) {
  for (const e of entries) {
    const path = parent ? `${parent}:${e.id}` : e.id
    out.push({ path, entry: e })
    if (Array.isArray(e.config)) flatten(e.config, path, out)
  }
  return out
}

function checkCompose() {
  const base = compose({ profile: 'desktop' })
  if (base.layerNames[0] !== 'cordis.json') fail('合成层首层不是 cordis.json：' + base.layerNames[0])
  if (!base.layerNames.includes('bundles/sources.json')) fail('desktop profile 未铺开 sources bundle：' + base.layerNames)
  if (base.paths.length !== new Set(base.paths).size) fail('合成后存在重复分层路径')
  const flatBase = flatten(base.entries)
  const pp = flatBase.find((x) => x.path === 'sources:pluginplayer')
  if (!pp) fail('合成树里没有 sources:pluginplayer')
  if (pp.entry.config?.timeoutMs !== 3000) fail('bundle 里的 timeoutMs 不对：' + pp.entry.config?.timeoutMs)
  if (pp.entry.$layer !== 'bundles/sources.json') fail('未打 patch 时溯源层不对：' + pp.entry.$layer)
  for (const { entry, path } of flatBase) {
    if (!entry.$layer) fail(`${path} 缺少 $layer`)
    if (!base.layerNames.includes(entry.$layer)) fail(`${path} 的 $layer 不在层列表中：${entry.$layer}`)
  }

  const patched = compose({
    profile: 'desktop',
    patches: [HERE + 'host/patches/local-fast.json'],
  })
  const flatPatched = flatten(patched.entries)
  const pp2 = flatPatched.find((x) => x.path === 'sources:pluginplayer')
  if (pp2.entry.config?.timeoutMs !== 800) fail('patch 未覆盖 timeoutMs：' + pp2.entry.config?.timeoutMs)
  if (pp2.entry.config?.url !== pp.entry.config?.url) fail('patch 深合并把未覆盖的键弄丢了')
  if (pp2.entry.$layer !== 'patches/local-fast.json') fail('patch 覆盖后 $layer 不对：' + pp2.entry.$layer)

  let unknownThrew = false
  try { compose({ profile: 'no-such-profile' }) } catch (e) { unknownThrew = e instanceof ComposeError }
  if (!unknownThrew) fail('未知 profile 未抛 ComposeError')

  return { paths: base.paths.length, layers: base.layerNames.length }
}

/* ===================== 5. RFC6455 帧编解码 ===================== */

function checkWsFrames() {
  const plain = new FrameDecoder({ requireMask: false })
  const small = '你好，selfcheck'
  let ev = plain.push(encodeFrame(small))
  if (ev.length !== 1 || ev[0].op !== 'message' || ev[0].text !== small || ev[0].binary) {
    fail('短文本帧往返失败：' + JSON.stringify(ev.map((e) => e.op)))
  }

  // 16 位长度（126..65535）
  const mid = 'x'.repeat(60000)
  ev = plain.push(encodeFrame(mid))
  if (ev[0]?.text !== mid) fail('16 位长度帧往返失败')

  // 64 位长度（>=65536）走 127 分支
  const big = 'y'.repeat(70000)
  ev = plain.push(encodeFrame(big))
  if (ev[0]?.text !== big) fail('64 位长度帧往返失败')
  const rawBig = encodeFrame(big)
  if (rawBig[1] !== 127) fail('>=64KB 的帧未使用 127 长度分支')

  // 分片：FIN=0 + CONTINUATION，一次 push 两帧必须合成一条消息
  const decoder = new FrameDecoder({ requireMask: false })
  const twoFrames = Buffer.concat([
    encodeFrame('前半', { fin: false }),
    encodeFrame('后半', { opcode: OPCODE.CONTINUATION }),
  ])
  ev = decoder.push(twoFrames)
  if (ev.length !== 1 || ev[0].text !== '前半后半') fail('分片重组失败：' + JSON.stringify(ev.map((e) => e.op)))

  // close 帧
  ev = plain.push(encodeFrame(closePayload(1000, 'bye'), { opcode: OPCODE.CLOSE }))
  if (ev[0]?.op !== 'close' || ev[0].code !== 1000 || ev[0].reason !== 'bye') {
    fail('close 帧解析失败：' + JSON.stringify(ev))
  }

  // 掩码帧往返（客户端必须掩码）
  const masked = new FrameDecoder()
  ev = masked.push(encodeFrame('masked payload', { mask: true, maskKey: Buffer.from([9, 8, 7, 6]) }))
  if (ev[0]?.text !== 'masked payload') fail('掩码帧解掩码失败')

  // 未掩码帧必须被判协议错误（1002）
  const strict = new FrameDecoder()
  ev = strict.push(encodeFrame('no mask'))
  if (ev.length !== 1 || ev[0].op !== 'error' || ev[0].code !== 1002) {
    fail('未掩码帧未按 1002 拒绝：' + JSON.stringify(ev))
  }
  if (strict.push(encodeFrame('again')).length !== 0) fail('协议错误后解析器未自我标记为 dead')

  return 6
}

/* ===================== main ===================== */

async function main() {
  const nPlan = checkPlanOpen()
  const nSchema = checkSchema()
  const agg = await checkAggregate()
  const comp = checkCompose()
  const nWs = checkWsFrames()
  console.log(
    'selfcheck ok: planOpen %d 种动作 / MediaItem 契约 %d 项（含拒绝用例） / '
    + '聚合 %d 项且故障来源降级 / compose %d 条路径 %d 层（patch 覆盖 + 溯源正确） / '
    + 'RFC6455 帧 %d 组往返（7/16/64 位 + 分片 + 掩码 + close）',
    nPlan, nSchema, agg.total, comp.paths, comp.layers, nWs,
  )
  process.exit(0)
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)))

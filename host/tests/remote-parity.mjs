/**
 * S5-3 验收（二）：`/ws` 信令中继的**跨语言 A/B 对拍**。
 *
 * 同一份剧本、同一个客户端实现（Node 内置 undici WebSocket），分别打：
 *   A 侧：`localplayer/server.py`（Flask + flask-sock，即被替代的那个后端）
 *   B 侧：宿主 `/ws`（`lib/ws.mjs` 自写 RFC6455 + `src/web/signaling.mjs` 状态机）
 * 然后逐条比对**每个对端收到的消息序列**。这不是「读代码说一致」，是实跑对拍。
 *
 * 剧本特意覆盖了 python 那套「单槽位、后来者覆盖」语义里最容易写错的几处：
 *   · 发送端**晚于**接收端上线 → 发送端不会收到 viewer-count（只在 viewer 上线时发）
 *   · 第二个接收端上线 → 覆盖槽位；它掉线时槽位清空并通知 count:0
 *   · 第一个接收端此刻已成孤儿，它掉线时**仍会**再发一次 count:0（发送端连收两次 0）
 *   · 从未声明角色的连接，其消息按 python 逻辑中继给 **sender**
 *   · meta 既缓存又照常转发；晚加入的接收端能拿到缓存
 *   · 发送端掉线 → 只有当前槽位里的接收端收到 sender-gone
 *
 * 唯一有意保留的差异：非法消息（非 JSON 对象）两侧都会断开连接，但**关闭码不同**
 * （python 是抛异常断连 → 客户端看到 1006；宿主给明确码 1003）。该项单独断言、
 * 单独记录，不混进序列比对里。
 *
 * 报告写到 docs/s5-remote-parity.json。
 * 运行：node host/tests/remote-parity.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

import { compose, HOST_DIR } from '../src/compose.mjs'
import { attachConsoleLogger } from '../src/logging.mjs'

const PYTHON = 'F:/Python314/python.exe'
const LOCALPLAYER = path.resolve(HOST_DIR, '..', 'localplayer')
const REPORT = path.resolve(HOST_DIR, '..', 'docs', 's5-remote-parity.json')

const results = []
let failures = 0
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail ?? null })
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined && detail !== null) console.log(`        ${detail}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function waitPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) resolve(false)
        else setTimeout(attempt, 150)
      })
    }
    attempt()
  })
}

/* ============================ 剧本 ============================ */

/**
 * 跑完整剧本，返回 { received, closed, note }。
 * `received[对端]` 是该对端收到的**解析后**消息数组（按到达顺序）。
 */
async function runTranscript(base, label) {
  const received = {}
  const closed = {}
  const sockets = {}

  async function open(name, role) {
    received[name] = []
    const ws = new WebSocket(`${base}/ws`)
    sockets[name] = ws
    ws.addEventListener('message', (event) => {
      try {
        received[name].push(JSON.parse(event.data))
      } catch {
        received[name].push({ __unparsed: String(event.data) })
      }
    })
    ws.addEventListener('close', (event) => {
      closed[name] = event.code
    })
    ws.addEventListener('error', () => {
      if (closed[name] === undefined) closed[name] = -1
    })
    await new Promise((resolve) => {
      ws.addEventListener('open', resolve)
      setTimeout(resolve, 3000)
    })
    if (role) ws.send(JSON.stringify({ type: 'role', role }))
    return ws
  }

  /** 等到 name 的收件里出现满足 predicate 的消息（按**内容**等，不按条数 —— 条数会被前一步提前满足） */
  async function until(name, predicate, step, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate(received[name] ?? [])) return true
      await sleep(15)
    }
    missing.push(`${step}:${name}未等到期望消息（实收 ${JSON.stringify((received[name] ?? []).map((m) => m.type))}）`)
    return false
  }

  const has = (type) => (log) => log.some((m) => m.type === type)
  const hasCount = (count) => (log) => log.some((m) => m.type === 'viewer-count' && m.count === count)
  const hasCandidate = (id) => (log) => log.some((m) => m.type === 'candidate' && m.candidate?.candidate === id)

  const send = (name, payload) => sockets[name].send(typeof payload === 'string' ? payload : JSON.stringify(payload))
  const close = async (name) => {
    sockets[name].close(1000)
    await sleep(80)
  }

  const missing = []

  /* 1. viewer 单独上线：什么也不该收到 */
  await open('viewer', 'viewer')
  await sleep(150)

  /* 2. sender 上线：viewer 已在槽位 → 只给 sender 发 offer-request */
  await open('sender', 'sender')
  await until('sender', has('offer-request'), 'step2')

  /* 3. sender 报曲目元数据 → 转发给 viewer（并缓存） */
  send('sender', { type: 'meta', title: '第一集', artist: '某人' })
  await until('viewer', has('meta'), 'step3')

  /* 4. viewer 回 candidate → 转发给 sender */
  send('viewer', { type: 'candidate', candidate: { candidate: 'c1' } })
  await until('sender', hasCandidate('c1'), 'step4')

  /* 5. sender 发 answer → 转发给 viewer */
  send('sender', { type: 'answer', sdp: { type: 'answer', sdp: 'SDP-1' } })
  await until('viewer', has('answer'), 'step5')

  /* 6. 第二个 viewer 上线：覆盖槽位；sender 收到 count:1；viewer2 收到缓存的 meta */
  await open('viewer2', 'viewer')
  await until('sender', hasCount(1), 'step6')
  await until('viewer2', has('meta'), 'step6-meta')

  /* 7. viewer2 的 candidate 转发给 sender */
  send('viewer2', { type: 'candidate', candidate: { candidate: 'c2' } })
  await until('sender', hasCandidate('c2'), 'step7')

  /* 8. viewer2 掉线：它在槽位里 → 清空槽位 + count:0 */
  await close('viewer2')
  await until('sender', (log) => log.filter((m) => m.type === 'viewer-count' && m.count === 0).length >= 1, 'step8')

  /* 9. 孤儿 viewer（第一个）掉线：身份校验不过，槽位不动，但**仍**发一次 count:0 */
  await close('viewer')
  await until('sender', (log) => log.filter((m) => m.type === 'viewer-count' && m.count === 0).length >= 2, 'step9')

  /* 10. 第三个 viewer 上线：count:1 + 补发缓存 meta */
  await open('viewer3', 'viewer')
  await until('sender', (log) => log.filter((m) => m.type === 'viewer-count' && m.count === 1).length >= 2, 'step10')
  await until('viewer3', has('meta'), 'step10-meta')
  await until('sender', (log) => log.filter((m) => m.type === 'offer-request').length >= 3, 'step10-offer')

  /* 11. 从未声明角色的连接：它的消息按 python 语义中继给 sender */
  await open('anon')
  send('anon', { type: 'candidate', candidate: { candidate: 'anon1' } })
  await until('sender', hasCandidate('anon1'), 'step11', 4000)

  /* 12. sender 掉线：只有当前槽位里的 viewer3 收到 sender-gone */
  await close('sender')
  await until('viewer3', has('sender-gone'), 'step12')

  await sleep(300)

  /* 13. 非法消息（不是 JSON 对象）：两侧都应断开，但关闭码可以不同 */
  send('viewer3', 'this is not json')
  await sleep(600)
  const illegalClosed = closed.viewer3 !== undefined

  return { received, closed, missing, illegalClosed }
}

/* ============================ 起两侧 ============================ */

const pyPort = await freePort()
const hostPort = await freePort()

const pyLog = path.join(os.tmpdir(), `pu-py-${Date.now()}.log`)
const pyCode = [
  'import sys, os',
  `sys.path.insert(0, ${JSON.stringify(LOCALPLAYER)})`,
  `os.chdir(${JSON.stringify(LOCALPLAYER)})`,
  'import server',
  `server.app.run(host="127.0.0.1", port=${pyPort}, threaded=True, use_reloader=False, debug=False)`,
].join('\n')

const pyLogFd = fs.openSync(pyLog, 'w')
const py = spawn(PYTHON, ['-c', pyCode], { stdio: ['ignore', pyLogFd, pyLogFd], windowsHide: true })
const pyUp = await waitPort(pyPort)
check('A 侧 python/flask-sock 后端已起（被替代的那个）', pyUp, `port=${pyPort} log=${pyLog}`)

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pu-remote-'))
const patchFile = path.join(tmpDir, 'remote-patch.json')
fs.writeFileSync(patchFile, JSON.stringify({
  $note: 'remote-parity 测试生成',
  entries: [
    { id: 'web:server', config: { host: '127.0.0.1', port: hostPort } },
    { id: 'web:library', config: { dir: tmpDir } },
    { id: 'sources:pluginplayer', disabled: true },
    { id: 'sources:localplayer', disabled: true },
    { id: 'sources:daily', disabled: true },
  ],
}, null, 2))

const ctx = new Context()
ctx.baseUrl = pathToFileURL(path.join(HOST_DIR, 'cordis.json')).href
attachConsoleLogger(ctx, { level: 'silent' })
await ctx.plugin(Loader, { baseUrl: ctx.baseUrl })
for (const entry of compose({ profile: 'desktop', patches: [patchFile] }).entries) await ctx.loader.create(entry)
await ctx.loader.await()
await ctx.web.ready
check('B 侧宿主 /ws 已监听', ctx.web.port === hostPort, `port=${ctx.web.port}`)

/* ============================ 跑剧本 ============================ */

const pyResult = await runTranscript(`ws://127.0.0.1:${pyPort}`, 'python')
const hostResult = await runTranscript(`ws://127.0.0.1:${hostPort}`, 'host')

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

check('剧本两侧都没有踩到「期望条数没等到」的超时',
  pyResult.missing.length === 0 && hostResult.missing.length === 0,
  JSON.stringify({ python: pyResult.missing, host: hostResult.missing }))

const names = [...new Set([...Object.keys(pyResult.received), ...Object.keys(hostResult.received)])]
let mismatched = null
for (const name of names) {
  const a = pyResult.received[name] ?? null
  const b = hostResult.received[name] ?? null
  if (!same(a, b)) mismatched ??= { name, python: a, host: b }
}
check('每个对端收到的消息序列逐条一致（python vs 宿主）',
  mismatched === null,
  mismatched ? JSON.stringify(mismatched) : `${names.length} 个对端：${names.join(', ')}`)

/* 关键语义逐条单列（避免「整体一致」掩盖掉某一条恰好都没发） */
const senderLog = hostResult.received.sender
const counts = senderLog.filter((m) => m.type === 'viewer-count').map((m) => m.count)
check('语义锁：发送端晚于接收端上线 → 第一条是 offer-request（viewer 上线时不发 count:1）',
  senderLog[0]?.type === 'offer-request',
  JSON.stringify(senderLog.map((m) => `${m.type}${m.count !== undefined ? ':' + m.count : ''}`)))
check('语义锁：viewer 掉线两次都发 count:0（孤儿连接也发，与 python 一致）→ 序列为 1,0,0,1',
  JSON.stringify(counts) === JSON.stringify([1, 0, 0, 1]),
  JSON.stringify(counts))
check('语义锁：晚加入的接收端拿到缓存的 meta',
  hostResult.received.viewer2?.[0]?.type === 'meta' && hostResult.received.viewer2[0].title === '第一集'
  && hostResult.received.viewer3?.[0]?.type === 'meta',
  JSON.stringify(hostResult.received.viewer2?.[0]))
check('语义锁：meta 既缓存也照常转发给当前接收端',
  hostResult.received.viewer?.[0]?.type === 'meta',
  JSON.stringify(hostResult.received.viewer?.[0]))
check('语义锁：未声明角色者的消息按 python 语义中继给 sender',
  senderLog.some((m) => m.type === 'candidate' && m.candidate?.candidate === 'anon1'),
  JSON.stringify(senderLog.filter((m) => m.type === 'candidate').map((m) => m.candidate?.candidate)))
check('语义锁：发送端掉线只通知槽位里的接收端（viewer3），孤立的 viewer 不受影响',
  hostResult.received.viewer3?.some((m) => m.type === 'sender-gone')
  && !hostResult.received.viewer?.some((m) => m.type === 'sender-gone'),
  JSON.stringify({ viewer3: hostResult.received.viewer3?.map((m) => m.type), viewer: hostResult.received.viewer?.map((m) => m.type) }))

check('非法消息（非 JSON）两侧都断开连接（关闭码不同，见下一项）',
  hostResult.illegalClosed === true && pyResult.illegalClosed === true,
  JSON.stringify({ python: pyResult.closed.viewer3 ?? null, host: hostResult.closed.viewer3 ?? null }))
check('有意差异：宿主给明确关闭码 1003，python 是抛异常断连（客户端看到 1006）',
  hostResult.closed.viewer3 === 1003 && pyResult.closed.viewer3 !== 1003,
  JSON.stringify({ python: pyResult.closed.viewer3, host: hostResult.closed.viewer3 }))

/* 页面与扩展端零改动核对 */
const hostPageRes = await fetch(`http://127.0.0.1:${hostPort}/remote`)
const remotePage = await hostPageRes.text()
const pyPage = await (await fetch(`http://127.0.0.1:${pyPort}/remote`)).text()
const TOKENS = ['role', 'viewer', 'offer', 'answer', 'candidate', 'sender-gone', 'meta', 'location.host', '/ws']
const pyTokens = TOKENS.filter((t) => pyPage.includes(t))
const hostTokens = TOKENS.filter((t) => remotePage.includes(t))
check('观看页与 python 版同协议（关键 token 全在，客户端可与任一侧互通）',
  same(pyTokens, hostTokens) && hostTokens.length === TOKENS.length,
  JSON.stringify({ python: pyTokens.length, host: hostTokens.length, missing: TOKENS.filter((t) => !remotePage.includes(t)) }))
const hostCsp = hostPageRes.headers.get('content-security-policy') ?? ''
check('观看页带专用 CSP（放开内联脚本与同源 ws，否则页面脚本被 default-src \'none\' 挡死）',
  hostCsp.includes("script-src 'unsafe-inline'") && hostCsp.includes('connect-src') && hostCsp.includes(`ws://127.0.0.1:${hostPort}`),
  hostCsp.slice(0, 160))
const listCsp = (await fetch(`http://127.0.0.1:${hostPort}/api/list`)).headers.get('content-security-policy') ?? ''
check('对照：列表面仍是收紧的 default-src \'none\'（CSP 是按面给的，不是一刀切）',
  listCsp.startsWith("default-src 'none'") && !listCsp.includes('script-src'),
  listCsp.slice(0, 80))
check('扩展端的信令地址仍是 ws://127.0.0.1:5000/ws（bundle 默认端口未变 → 扩展零改动）',
  compose({ profile: 'desktop' }).entries
    .flatMap(function flat(e) { return e.config && Array.isArray(e.config) ? e.config.flatMap(flat) : [e] })
    .find((e) => e.id === 'server')?.config?.port === 5000,
  'bundle web-face → web:server → config.port')

/* ============================ 收尾 ============================ */

const report = {
  schema: 'players-unified/s5-remote-parity/1',
  generatedAt: new Date().toISOString(),
  sides: {
    python: { interpreter: PYTHON, entry: 'localplayer/server.py', stack: 'Flask + flask-sock', port: pyPort, log: pyLog },
    host: { entry: 'host/src/web/remote.mjs + host/src/web/signaling.mjs', transport: 'host/lib/ws.mjs（自写 RFC6455）', port: hostPort },
  },
  client: `Node 内置 undici WebSocket（${process.version}），两侧共用同一份剧本`,
  transcript: {
    python: pyResult.received,
    host: hostResult.received,
    closes: { python: pyResult.closed, host: hostResult.closed },
  },
  intentionalDifferences: [
    {
      item: '非法消息的关闭码',
      python: 'json.loads 抛异常 → 连接被带崩，客户端看到 1006',
      host: '显式以 1003（unsupported data）关闭',
      why: '携带明确关闭码便于定位；消息序列行为一致',
    },
    {
      item: '升级请求的 Origin 校验',
      python: '完全不校验（任意网页都能连上来当接收端）',
      host: '同源 + chrome-extension:// 放行，其余 403',
      why: '挡掉任意网页；放行扩展以保证 localplayer 零改动',
    },
  ],
  checks: results,
  passed: results.length - failures,
  failed: failures,
  conclusion: failures === 0
    ? '宿主 /ws 信令中继与 localplayer Flusk 后端在同一剧本下逐条一致；差异仅为有意收紧/明确化的两项'
    : '存在失败项，见 checks',
}
fs.mkdirSync(path.dirname(REPORT), { recursive: true })
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n', 'utf8')

await ctx.loader.remove('web')
fs.rmSync(tmpDir, { recursive: true, force: true })
try {
  py.kill()
} catch {
  /* ignore */
}
fs.closeSync(pyLogFd)

console.log(`\n${failures === 0 ? '== 全部通过 ==' : '== 有失败项 =='}  ${results.length - failures}/${results.length}`)
console.log(`报告： ${REPORT}`)
process.exit(failures ? 1 : 0)

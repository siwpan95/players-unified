/**
 * S5-3 验收（一）：`lib/ws.mjs` 手写 RFC6455 的**帧级**行为。
 *
 * 分四组：
 *   A 握手      —— 101 的每一个头、拒绝路径的每个状态码、Host/Origin 闸门、扩展来源放行
 *   B 真客户端  —— 用 Node 内置的 undici WebSocket（第三方实现）做双向互操作，
 *                  这是「我的编解码位布局是对的」的**独立锚点**
 *   C raw 客户端 —— 非法帧（undici 构造不出来）：未掩码/RSV/未知 opcode/控制帧分片/
 *                  非法 UTF-8/非法关闭码/跨分片切断的多字节字符
 *   D 纯单元    —— RFC 官方向量、encodeFrame 三种长度段、分块喂入等价性
 *
 * 报告写到 docs/s5-ws-rfc6455-report.json。
 * 运行：node host/tests/ws-rfc6455.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

import { compose, HOST_DIR } from '../src/compose.mjs'
import { attachConsoleLogger } from '../src/logging.mjs'
import { acceptKey, encodeFrame, FrameDecoder, OPCODE, CLOSE_CODE } from '../lib/ws.mjs'
import { rawConnect, sleep } from './helpers/raw-ws.mjs'
import { writeReport } from './helpers/report.mjs'

const REPORT = path.resolve(HOST_DIR, '..', 'docs', 's5-ws-rfc6455-report.json')
const ECHO = '/ws-echo'
const SMALL = '/ws-small'

const results = []
let failures = 0
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail ?? null })
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined && detail !== null) console.log(`        ${detail}`)
}

/* ============================ 起宿主 ============================ */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pu-ws-'))
const patchFile = path.join(tmpDir, 'ws-patch.json')
fs.writeFileSync(patchFile, JSON.stringify({
  $note: 'ws-rfc6455 测试生成：HTTP 面用内核分配端口，来源全停',
  entries: [
    { id: 'web:server', config: { host: '127.0.0.1', port: 0 } },
    { id: 'sources:pluginplayer', disabled: true },
    { id: 'sources:localplayer', disabled: true },
    { id: 'sources:daily', disabled: true },
  ],
}, null, 2))

const ctx = new Context()
ctx.baseUrl = pathToFileURL(path.join(HOST_DIR, 'cordis.json')).href
attachConsoleLogger(ctx, { level: 'silent' }) // 正常关闭时的 info 噪音不进断言输出
await ctx.plugin(Loader, { baseUrl: ctx.baseUrl })
for (const entry of compose({ profile: 'desktop', patches: [patchFile] }).entries) await ctx.loader.create(entry)
// 测试替身挂在 loader 根上（不进 bundle —— 它们是测试专用物，不该出现在正式配置里）
await ctx.loader.create({ id: 'echo', name: './tests/fixtures/ws-echo.mjs', config: { path: ECHO, maxPayload: 300000 } })
await ctx.loader.create({ id: 'echoSmall', name: './tests/fixtures/ws-echo.mjs', config: { path: SMALL, maxPayload: 256 } })
await ctx.loader.await()
await ctx.web.ready
const PORT = ctx.web.port
const BASE = `http://127.0.0.1:${PORT}`

/* ============================ A. 握手 ============================ */

// RFC6455 §1.3 的官方向量
check('A1 acceptKey 与 RFC6455 官方示例向量一致',
  acceptKey('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
  `得到 ${acceptKey('dGhlIHNhbXBsZSBub25jZQ==')}`)

const ok = await rawConnect({ port: PORT, urlPath: ECHO })
check('A2 正常握手 → 101 + Upgrade/Connection/Accept 头齐全',
  ok.status === 101
  && ok.headers.upgrade === 'websocket'
  && String(ok.headers.connection).toLowerCase() === 'upgrade'
  && ok.headers['sec-websocket-accept'] === acceptKey(ok.key),
  `${ok.status} accept=${ok.headers['sec-websocket-accept']}`)
ok.close()

const ext = await rawConnect({
  port: PORT, urlPath: ECHO,
  headers: { 'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits' },
})
check('A3 客户端请求 permessage-deflate 也不协商（101 里不出现该头）',
  ext.status === 101 && ext.headers['sec-websocket-extensions'] === undefined,
  `extensions=${ext.headers['sec-websocket-extensions'] ?? '(无)'}`)
ext.close()

// 注意：Node 只在「请求带 Upgrade 头」时才 emit('upgrade')。所以
//   · 完全没有 Upgrade 头 → 落到普通 HTTP 分派（由 /ws 的路由给提示，见 A4b）
//   · Upgrade 头存在但不是 websocket → 才会进协议校验并拿到 400
const notWs = await rawConnect({ port: PORT, urlPath: ECHO, headers: { Upgrade: 'h2c' } })
check('A4 Upgrade 头不是 websocket（h2c）→ 400', notWs.status === 400, `status=${notWs.status}`)
notWs.close()

const plainGet = await fetch(`${BASE}/ws`)
check('A4b 直接 GET /ws（无升级）→ 400 并给出人话提示',
  plainGet.status === 400 && (await plainGet.text()).includes('Upgrade'),
  `status=${plainGet.status}`)

const postWs = await fetch(`${BASE}/ws`, { method: 'POST' })
check('A4c POST 到 HTTP 面 → 405（方法闸门在 ctx.web 统一拦）', postWs.status === 405, `status=${postWs.status}`)

const badVersion = await rawConnect({ port: PORT, urlPath: ECHO, headers: { 'Sec-WebSocket-Version': '8' } })
check('A5 版本不是 13 → 426 且回 Sec-WebSocket-Version: 13',
  badVersion.status === 426 && badVersion.headers['sec-websocket-version'] === '13',
  `status=${badVersion.status} version=${badVersion.headers['sec-websocket-version']}`)
badVersion.close()

const badKey = await rawConnect({ port: PORT, urlPath: ECHO, key: 'short' })
check('A6 Sec-WebSocket-Key 不是 16 字节 → 400', badKey.status === 400, `status=${badKey.status}`)
badKey.close()

const notFoundPath = await rawConnect({ port: PORT, urlPath: '/nope' })
check('A7 没有处理器认领的路径 → 404', notFoundPath.status === 404, `status=${notFoundPath.status}`)
notFoundPath.close()

const badHost = await rawConnect({ port: PORT, urlPath: ECHO, headers: { Host: 'evil.example:1234' } })
check('A8 升级请求的 Host 不在白名单 → 403（挡 DNS rebinding）', badHost.status === 403, `status=${badHost.status}`)
badHost.close()

const badOrigin = await rawConnect({ port: PORT, urlPath: ECHO, headers: { Origin: 'https://evil.example' } })
check('A9 升级请求的 Origin 跨域 → 403（python 侧不看 Origin，这是收紧）', badOrigin.status === 403, `status=${badOrigin.status}`)
badOrigin.close()

const extOrigin = await rawConnect({ port: PORT, urlPath: ECHO, headers: { Origin: 'chrome-extension://abcdefghijklmnop' } })
check('A10 Origin 是 chrome-extension:// → 放行（localplayer 扩展零改动的前提）',
  extOrigin.status === 101, `status=${extOrigin.status}`)
extOrigin.close()

const loopOrigin = await rawConnect({ port: PORT, urlPath: ECHO, headers: { Origin: BASE } })
check('A11 Origin 同源 → 放行', loopOrigin.status === 101, `status=${loopOrigin.status}`)
loopOrigin.close()

/* ============================ B. 真客户端互操作（undici） ============================ */

function openWs(urlPath) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${urlPath}`)
  const log = []
  ws.binaryType = 'arraybuffer'
  ws.addEventListener('message', (e) => log.push({ type: 'message', data: e.data }))
  ws.addEventListener('close', (e) => log.push({ type: 'close', code: e.code, reason: e.reason }))
  ws.addEventListener('error', () => log.push({ type: 'error' }))
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(true))
    ws.addEventListener('error', () => reject(new Error('无法建立连接')))
    setTimeout(() => reject(new Error('打开超时')), 3000)
  })
  return { ws, log, opened }
}

{
  const { ws, log, opened } = openWs(ECHO)
  await opened
  ws.send('hello')
  await sleep(120)
  check('B1 文本往返（undici 真客户端 ↔ 手写服务端）',
    log.length === 1 && log[0].type === 'message' && log[0].data === 'hello',
    JSON.stringify(log.map((l) => l.data ?? l.type)))
  ws.close(1000)
  await sleep(120)
  const closed = log.find((l) => l.type === 'close')
  check('B2 客户端 close(1000) → 服务端回 1000（正常关闭握手）',
    closed?.code === 1000, `close=${JSON.stringify(closed)}`)
}

{
  const { ws, log, opened } = openWs(ECHO)
  await opened
  const text = '中文·emoji🧠·混排 abc'
  ws.send(text)
  ws.send('中'.repeat(100))
  await sleep(150)
  check('B3 多字节 UTF-8（中文/emoji）往返不被切坏',
    log[0]?.data === text && log[1]?.data === '中'.repeat(100),
    JSON.stringify(log.map((l) => (l.data ?? '').slice(0, 12))))
  ws.close(1000)
}

{
  const { ws, log, opened } = openWs(ECHO)
  await opened
  const a = 'A'.repeat(200) // 126..65535 → 2 字节扩展长度
  const b = 'B'.repeat(65536) // ≥ 65536 → 8 字节扩展长度
  ws.send(a)
  ws.send(b)
  await sleep(300)
  check('B4 200 字节（16 位长度段）与 65536 字节（64 位长度段）都原样往返',
    log[0]?.data === a && log[1]?.data === b,
    JSON.stringify({ got0: log[0]?.data?.length, got1: log[1]?.data?.length }))
  ws.close(1000)
}

{
  const { ws, log, opened } = openWs(ECHO)
  await opened
  const payload = new Uint8Array(64)
  for (let i = 0; i < payload.length; i++) payload[i] = i * 3
  ws.send(payload)
  await sleep(150)
  const got = log[0]?.data instanceof ArrayBuffer ? new Uint8Array(log[0].data) : null
  check('B5 二进制帧往返（含 0x00/0xff 边界字节）',
    got?.length === 64 && got.every((v, i) => v === i * 3),
    got ? `len=${got.length}` : JSON.stringify(log[0] ?? null))
  ws.close(1000)
}

/* ============================ C. raw 客户端：非法帧 ============================ */

/** 每个用例：连上 → 发畸形帧 → 断言服务端用哪个码关闭 */
async function expectClose(name, sendFn, code, extra = () => true, urlPath = ECHO) {
  const client = await rawConnect({ port: PORT, urlPath })
  if (client.status !== 101) {
    check(name, false, `握手失败 status=${client.status}`)
    client.close()
    return
  }
  sendFn(client)
  await client.waitFor((events) => events.some((e) => e.op === 'close' || e.op === 'error'), 1200)
  const closed = client.events.find((e) => e.op === 'close')
  const errored = client.events.find((e) => e.op === 'error')
  check(name, closed?.code === code && extra(client),
    `close=${closed?.code ?? '(无)'} error=${errored ? `${errored.code}:${errored.reason}` : '(无)'}`)
  client.close()
}

await expectClose('C1 未掩码的客户端文本帧 → 1002（RFC 要求客户端必须掩码）',
  (c) => c.write(encodeFrame('unmasked', { opcode: OPCODE.TEXT, mask: false })),
  CLOSE_CODE.PROTOCOL_ERROR)

// RSV 位只能手工置位（encodeFrame 对 rsv 是显式拒绝的，无法用它构造非法帧）
{
  const client = await rawConnect({ port: PORT, urlPath: ECHO })
  const frame = encodeFrame('x', { opcode: OPCODE.TEXT, mask: true })
  frame[0] |= 0x40 // RSV1
  client.write(frame)
  await client.waitFor((e) => e.some((x) => x.op === 'close'), 1200)
  check('C2 RSV1 位非零（未协商任何扩展）→ 1002',
    client.of('close')[0]?.code === CLOSE_CODE.PROTOCOL_ERROR,
    `close=${client.of('close')[0]?.code}`)
  client.close()
}

await expectClose('C3 未知 opcode 0x3 → 1002',
  (c) => c.write(encodeFrame('x', { opcode: 0x3, mask: true })), CLOSE_CODE.PROTOCOL_ERROR)

await expectClose('C4 控制帧被分片（ping FIN=0）→ 1002',
  (c) => c.write(encodeFrame('p', { opcode: OPCODE.PING, mask: true, fin: false })), CLOSE_CODE.PROTOCOL_ERROR)

await expectClose('C5 控制帧载荷 126 字节 → 1002',
  (c) => c.write(encodeFrame('p'.repeat(126), { opcode: OPCODE.PING, mask: true })), CLOSE_CODE.PROTOCOL_ERROR)

await expectClose('C6 没有开始分片就发 CONTINUATION → 1002',
  (c) => c.write(encodeFrame('x', { opcode: OPCODE.CONTINUATION, mask: true })), CLOSE_CODE.PROTOCOL_ERROR)

await expectClose('C7 文本帧非法 UTF-8（0xC3 0x28）→ 1007',
  (c) => c.write(encodeFrame(Buffer.from([0xc3, 0x28]), { opcode: OPCODE.TEXT, mask: true })), CLOSE_CODE.INVALID_PAYLOAD)

await expectClose('C8 close 帧只有 1 字节载荷 → 1002',
  (c) => c.write(encodeFrame(Buffer.from([0x03]), { opcode: OPCODE.CLOSE, mask: true })), CLOSE_CODE.PROTOCOL_ERROR)

await expectClose('C9 close code 1004（保留值）→ 1002',
  (c) => c.write(encodeFrame(Buffer.from([0x03, 0xec]), { opcode: OPCODE.CLOSE, mask: true })), CLOSE_CODE.PROTOCOL_ERROR)

await expectClose('C10 超过 maxPayload（/ws-small 上限 256，发 300）→ 1009',
  (c) => c.write(encodeFrame('S'.repeat(300), { opcode: OPCODE.TEXT, mask: true })),
  CLOSE_CODE.TOO_LARGE, () => true, SMALL)

/* ---- 合法但刁钻的帧：必须正常处理 ---- */

{
  const client = await rawConnect({ port: PORT, urlPath: ECHO })
  client.write(encodeFrame('he', { opcode: OPCODE.TEXT, mask: true, fin: false }))
  client.write(encodeFrame('llo', { opcode: OPCODE.CONTINUATION, mask: true, fin: true }))
  await client.waitFor((e) => e.some((x) => x.op === 'message'), 1200)
  check('C11 分片消息（he + llo）重组为 hello',
    client.of('message')[0]?.text === 'hello' && client.of('close').length === 0,
    JSON.stringify(client.of('message').map((m) => m.text)))
  client.close()
}

{
  const client = await rawConnect({ port: PORT, urlPath: ECHO })
  // 「中」= E4 B8 AD，故意切成 1+2 两片：跨分片切断多字节字符是合法输入
  const zhong = Buffer.from('中', 'utf8')
  client.write(encodeFrame(zhong.subarray(0, 1), { opcode: OPCODE.TEXT, mask: true, fin: false }))
  client.write(encodeFrame(zhong.subarray(1), { opcode: OPCODE.CONTINUATION, mask: true, fin: true }))
  await client.waitFor((e) => e.some((x) => x.op === 'message'), 1200)
  check('C12 多字节字符被切在两个分片之间，重组后仍是合法 UTF-8',
    client.of('message')[0]?.text === '中' && client.of('close').length === 0,
    JSON.stringify(client.of('message').map((m) => m.text)))
  client.close()
}

{
  const client = await rawConnect({ port: PORT, urlPath: ECHO })
  client.write(encodeFrame('frag', { opcode: OPCODE.TEXT, mask: true, fin: false }))
  client.write(encodeFrame(Buffer.from('PING'), { opcode: OPCODE.PING, mask: true })) // 分片之间插控制帧
  client.write(encodeFrame('-end', { opcode: OPCODE.CONTINUATION, mask: true, fin: true }))
  await client.waitFor((e) => e.some((x) => x.op === 'message'), 1200)
  const pong = client.of('pong')[0]
  const message = client.of('message')[0]
  check('C13 分片之间插入 ping：先回 pong（载荷一致）再给完整消息',
    pong?.payload?.toString() === 'PING' && message?.text === 'frag-end',
    `pong=${pong?.payload?.toString()} message=${message?.text}`)
  client.close()
}

{
  const client = await rawConnect({ port: PORT, urlPath: ECHO })
  const payload = Buffer.from('P'.repeat(125)) // 控制帧载荷上限
  client.write(encodeFrame(payload, { opcode: OPCODE.PING, mask: true }))
  await client.waitFor((e) => e.some((x) => x.op === 'pong'), 1200)
  check('C14 ping 载荷 125 字节（上限）→ pong 原样回 125 字节',
    client.of('pong')[0]?.payload?.length === 125
    && client.of('pong')[0]?.payload?.equals(payload),
    `len=${client.of('pong')[0]?.payload?.length}`)
  client.close()
}

{
  const client = await rawConnect({ port: PORT, urlPath: ECHO })
  client.write(encodeFrame(Buffer.from([0x03, 0xe8]), { opcode: OPCODE.CLOSE, mask: true })) // close 1000
  await client.waitFor((e) => e.some((x) => x.op === 'close'), 1200)
  check('C15 收到对端 close(1000) → 回 close(1000)',
    client.of('close')[0]?.code === 1000,
    `close=${client.of('close')[0]?.code}`)
  client.close()
}

/* ============================ D. 纯单元 ============================ */

{
  const f1 = encodeFrame('abc', { opcode: OPCODE.TEXT, mask: false })
  const f2 = encodeFrame('x'.repeat(200), { opcode: OPCODE.TEXT, mask: false })
  const f3 = encodeFrame('y'.repeat(65536), { opcode: OPCODE.TEXT, mask: false })
  const key = Buffer.from([1, 2, 3, 4])
  const f4 = encodeFrame('abc', { opcode: OPCODE.TEXT, mask: true, maskKey: key })
  check('D1 encodeFrame 三种长度段的头布局 + 掩码位/掩码键正确',
    f1.length === 2 + 3 && f1[1] === 3
    && f2.length === 4 + 200 && f2[1] === 126 && f2.readUInt16BE(2) === 200
    && f3.length === 10 + 65536 && f3[1] === 127 && Number(f3.readBigUInt64BE(2)) === 65536
    && f4[1] === 0x80 | 3 && f4.subarray(2, 6).equals(key)
    && f4[6] === ('a'.charCodeAt(0) ^ 1),
    JSON.stringify({ f1: [f1[1], f1.length], f2: [f2[1], f2.readUInt16BE(2)], f3: [f3[1], Number(f3.readBigUInt64BE(2))] }))
}

{
  // 分块喂入（每次 1 字节）必须与整块喂入解析出同样的结果
  const whole = encodeFrame('分块喂入🧠', { opcode: OPCODE.TEXT, mask: true, maskKey: Buffer.from([9, 9, 9, 9]) })
  const atOnce = new FrameDecoder({ requireMask: true }).push(whole)
  const dec = new FrameDecoder({ requireMask: true })
  const bytewise = []
  for (let i = 0; i < whole.length; i++) bytewise.push(...dec.push(whole.subarray(i, i + 1)))
  const atOnceText = atOnce.filter((e) => e.op === 'message').map((e) => e.text)
  const bytewiseText = bytewise.filter((e) => e.op === 'message').map((e) => e.text)
  check('D2 逐字节喂入与整块喂入结果一致（流式解析无状态泄漏）',
    atOnceText[0] === '分块喂入🧠' && JSON.stringify(bytewiseText) === JSON.stringify(atOnceText),
    JSON.stringify({ atOnceText, bytewiseText, chunks: whole.length }))
}

{
  const dec = new FrameDecoder({ requireMask: true })
  const events = dec.push(encodeFrame('ok', { opcode: OPCODE.TEXT, mask: false })) // 未掩码 → error
  const after = dec.push(encodeFrame('ok', { opcode: OPCODE.TEXT, mask: true }))
  check('D3 出现协议错误后解析器自我失效（后续 push 不再解析半截数据）',
    events[0]?.op === 'error' && events[0]?.code === CLOSE_CODE.PROTOCOL_ERROR && after.length === 0,
    `first=${events[0]?.op}/${events[0]?.code} after=${after.length}`)
}

/* ============================ 收尾 ============================ */

const wsChecks = results.filter((r) => /^(A|B|C|D)\d/.test(r.name)).length
const report = {
  schema: 'players-unified/s5-ws-rfc6455/1',
  generatedAt: new Date().toISOString(),
  implementation: 'host/lib/ws.mjs（零依赖手写 RFC6455 服务端）',
  anchors: {
    rfcVector: 'acceptKey("dGhlIHNhbXBsZSBub25jZQ==") === "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="（RFC6455 §1.3 官方示例）',
    independentClient: `Node 内置 undici WebSocket（${process.version}）—— 第三方实现的真客户端，用于双向互操作`,
    rawClient: 'host/tests/helpers/raw-ws.mjs —— 只用 encodeFrame/FrameDecoder 构造非法帧',
  },
  interoperability: {
    text: true,
    utf8: true,
    lengthSegments: ['<126', '126..65535', '>=65536'],
    binary: true,
    permessageDeflate: '未协商（101 不含该头），双方均不压缩',
  },
  checks: results,
  passed: results.length - failures,
  failed: failures,
  wsChecks,
  conclusion: failures === 0
    ? '手写 RFC6455 通过帧级验收：与 undici 真客户端双向互操作，非法帧按 RFC 用 1002/1007/1009 关闭'
    : '存在失败项，见 checks',
}
fs.mkdirSync(path.dirname(REPORT), { recursive: true })
writeReport(REPORT, report)

for (const id of ['echo', 'echoSmall', 'web']) await ctx.loader.remove(id)
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log(`\n${failures === 0 ? '== 全部通过 ==' : '== 有失败项 =='}  ${results.length - failures}/${results.length}`)
process.exit(failures ? 1 : 0)

/**
 * S5-2 验收：宿主列表面（`src/web/library-face.mjs` + `src/web/library-core.mjs`）
 * 必须与 `localplayer/server.py` 的 Flask 后端**同输出**。
 *
 * 真值取法：直接跑 python 的 `media_lib.build_media_items()`（扩展端实际消费的那个函数），
 * 与 JS 移植版逐字段比对。**不 import python 来当实现** —— 那样就不是对比了。
 * 另外用真实 HTTP 请求验证运行时行为：字节、Content-Type、Range、路径穿越防护、
 * Host/Origin 白名单、404/204。
 *
 * 报告写到 docs/s5-library-face-report.json。
 *
 * 运行：node host/tests/library-parity.mjs
 */

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

import { compose, HOST_DIR } from '../src/compose.mjs'
import { attachConsoleLogger } from '../src/logging.mjs'
import { buildMediaItems } from '../src/web/library-core.mjs'
import { parseRange } from '../src/web/library-face.mjs'

const PYTHON = 'F:/Python314/python.exe'
const REPORT = path.resolve(HOST_DIR, '..', 'docs', 's5-library-face-report.json')

const results = []
let failures = 0
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail ?? null })
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined && detail !== null) console.log(`        ${detail}`)
}

async function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

/** 绕开客户端 URL 归一化，原样发一行请求 —— 用来真发 `../` 做穿越测试 */
function rawRequest(port, requestLine, headers = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port })
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => {
      const lines = [requestLine, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), 'Connection: close', '', '']
      sock.write(lines.join('\r\n'))
    })
    sock.on('data', (d) => { buf += d })
    sock.on('end', () => resolve(buf))
    sock.on('error', reject)
  })
}

/* ============================ fixture ============================ */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'puh-lib-'))
const mediaDir = path.join(tmpRoot, 'media')
fs.mkdirSync(mediaDir)
const FILES = ['a 第一集.mkv', 'b 第二集.mp4', 'c 插曲.mp3', 'd 视频.webm', 'e 歌.flac', 'F 大写.MP4']
for (const [i, fn] of FILES.entries()) fs.writeFileSync(path.join(mediaDir, fn), `payload-${i}-`.repeat(50))
fs.writeFileSync(path.join(mediaDir, 'note.txt'), '不是媒体')
// 契约锁：python 侧只看扩展名、不判断 isfile，所以名叫 fake.mp4 的**目录**也会入列
fs.mkdirSync(path.join(mediaDir, 'fake.mp4'))
// 非递归：子目录里的媒体文件不应入列
fs.mkdirSync(path.join(mediaDir, 'sub'))
fs.writeFileSync(path.join(mediaDir, 'sub', 'inner.mp4'), 'inner')
const SECRET = path.join(tmpRoot, 'secret.txt')
fs.writeFileSync(SECRET, 'TOP SECRET')

const port = await freePort()
const BASE = `http://127.0.0.1:${port}`

/* ============================ python 真值 ============================ */

const pyCode = [
  'import sys, json',
  `sys.path.insert(0, ${JSON.stringify(path.resolve(HOST_DIR, '..', 'localplayer'))})`,
  'from media_lib import build_media_items',
  'print(json.dumps(build_media_items(sys.argv[1], sys.argv[2]), ensure_ascii=False))',
].join('\n')

const py = spawnSync(PYTHON, ['-c', pyCode, mediaDir, BASE], { encoding: 'utf8', windowsHide: true })
if (py.status !== 0) {
  console.error(`python 真值取不到（${PYTHON}）：\n${py.stderr}`)
  process.exit(2)
}
const pythonItems = JSON.parse(py.stdout)
check('python 真值取到（media_lib.build_media_items）', pythonItems.length > 0, `python 列出 ${pythonItems.length} 项`)

/* ============================ 宿主侧 ============================ */

const patchFile = path.join(tmpRoot, 'lib-patch.json')
fs.writeFileSync(
  patchFile,
  JSON.stringify({
    $note: 'library-parity 测试生成',
    entries: [
      { id: 'web:server', config: { host: '127.0.0.1', port } },
      { id: 'web:library', config: { dir: mediaDir } },
      { id: 'sources:pluginplayer', disabled: true },
      { id: 'sources:localplayer', disabled: true },
      { id: 'sources:daily', disabled: true },
    ],
  }, null, 2),
)

const ctx = new Context()
ctx.baseUrl = pathToFileURL(path.join(HOST_DIR, 'cordis.json')).href
attachConsoleLogger(ctx)
await ctx.plugin(Loader, { baseUrl: ctx.baseUrl })
for (const entry of compose({ profile: 'desktop', patches: [patchFile] }).entries) await ctx.loader.create(entry)
await ctx.loader.await()
await ctx.web.ready // 等监听真正就绪（不要靠 sleep 猜）

/* ---------- 1. 纯 core vs python ---------- */
const jsItems = buildMediaItems(mediaDir, BASE)
check('纯 core 与 python media_lib 逐字段一致',
  JSON.stringify(jsItems) === JSON.stringify(pythonItems),
  JSON.stringify({
    js: jsItems.length, python: pythonItems.length,
    diff: jsItems.findIndex((it, i) => JSON.stringify(it) !== JSON.stringify(pythonItems[i])),
  }))
check('键顺序也一致（不是「内容相同但顺序不同」）',
  jsItems.every((it, i) => Object.keys(it).join(',') === Object.keys(pythonItems[i]).join(',')))
check('契约锁：非媒体扩展名被跳过', !jsItems.some((it) => it.name === 'note.txt'))
check('契约锁：子目录内的媒体不入列（非递归）', !jsItems.some((it) => it.name === 'inner.mp4'))
check('契约锁：名叫 fake.mp4 的目录也入列（与 python 侧同样不判断 isfile）',
  jsItems.some((it) => it.name === 'fake.mp4') === pythonItems.some((it) => it.name === 'fake.mp4'))
check('契约锁：大写扩展名同样识别为 video', jsItems.find((it) => it.name === 'F 大写.MP4')?.kind === 'video')
check('过渡别名 name/type/path 都在', jsItems.every((it) => it.name && it.type && it.path))

/* ---------- 2. HTTP 端点 ---------- */
const listRes = await fetch(`${BASE}/api/list`)
const listText = await listRes.text()
const httpItems = JSON.parse(listText)
check('GET /api/list 返回 200 + application/json',
  listRes.status === 200 && String(listRes.headers.get('content-type')).startsWith('application/json'),
  `status=${listRes.status} ctype=${listRes.headers.get('content-type')}`)
check('GET /api/list 内容与 python 真值一致', JSON.stringify(httpItems) === JSON.stringify(pythonItems))
check('GET /api/list 带安全头',
  listRes.headers.get('x-content-type-options') === 'nosniff'
  && listRes.headers.get('x-frame-options') === 'DENY'
  && !!listRes.headers.get('content-security-policy'),
  JSON.stringify({
    nosniff: listRes.headers.get('x-content-type-options'),
    frame: listRes.headers.get('x-frame-options'),
  }))
check('GET /api/list 不带任何 CORS 头（跨域预检必然失败）',
  listRes.headers.get('access-control-allow-origin') === null)

/* ---------- 3. 文件服务：字节 / 类型 / Range ---------- */
const target = 'b 第二集.mp4'
const diskBytes = fs.readFileSync(path.join(mediaDir, target))
const fileRes = await fetch(`${BASE}/media/${encodeURIComponent(target)}`)
const gotBytes = Buffer.from(await fileRes.arrayBuffer())
check('GET /media/<file> 字节与磁盘完全一致并标出 video/mp4',
  fileRes.status === 200 && fileRes.headers.get('content-type') === 'video/mp4' && gotBytes.equals(diskBytes),
  `status=${fileRes.status} ctype=${fileRes.headers.get('content-type')} len=${gotBytes.length}/${diskBytes.length}`)

const rangeRes = await fetch(`${BASE}/media/${encodeURIComponent(target)}`, { headers: { Range: 'bytes=10-19' } })
const rangeBytes = Buffer.from(await rangeRes.arrayBuffer())
check('Range 请求返回 206 + Content-Range + 正确切片（python 侧没有，宿主增强）',
  rangeRes.status === 206
  && rangeRes.headers.get('content-range') === `bytes 10-19/${diskBytes.length}`
  && rangeBytes.equals(diskBytes.subarray(10, 20)),
  `status=${rangeRes.status} content-range=${rangeRes.headers.get('content-range')}`)
check('parseRange 单元：开区间 / 后缀区间 / 越界与非法值',
  JSON.stringify(parseRange('bytes=10-19', 100)) === JSON.stringify({ start: 10, end: 19 })
  && JSON.stringify(parseRange('bytes=10-', 100)) === JSON.stringify({ start: 10, end: 99 })
  && JSON.stringify(parseRange('bytes=-10', 100)) === JSON.stringify({ start: 90, end: 99 })
  && parseRange('bytes=50-10', 100) === null
  && parseRange('bytes=200-300', 100) === null
  && parseRange('items=0-1', 100) === null
  && parseRange(undefined, 100) === null,
  JSON.stringify([parseRange('bytes=10-19', 100), parseRange('bytes=-10', 100), parseRange('bytes=200-300', 100)]))

/* ---------- 4. 路径穿越 ---------- */
const encTraversal = await fetch(`${BASE}/media/..%2F..%2Fsecret.txt`)
check('路径穿越（URL 编码 %2F）被拒', encTraversal.status === 403 || encTraversal.status === 404,
  `status=${encTraversal.status}`)
const rawTraversal = await rawRequest(port, 'GET /media/../../secret.txt HTTP/1.1', { Host: `127.0.0.1:${port}` })
check('路径穿越（原样 ../，绕开客户端归一化）被拒，且不泄露内容',
  /^HTTP\/1\.1 (403|404)/.test(rawTraversal) && !rawTraversal.includes('TOP SECRET'),
  rawTraversal.split('\r\n')[0])
const encSlash = await rawRequest(port, 'GET /media/..%5C..%5Csecret.txt HTTP/1.1', { Host: `127.0.0.1:${port}` })
check('路径穿越（反斜杠变体 %5C）同样被拒',
  /^HTTP\/1\.1 (403|404)/.test(encSlash) && !encSlash.includes('TOP SECRET'),
  encSlash.split('\r\n')[0])

/* ---------- 5. Host / Origin 白名单 ---------- */
const badHost = await rawRequest(port, 'GET /api/list HTTP/1.1', { Host: 'evil.example:1234' })
check('Host 头不在白名单 → 403（挡 DNS rebinding）', /^HTTP\/1\.1 403/.test(badHost), badHost.split('\r\n')[0])
const badOrigin = await fetch(`${BASE}/api/list`, { headers: { Origin: 'http://evil.example' } })
check('Origin 头跨域 → 403（挡 CSRF）', badOrigin.status === 403, `status=${badOrigin.status}`)
const preflight = await fetch(`${BASE}/api/list`, { method: 'OPTIONS' })
check('OPTIONS 预检不通过 → 405', preflight.status === 405, `status=${preflight.status}`)

/* ---------- 6. 其它 ---------- */
const favicon = await fetch(`${BASE}/favicon.ico`)
check('GET /favicon.ico → 204（与 python 侧一致）', favicon.status === 204, `status=${favicon.status}`)
const notFound = await fetch(`${BASE}/api/nope`)
check('未知路径 → 404', notFound.status === 404, `status=${notFound.status}`)
const missing = await fetch(`${BASE}/media/nope.mp4`)
check('不存在的媒体文件 → 404', missing.status === 404, `status=${missing.status}`)
const index = await fetch(`${BASE}/`)
check('GET / 返回说明页', index.status === 200 && (await index.text()).includes('媒体清单面'))

/* ---------- 7. 扩展端零改动核对 ---------- */
const manifest = JSON.parse(fs.readFileSync(path.resolve(HOST_DIR, '..', 'localplayer', 'manifest.json'), 'utf8'))
const hostPerms = manifest.host_permissions ?? []
check('扩展的 host_permissions 覆盖宿主监听地址（端口与 python 侧一致：5000 为默认）',
  hostPerms.some((p) => /127\.0\.0\.1|localhost/.test(p)),
  `host_permissions=${JSON.stringify(hostPerms)}`)
const descriptor = compose({ profile: 'desktop' }).entries
  .flatMap(function flat(e) { return e.config && Array.isArray(e.config) ? e.config.flatMap(flat) : [e] })
  .find((e) => e.id === 'server')
check('bundle 里 HTTP 面默认端口 = 5000（与 Flask 后端一致，扩展不用改配置）',
  descriptor?.config?.port === 5000, `config=${JSON.stringify(descriptor?.config)}`)

/* ---------- 报告 ---------- */
const report = {
  schema: 'players-unified/s5-library-face/1',
  generatedAt: new Date().toISOString(),
  python: { interpreter: PYTHON, module: 'localplayer/media_lib.py', items: pythonItems.length },
  js: { core: 'host/src/web/library-core.mjs', face: 'host/src/web/library-face.mjs', items: jsItems.length },
  fixture: { mediaDir, files: FILES, quirks: ['目录 fake.mp4 入列', '子目录不递归', 'note.txt 跳过', '大写扩展名识别'] },
  parity: {
    coreEqualsPython: JSON.stringify(jsItems) === JSON.stringify(pythonItems),
    httpEndpointEqualsPython: JSON.stringify(httpItems) === JSON.stringify(pythonItems),
  },
  checks: results,
  passed: results.length - failures,
  failed: failures,
  conclusion: failures === 0
    ? '宿主列表面与 localplayer Flask 后端同输出，且安全防护与 Range 行为已实测'
    : '存在失败项，见 checks',
}
fs.mkdirSync(path.dirname(REPORT), { recursive: true })
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n', 'utf8')

/* ---------- 清理（触发器：先关宿主再删临时目录） ---------- */
await ctx.loader.remove('web')
fs.rmSync(tmpRoot, { recursive: true, force: true })

console.log(`\n${failures === 0 ? '== 全部通过 ==' : '== 有失败项 =='}  ${results.length - failures}/${results.length}`)
console.log(`报告： ${REPORT}`)
process.exit(failures ? 1 : 0)

/**
 * players-unified 统一启动器（Phase 3：枚举聚合 + 深链跳转）
 *
 * 零三方依赖（只用 Node 内置模块）。做两件事：
 *   1. 枚举聚合：把三端各自的 MediaSource.list() 汇总成一个 MediaItem[]，
 *      每项带 `_end`（来源端）标记；单个来源故障不影响其它来源（降级为 error 状态）。
 *   2. 深链跳转：/api/open 按来源端选择打开方式
 *        - pluginplayer → 控制通道 RPC `player.open`（真正把片子投到播放器）
 *        - localplayer  → 浏览器打开远端 URL
 *        - daily_player → spawn `python play.py <path>`（本地播放器）
 *
 * 运行：node launcher/server.mjs [--port 7920] [--config launcher/config.json]
 */

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const LAUNCHER_DIR = __dirname
export const REPO_ROOT = path.resolve(__dirname, '..')
export const DEFAULT_CONFIG = path.resolve(__dirname, 'config.json')
export const DEFAULT_INDEX = path.resolve(__dirname, 'index.html')

export function loadConfig(p = DEFAULT_CONFIG) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/** 相对路径按仓库根解析（配置文件里可以写 "daily_player" 这样的相对路径） */
export function resolvePath(p) {
  if (!p) return p
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p)
}

function readToken(tokenFile) {
  if (!tokenFile) return ''
  try {
    return fs.readFileSync(resolvePath(tokenFile), 'utf8').trim()
  } catch {
    return ''
  }
}

/* ============================ 1. 枚举 ============================ */

async function listHttp(src) {
  const headers = {}
  const token = src.list.token ? src.list.token : readToken(src.list.tokenFile)
  if (token) headers['X-PP-Token'] = token

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), src.list.timeoutMs || 3000)
  try {
    const res = await fetch(src.list.url, { headers, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!Array.isArray(data)) throw new Error('响应不是 MediaItem[] 数组')
    return data
  } finally {
    clearTimeout(timer)
  }
}

/**
 * daily_player 端没有 HTTP 接口，且其源码是 Python —— 这里直接**调用它真实的
 * LocalFileSource.list()** 来枚举，保证「聚合的是各端自己的代码产出」而不是另写一份扫描。
 */
function listPython(src) {
  return new Promise((resolve, reject) => {
    const py = src.list.python || process.env.PYTHON_BIN || 'python'
    const moduleDir = resolvePath(src.list.moduleDir || 'daily_player')
    const dir = resolvePath(src.list.dir)
    const recursive = src.list.recursive !== false
    const code = [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(moduleDir)})`,
      'from media_source import LocalFileSource',
      `print(json.dumps(LocalFileSource().list(sys.argv[1], ${recursive ? 'True' : 'False'}), ensure_ascii=False))`,
    ].join('\n')

    const child = spawn(py, ['-c', code, dir], { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('超时'))
    }, src.list.timeoutMs || 15000)

    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(err.trim() || `python 退出码 ${code}`))
        return
      }
      try {
        const data = JSON.parse(out)
        resolve(Array.isArray(data) ? data : [])
      } catch {
        reject(new Error('python 输出不是合法 JSON：' + out.slice(0, 200)))
      }
    })
  })
}


/**
 * 通用 python 脚本枚举（与宿主 transport 的 python-script kind 镜像，双跑对比用）。
 * 配置：{ python?, script, args?, timeoutMs? }。
 */
function listPythonScript(src) {
  return new Promise((resolve, reject) => {
    const py = src.list.python || process.env.PYTHON_BIN || 'python'
    const script = resolvePath(src.list.script)
    const args = [...(src.list.args || [])]
    const child = spawn(py, [script, ...args], { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('超时'))
    }, src.list.timeoutMs || 15000)

    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(err.trim() || `python 退出码 ${code}`))
        return
      }
      try {
        const data = JSON.parse(out)
        resolve(Array.isArray(data) ? data : [])
      } catch {
        reject(new Error('python 输出不是合法 JSON：' + out.slice(0, 200)))
      }
    })
  })
}

export async function listSource(src) {
  const kind = src.list?.kind
  if (kind === 'http') return await listHttp(src)
  if (kind === 'python') return await listPython(src)
  if (kind === 'python-script') return await listPythonScript(src)
  throw new Error(`未知的 list.kind: ${kind}`)
}

export async function aggregate(sources) {
  const statuses = []
  const items = []
  for (const src of sources) {
    try {
      const list = await listSource(src)
      statuses.push({ id: src.id, label: src.label, ok: true, count: list.length })
      for (const it of list) items.push({ ...it, _end: src.id, _endLabel: src.label })
    } catch (e) {
      statuses.push({ id: src.id, label: src.label, ok: false, count: 0, error: String(e.message || e) })
    }
  }
  return { sources: statuses, items, total: items.length, generatedAt: new Date().toISOString() }
}

/* ============================ 2. 深链跳转 ============================ */

/** 只做「要做什么」的决策，不产生副作用 —— 可单测，也是 dryRun 的实现 */
export function planOpen(src, item) {
  const kind = src.open?.kind
  if (kind === 'rpc') {
    return {
      action: 'rpc',
      host: src.open.host || '127.0.0.1',
      port: src.open.port,
      method: 'player.open',
      params: { path: item.uri },
    }
  }
  if (kind === 'browser') {
    return { action: 'browser', url: item.uri }
  }
  if (kind === 'spawn') {
    return {
      action: 'spawn',
      cmd: src.open.cmd,
      args: [...(src.open.args || []), item.uri],
      cwd: resolvePath(src.open.cwd),
    }
  }
  return { action: 'none', note: '该来源未配置打开方式' }
}

/** 控制通道 RPC：先 auth 再 player.open（协议见 pluginplayer/host-js/src/player-service.mjs） */
export function rpcOpen(action, token) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: action.host, port: action.port })
    let buf = ''
    let step = 0
    let nextId = 1
    let settled = false
    sock.setEncoding('utf8')

    const finish = (err) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch { /* ignore */ }
      err ? reject(err) : resolve(true)
    }
    const send = (method, params) => sock.write(JSON.stringify({ id: nextId++, method, params }) + '\n')

    sock.on('connect', () => send('auth', { token }))
    sock.on('error', (e) => finish(e))
    sock.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (step === 0) {
          if (!msg.ok) { finish(new Error('控制通道认证失败：' + (msg.error || ''))); return }
          step = 1
          send(action.method, action.params)
        } else if (!settled) {
          finish(msg.ok ? null : new Error(msg.error || 'player.open 失败'))
        }
      }
    })
    setTimeout(() => finish(new Error('控制通道 RPC 超时')), 5000)
  })
}

export function spawnOpen(action) {
  const child = spawn(action.cmd, action.args, {
    cwd: action.cwd || undefined,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return child.pid
}

/* ============================ 3. HTTP 服务 ============================ */

export function createLauncher(config) {
  const sources = config.sources || []
  const state = { items: [], lastAggregate: null }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = (code, obj, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type })
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj))
    }

    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        send(200, fs.readFileSync(DEFAULT_INDEX, 'utf8'), 'text/html; charset=utf-8')
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/aggregate') {
        const result = await aggregate(sources)
        state.items = result.items
        state.lastAggregate = result
        send(200, result)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/open') {
        let body = ''
        for await (const chunk of req) body += chunk
        let payload = {}
        try { payload = body ? JSON.parse(body) : {} } catch { /* 用默认值 */ }

        // 没有缓存时先聚合一次
        if (!state.items.length) {
          const r = await aggregate(sources)
          state.items = r.items
          state.lastAggregate = r
        }
        const item = state.items.find((it) => it.id === payload.id)
        if (!item) {
          send(404, { ok: false, error: `找不到 id=${payload.id} 的媒体（先调用 /api/aggregate 刷新）` })
          return
        }
        const src = sources.find((s) => s.id === item._end)
        if (!src) {
          send(500, { ok: false, error: `媒体来源 ${item._end} 未配置` })
          return
        }

        const action = planOpen(src, item)
        const dryRun = !!payload.dryRun
        let executed = false
        if (!dryRun && action.action === 'rpc') {
          await rpcOpen(action, src.open.token ? src.open.token : readToken(src.open.tokenFile))
          executed = true
        } else if (!dryRun && action.action === 'spawn') {
          spawnOpen(action)
          executed = true
        }

        send(200, {
          ok: true,
          item: { id: item.id, title: item.title, uri: item.uri, kind: item.kind, source: item.source, _end: item._end },
          action,
          dryRun,
          executed,
          note: dryRun ? 'dryRun=true：仅返回计划动作，未真正执行'
            : (action.action === 'browser' ? 'browser 动作由前端 window.open 打开' : null),
        })
        return
      }

      send(404, { ok: false, error: 'not found' })
    } catch (e) {
      send(500, { ok: false, error: String(e.message || e) })
    }
  })

  return {
    server,
    state,
    listen: (port) => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve(server))
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/* ============================ 4. CLI ============================ */

function parseArgv(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i])
    else if (argv[i] === '--config') out.config = argv[++i]
  }
  return out
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = parseArgv(process.argv.slice(2))
  const config = loadConfig(args.config ? path.resolve(args.config) : DEFAULT_CONFIG)
  const port = args.port || config.port || 7920
  const launcher = createLauncher(config)
  await launcher.listen(port)
  console.log(`[launcher] 统一启动器已启动： http://127.0.0.1:${port}`)
  console.log(`[launcher] 已配置 ${config.sources.length} 个来源： ${config.sources.map((s) => s.id).join(', ')}`)
}

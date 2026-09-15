/**
 * 传输层：各来源端的「枚举」与「打开」原语（零三方依赖，只用 node 内置模块）。
 *
 * ⚠️ 这份实现是从 `launcher/server.mjs` 移植过来的，**刻意保持两份独立实现**。
 *    理由：S5-1 的验收要求是「双跑对比 launcher /api/aggregate 与 Cordis 输出逐项一致」。
 *    如果宿主直接 import launcher 的函数，那就成了「拿一个函数跟它自己比」，对比毫无意义。
 *    两份独立实现跑出同样的结果，才构成真证据。
 *    代价是暂时有一份重复代码；等 S5-2/S5-3 把 launcher 的 HTTP 面也吸收进宿主、
 *    `launcher/` 退役之后，这份就成为唯一实现，重复自然消失。
 *
 * 与 launcher 的差异只有一处：`root`（相对路径的解析基准）由外部传入，
 * 而不是写死在模块里 —— 因为宿主自己的目录深度不同。
 */

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * @param {string} root 相对路径的解析基准（本仓库里就是仓库根）
 */
export function createTransport(root) {
  const resolvePath = (p) => {
    if (!p) return p
    return path.isAbsolute(p) ? p : path.resolve(root, p)
  }

  const readToken = (tokenFile) => {
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
   * `LocalFileSource.list()`** 来枚举，保证「聚合的是各端自己的代码产出」而不是另写一份扫描。
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
      child.on('close', (code2) => {
        clearTimeout(timer)
        if (code2 !== 0) {
          reject(new Error(err.trim() || `python 退出码 ${code2}`))
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

  async function listSource(src) {
    const kind = src.list?.kind
    if (kind === 'http') return await listHttp(src)
    if (kind === 'python') return await listPython(src)
    throw new Error(`未知的 list.kind: ${kind}`)
  }

  /** 汇总三端；单个来源故障只在该项上标 error，不影响其它来源 */
  async function aggregate(sources) {
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
  function planOpen(src, item) {
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
    if (kind === 'browser') return { action: 'browser', url: item.uri }
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
  function rpcOpen(action, token) {
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

  function spawnOpen(action) {
    const child = spawn(action.cmd, action.args, {
      cwd: action.cwd || undefined,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return child.pid
  }

  return { root, resolvePath, readToken, listHttp, listPython, listSource, aggregate, planOpen, rpcOpen, spawnOpen }
}

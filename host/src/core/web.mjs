/**
 * `ctx.web` —— 宿主唯一的 HTTP 服务：**一个端口承载所有 HTTP 面 + WebSocket 升级**。
 *
 * 为什么要有这个服务（S5-3 的结构性改动）：
 *   localplayer 的 Flask 后端里 `/api/list`、`/media/<file>`、`/ws`、`/remote`
 *   是**同一个 origin、同一个端口**。而 `/remote` 页面里的
 *   `new WebSocket('ws://' + location.host + '/ws')` 要求信令与页面**同源**，
 *   否则页面打开就是跨域连接。所以宿主不能「每个面各开一个 server」——
 *   必须有一个服务持有 socket，各面只是往上挂路由。
 *
 * 分工：
 *   · 本服务负责：监听、Host/Origin 白名单、HTTP 方法闸门、安全响应头、
 *     路由分派、WebSocket 升级分派、关闭时的统一释放。
 *   · 各个「面」（library-face / remote）只负责：认领自己的路径、产生响应。
 *
 * 安全模型（沿用 S5-2 里 `pluginplayer/host-js/plugins/03-web-remote.mjs` 那一套）：
 *   1) Host 头白名单（只认 127.0.0.1 / localhost / [::1] + 本端口）—— 挡 DNS rebinding
 *   2) Origin 头白名单（同源才放行；不带 Origin 的请求放行，因为 curl/扩展后台不带）
 *   3) 不返回任何 CORS 头，OPTIONS 预检一律 405
 *   4) 统一安全头 nosniff / CSP / X-Frame-Options / Referrer-Policy
 *
 * WebSocket 升级的 Origin 策略**比 HTTP 多一条**：额外放行 `chrome-extension://`
 * 与 `moz-extension://`。原因很实在：本宿主的信令发送端就是 localplayer 的扩展
 * （offscreen / background 直连 `ws://127.0.0.1:5000/ws`），浏览器在 WS 握手时
 * **一定**会带上 `Origin: chrome-extension://<id>`；若照 HTTP 那套同源白名单，
 * 扩展一开投送就被自己挡掉 —— 那就违反「扩展端零改动」这条硬约束了。
 * 这是相对 python 侧的**收紧**（python 完全不看 Origin，任何网页都能连上来当接收端），
 * 放行扩展是有意的取舍：挡住任意网页，放行已安装扩展。
 *
 * config: { host?: string, port?: number, allowExtensionOrigins?: boolean }
 */

import http from 'node:http'
import { Service } from 'cordis'
import { rejectUpgrade } from '../../lib/ws.mjs'

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; " +
    "media-src 'self'; base-uri 'none'; form-action 'none'",
}

const EXTENSION_ORIGIN_PREFIXES = ['chrome-extension://', 'moz-extension://', 'safari-web-extension://']

export class WebService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'web')
    this.host = config.host ?? '127.0.0.1'
    this.port = config.port ?? 5000
    this.allowExtensionOrigins = config.allowExtensionOrigins !== false
    /** 路由与升级处理器按注册顺序分派；返回 true 表示已认领 */
    this.routes = []
    this.upgradeHandlers = []

    this.allowedHosts = new Set()
    this.allowedOrigins = new Set()
    this.#refreshAllowlists()

    this.server = http.createServer((req, res) => this.#dispatch(req, res))
    this.server.on('upgrade', (req, socket, head) => this.#dispatchUpgrade(req, socket, head))
    this.server.on('clientError', (error, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      } catch {
        /* ignore */
      }
      ctx.logger.warn(`[web] clientError: ${error.message}`)
    })
    this.server.on('error', (error) => ctx.logger.warn(`[web] server 错误: ${error.message}`))

    /** 监听完成的 promise —— 测试与依赖方都应当 await 它，而不是靠 sleep 猜 */
    this.ready = new Promise((resolve, reject) => {
      this.server.once('listening', () => {
        const address = this.server.address()
        this.port = address.port // port 传 0 时由内核分配，回填真实值
        this.#refreshAllowlists() // 端口变了，白名单必须跟着重算（否则 port:0 时白名单是 :0）
        ctx.logger.info(`[web] HTTP 面已监听 http://${this.host}:${this.port}`)
        resolve(this)
      })
      this.server.once('error', reject)
    })
    // 不接这个 catch，监听失败会变成「未处理的 Promise 拒绝」直接把宿主进程打崩
    // （Node 15+ 默认 --unhandled-rejections=throw）。实际很容易踩到：5000 端口上还
    // 跑着旧的 `python localplayer/server.py`。打完日志后 this.ready 仍然是 rejected 的，
    // 显式 await 它的一方照旧能拿到错误。
    this.ready.catch((error) => {
      this.failed = error
      ctx.logger.error(
        `[web] 监听失败 http://${this.host}:${this.port}：${error.message}` +
        (error.code === 'EADDRINUSE' ? '（端口被占用，常见原因：旧的 python localplayer/server.py 还在跑）' : ''),
      )
    })
    this.server.listen(this.port, this.host)

    ctx.effect(() => () => this.close())
  }

  get origin() {
    return `http://${this.host}:${this.port}`
  }

  /** Host/Origin 白名单随端口重算（配置里写 port:0 时由内核分配，必须回填后再算一次） */
  #refreshAllowlists() {
    const suffixes = [this.host, '127.0.0.1', 'localhost', '[::1]']
    this.allowedHosts = new Set(suffixes.map((h) => `${h}:${this.port}`))
    this.allowedOrigins = new Set(suffixes.map((h) => `http://${h}:${this.port}`))
  }

  close() {
    if (this.closing) return
    this.closing = true
    for (const handler of this.upgradeHandlers.splice(0)) handler.close?.() // 处理器可挂 close 钩子
    // 未决的升级 socket 不会被 server.close() 回收，得自己拆
    this.server.closeAllConnections?.()
    this.server.close()
    this.ctx.logger.info('[web] HTTP 面已关闭')
  }

  /** 注册一条 HTTP 路由；返回撤销函数。handler(req, res, url, web) → boolean */
  route(handler) {
    this.routes.push(handler)
    return () => {
      const at = this.routes.indexOf(handler)
      if (at >= 0) this.routes.splice(at, 1)
    }
  }

  /** 注册一个 WebSocket 升级处理器；返回撤销函数。handler(req, socket, head, web) → boolean */
  upgrade(handler) {
    this.upgradeHandlers.push(handler)
    return () => {
      const at = this.upgradeHandlers.indexOf(handler)
      if (at >= 0) this.upgradeHandlers.splice(at, 1)
    }
  }

  /* ---------------- 响应助手（统一安全头） ---------------- */

  send(res, code, headers, body) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body), 'utf8')
    res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Length': buf.length, ...headers })
    res.end(buf)
  }

  json(res, value, code = 200) {
    this.send(res, code, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(value))
  }

  text(res, code, message) {
    this.send(res, code, { 'Content-Type': 'text/plain; charset=utf-8' }, message)
  }

  html(res, code, body, extra = {}) {
    this.send(res, code, { 'Content-Type': 'text/html; charset=utf-8', ...extra }, body)
  }

  /* ---------------- 闸门 ---------------- */

  /** HTTP 请求闸门：通过返回 { ok:true }，否则已写好响应并返回 { ok:false } */
  checkHttp(req, res) {
    const hostHeader = String(req.headers.host || '').toLowerCase()
    if (!this.allowedHosts.has(hostHeader)) {
      this.text(res, 403, 'forbidden host')
      return { ok: false, reason: 'host' }
    }
    const origin = req.headers.origin
    if (origin !== undefined && (origin === 'null' || !this.allowedOrigins.has(String(origin).toLowerCase()))) {
      this.text(res, 403, 'forbidden origin')
      return { ok: false, reason: 'origin' }
    }
    if (req.method === 'OPTIONS') {
      this.text(res, 405, 'preflight not allowed')
      return { ok: false, reason: 'preflight' }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this.text(res, 405, 'method not allowed')
      return { ok: false, reason: 'method' }
    }
    return { ok: true }
  }

  /**
   * WebSocket 升级闸门。比 HTTP 多放行扩展来源（见文件头说明）。
   * 通过返回 { ok:true }；否则返回 { ok:false, status, message }，由调用方写裸响应。
   */
  checkUpgrade(req) {
    const hostHeader = String(req.headers.host || '').toLowerCase()
    if (!this.allowedHosts.has(hostHeader)) {
      return { ok: false, status: 403, message: 'forbidden host' }
    }
    const origin = req.headers.origin
    if (origin !== undefined && origin !== 'null') {
      const value = String(origin).toLowerCase()
      const permitted = this.allowedOrigins.has(value)
        || (this.allowExtensionOrigins && EXTENSION_ORIGIN_PREFIXES.some((p) => value.startsWith(p)))
      if (!permitted) return { ok: false, status: 403, message: 'forbidden origin' }
    }
    return { ok: true }
  }

  /* ---------------- 分派 ---------------- */

  #dispatch(req, res) {
    if (!this.checkHttp(req, res).ok) return
    let url
    try {
      url = new URL(req.url, `http://${this.host}:${this.port}`)
    } catch {
      this.text(res, 400, 'bad request')
      return
    }
    for (const handler of [...this.routes]) {
      try {
        if (handler(req, res, url, this) === true) return
      } catch (error) {
        this.ctx.logger.warn(`[web] 路由处理异常 ${req.method} ${req.url}: ${error.stack || error.message}`)
        if (!res.headersSent) this.text(res, 500, 'internal error')
        else res.end()
        return
      }
    }
    this.text(res, 404, 'not found')
  }

  #dispatchUpgrade(req, socket, head) {
    // 升级请求在握手前也要过 Host/Origin 闸门（否则任意网页都能连 ws）
    const guard = this.checkUpgrade(req)
    if (!guard.ok) {
      rejectUpgrade(socket, guard.status, guard.message)
      return
    }
    for (const handler of [...this.upgradeHandlers]) {
      try {
        if (handler(req, socket, head, this) === true) return
      } catch (error) {
        this.ctx.logger.warn(`[web] 升级处理异常 ${req.url}: ${error.stack || error.message}`)
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
        return
      }
    }
    rejectUpgrade(socket, 404, `没有处理 ${req.url} 的 WebSocket 处理器`)
  }
}

export default WebService

/**
 * media-library.mjs — 媒体源插件（JS / Cordis）
 *
 * 对应 ARCHITECTURE.md §4 的「MediaSource」端口在 PluginPlayer 端的落地：
 * 扫描本地媒体库目录，产出与 schema/media-item.schema.json 一致的 MediaItem[]
 * （即 C SDK 结构体 PP_MediaItem 的 JSON 等价物），与 daily_player /
 * localplayer 三端对齐。这是 P0-1「PluginPlayer 直接按媒体源 Cordis 插件形态做」的成品。
 *
 * 能力：
 *   - 作为 Cordis 服务注册为 ctx.mediaLibrary，提供 list() / rescan() / getById() / open(id)
 *   - 暴露只读 HTTP /api/library（GET 列表 / POST rescan），令牌认证（复用控制通道令牌）
 *   - 与 daily_player LocalFileSource / localplayer server.py /api/list 产出同一契约，
 *     Phase 3 统一启动器可直接聚合三端的 MediaSource.list()
 *
 * 安全模型（沿用 web-remote 的思路，但本插件只读、不执行命令）：
 *   - /api/* 必须带 X-PP-Token（= 控制通道令牌）；无令牌或令牌缺失一律 401
 *   - Host / Origin 白名单（只认本机回环），挡 DNS rebinding / CSRF
 *   - 响应统一带 nosniff / X-Frame-Options / CSP
 * 未连接播放器（无令牌文件）时端点拒绝服务，避免未授权枚举本地文件。
 */
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { Service } from 'cordis'
import { fileURLToPath } from 'node:url'
import { scanLibrary } from './lib/media-library-core.mjs'
import { resolveToken } from '../src/player-service.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'",
}

function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

export default class MediaLibraryService extends Service {
  static inject = ['player']
  static name = 'media-library'

  constructor(ctx, config = {}) {
    super(ctx, 'mediaLibrary')
    this.ctx = ctx

    // 媒体库目录：config.dir > 环境变量 PP_MEDIA_LIBRARY_DIR > 默认 pluginplayer/library
    this.dir = config.dir
      || process.env.PP_MEDIA_LIBRARY_DIR
      || path.resolve(__dirname, '..', '..', 'library')
    this.recursive = config.recursive !== false
    this.httpHost = config.host ?? '127.0.0.1'
    this.httpPort = config.port ?? 7913
    this.httpEnabled = config.httpEnabled !== false

    this.items = []
    this._server = null
    this._rescan()

    // 宿主可能晚于播放器启动而错过开场事件：连上后主动再扫一次，保证列表最新
    ctx.on('player/connected', () => this._rescan())

    if (this.httpEnabled) this._startHttp()

    ctx.effect(() => () => {
      if (this._server) this._server.close()
      ctx.logger.info(`[media-library] 已卸载（缓存 ${this.items.length} 条媒体）`)
    })
  }

  /** 扫描媒体库目录，更新缓存 */
  _rescan() {
    try {
      this.items = scanLibrary(this.dir, { recursive: this.recursive })
      this.ctx.logger.info(`[media-library] 扫描 ${this.dir} -> ${this.items.length} 个媒体`)
    } catch (e) {
      this.ctx.logger.warn(`[media-library] 扫描失败: ${e.message}`)
      this.items = []
    }
  }

  /* ---- 服务 API（供其它插件 / Phase 3 启动器调用） ---- */
  list() { return this.items }
  rescan() { this._rescan(); return this.items }
  getById(id) { return this.items.find((i) => i.id === id) || null }
  async open(id) {
    const it = this.getById(id)
    if (!it) throw new Error(`未找到媒体: ${id}`)
    await this.ctx.player.open(it.uri)
    return it
  }

  /* ---- 只读 HTTP（聚合端点，供统一启动器轮询） ---- */
  _startHttp() {
    const port = this.httpPort
    const host = this.httpHost
    const base = `http://${host}:${port}`
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`])

    const json = (res, obj, code = 200) => {
      const buf = Buffer.from(JSON.stringify(obj), 'utf8')
      res.writeHead(code, Object.assign({}, SECURITY_HEADERS, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': buf.length,
      }))
      res.end(buf)
    }

    const server = http.createServer(async (req, res) => {
      // 第 2 关：Host 白名单（挡 DNS rebinding）
      const hostHeader = String(req.headers.host || '').toLowerCase()
      if (!allowedHosts.has(hostHeader)) {
        res.writeHead(403, SECURITY_HEADERS); res.end('forbidden host'); return
      }
      // 第 3 关：Origin 白名单（挡 CSRF）
      const origin = req.headers.origin
      if (origin !== undefined &&
          (origin === 'null' || !allowedOrigins.has(String(origin).toLowerCase()))) {
        res.writeHead(403, SECURITY_HEADERS); res.end('forbidden origin'); return
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(405, SECURITY_HEADERS); res.end('preflight not allowed'); return
      }

      const url = new URL(req.url, base)

      // 第 4 关：/api/* 必须带控制通道令牌（令牌缺失时拒绝，避免未授权枚举）
      if (url.pathname.startsWith('/api/')) {
        let tok = ''
        try { tok = resolveToken({}) } catch { tok = '' }
        const got = req.headers['x-pp-token']
        if (!tok || !tokenEquals(got, tok)) {
          json(res, { ok: false, error: 'unauthorized' }, 401)
          return
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/library') {
        json(res, { ok: true, source: 'plugin:media-library', items: this.items })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/library/rescan') {
        const items = this.rescan()
        json(res, { ok: true, count: items.length, items })
        return
      }
      json(res, { ok: false, error: 'not found' }, 404)
    })

    server.on('error', (e) => this.ctx.logger.warn(`[media-library] HTTP 错误: ${e.message}`))
    server.listen(port, host, () => {
      this.ctx.logger.info(`[media-library] HTTP 已启动 ${base}/api/library（令牌认证）`)
    })
    this._server = server
  }
}

export const config = {
  dir: '',                 // 留空则读 PP_MEDIA_LIBRARY_DIR，再退回 pluginplayer/library
  recursive: true,
  host: '127.0.0.1',
  port: 7913,
  httpEnabled: true,       // 只读 + 令牌认证；如不需要可设 false
}

/**
 * 列表面插件 —— 把 `localplayer/server.py` 的媒体清单/文件服务吸收进宿主的 Cordis 形态。
 *
 * 吸收的接口（与 python 侧同路径、同语义，扩展端**零改动**）：
 *   GET /api/list           媒体清单 JSON 数组（MediaItem + 过渡别名 name/type/path）
 *   GET /media/<filename>   返回媒体目录下的文件
 *   GET /                   说明页
 *   GET /favicon.ico        204
 *
 * `/ws` 信令与 `/remote` 观看页在 `src/web/remote.mjs`（同一端口，见 `src/core/web.mjs`）。
 *
 * ============================ 安全模型 ============================
 * 四道关不在这里，而在 `ctx.web`（HTTP 面的公共闸门）：Host 白名单（挡 DNS rebinding）、
 * Origin 白名单（挡 CSRF）、OPTIONS 一律 405、统一安全响应头。本插件只负责
 * 「认领路径 + 产生内容」，另外自带第五道关：
 *   路径穿越防护 —— `/media/` 下解析出的绝对路径必须仍在媒体目录内
 *   （python 侧靠 werkzeug 的 safe_join，这里自己实现）。
 * ==================================================================
 *
 * 相比 python 侧多做的一件事：支持 HTTP Range（单段），让 <video> 的拖动定位可用。
 * 无 Range 的普通 GET 与 python 侧返回完全相同的字节。
 */

import fs from 'node:fs'
import path from 'node:path'
import { SECURITY_HEADERS } from '../core/web.mjs'
import { buildMediaItems } from './library-core.mjs'

const MIME = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
}

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>players-unified · 媒体清单面</title>
<style>
 body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#0f0f12;color:#eaeef2;margin:2rem;line-height:1.7}
 h1{font-size:1.2rem;font-weight:500} a{color:#7aa2f7} code{background:#1c1c22;padding:2px 6px;border-radius:4px}
 .sub{color:#8a98a8;font-size:.85rem}
</style></head><body>
<h1>players-unified · 媒体清单面</h1>
<p class="sub">由 Cordis 插件 <code>src/web/library-face.mjs</code> 提供，替代 localplayer 的 Flask 后端
（<code>server.py</code> 的 /api/list 与 /media/&lt;file&gt;）。</p>
<ul>
  <li><a href="/api/list">/api/list</a> — 媒体清单 JSON（扩展「远端后端」源直接消费，字段与 python 侧一致）</li>
  <li><a href="/remote">/remote</a> — 网页投送观看页（接收端）</li>
  <li>WebSocket <code>/ws</code> — WebRTC 信令中继（由 <code>src/web/remote.mjs</code> 用自写 RFC6455 提供）</li>
</ul>
</body></html>`

/** 媒体目录内解析：拒绝穿越。返回绝对路径或 null */
function safeResolve(mediaDir, urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const joined = path.resolve(mediaDir, decoded.replace(/^[/\\]+/, ''))
  const rootWithSep = path.resolve(mediaDir) + path.sep
  if (joined !== path.resolve(mediaDir) && !joined.startsWith(rootWithSep)) return null
  return joined
}

/** 解析单段 Range；无法解析/不支持时返回 null（调用方按整文件返回） */
export function parseRange(header, size) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null
  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

const apply = (ctx, config = {}) => {
  const dir = config.dir ?? 'localplayer/media'
  const mediaDir = path.isAbsolute(dir) ? dir : path.resolve(ctx.media.root, dir)

  ctx.effect(() => ctx.web.route((req, res, url) => {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      ctx.web.html(res, 200, INDEX_HTML)
      return true
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204, SECURITY_HEADERS)
      res.end()
      return true
    }

    if (url.pathname === '/api/list') {
      // host_url 取自请求（与 Flask 的 request.host_url 同义）；已过 ctx.web 的 Host 白名单
      ctx.web.json(res, buildMediaItems(mediaDir, `http://${String(req.headers.host || '')}`))
      return true
    }

    if (url.pathname.startsWith('/media/')) {
      const target = safeResolve(mediaDir, url.pathname.slice('/media'.length))
      if (!target) {
        ctx.web.text(res, 403, 'forbidden')
        return true
      }
      let stat
      try {
        stat = fs.statSync(target)
      } catch {
        ctx.web.text(res, 404, 'not found')
        return true
      }
      if (!stat.isFile()) {
        ctx.web.text(res, 404, 'not found')
        return true
      }
      const ctype = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
      const range = parseRange(req.headers.range, stat.size)
      if (range) {
        const stream = fs.createReadStream(target, { start: range.start, end: range.end })
        res.writeHead(206, {
          ...SECURITY_HEADERS,
          'Content-Type': ctype,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
          'Content-Length': range.end - range.start + 1,
        })
        if (req.method === 'HEAD') {
          stream.destroy()
          res.end()
          return true
        }
        stream.pipe(res)
        return true
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': ctype,
        'Accept-Ranges': 'bytes',
        'Content-Length': stat.size,
      })
      if (req.method === 'HEAD') {
        res.end()
        return true
      }
      fs.createReadStream(target).pipe(res)
      return true
    }

    return false
  }))

  ctx.logger.info(`[library-http] 媒体清单面已挂载 /api/list 与 /media/（媒体目录 ${mediaDir}）`)
}

export default {
  name: 'library-http',
  inject: ['media', 'web'],
  apply,
}

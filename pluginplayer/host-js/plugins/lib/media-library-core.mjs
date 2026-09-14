// media-library-core.mjs — 纯逻辑：扫描本地目录 -> MediaItem[]（无 cordis / 无内核依赖）
//
// 对应 ARCHITECTURE.md §4 的「MediaSource」端口在 PluginPlayer 端的产出。
// 产出的结构与 schema/media-item.schema.json 的 MediaItem 完全一致，
// 与 daily_player/media_source.py（LocalFileSource）、localplayer/server.py /api/list
// 三端对齐（同一份契约）。
//
// 这是「媒体源 Cordis 插件」的纯计算内核，单独成文件以便脱离 Cordis / 播放器
// 直接做 schema 校验测试（见同目录 media-library.test.mjs）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 视频扩展名（与 daily_player/media_source.py 同口径，略扩） */
export const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
  '.mpg', '.mpeg', '.ts', '.m2ts', '.vob', '.ogv', '.m2v', '.3gp',
])

/** 音频扩展名 */
export const AUDIO_EXTS = new Set([
  '.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac', '.opus', '.wma',
  '.ape', '.ac3', '.dts', '.eac3', '.mp2', '.oga',
])

/** 扩展名 -> 'video' | 'audio' | null（非媒体） */
export function extToKind(ext) {
  const e = String(ext || '').toLowerCase()
  if (VIDEO_EXTS.has(e)) return 'video'
  if (AUDIO_EXTS.has(e)) return 'audio'
  return null
}

/** 稳定标识：路径的 sha1 前 16 位。前缀 pp- 与 daily_player(dp-)/localplayer(lp-) 同款约定。 */
export function mediaItemId(absPath) {
  const h = crypto.createHash('sha1').update(absPath).digest('hex')
  return 'pp-' + h.slice(0, 16)
}

/** 单个文件 -> MediaItem（调用方需保证 extToKind 非空） */
export function buildMediaItem(absPath) {
  const ext = path.extname(absPath).toLowerCase()
  const kind = extToKind(ext)
  if (!kind) return null
  return {
    id: mediaItemId(absPath),
    uri: absPath,                 // 本地绝对路径；ctx.player.open(uri) 可直接打开
    title: path.basename(absPath, ext) || path.basename(absPath),
    artist: null,                 // 枚举阶段不解析，统一 null（schema 允许）
    kind,                         // 'video' | 'audio'
    durationMs: null,             // 枚举阶段不解码，时长未知（schema 允许 null）
    source: 'plugin:media-library',
    subtitleTracks: [],
    thumbnail: null,
  }
}

function walk(dir, recursive, out, seen) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return // 无权限 / 不存在 -> 跳过该分支
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (seen.has(full)) continue
    seen.add(full)
    if (ent.isDirectory()) {
      if (recursive) walk(full, recursive, out, seen)
    } else if (ent.isFile()) {
      const kind = extToKind(path.extname(ent.name))
      if (kind) {
        const item = buildMediaItem(full)
        if (item) out.push(item)
      }
    }
  }
}

/**
 * 扫描目录，返回 MediaItem[]（与 schema 一致）。
 * @param {string} dir 目录（绝对或相对；空/未定义返回 []）
 * @param {{recursive?: boolean}} [opts] recursive 默认 true
 * @returns {Array<object>} MediaItem[]
 */
export function scanLibrary(dir, opts = {}) {
  const recursive = opts.recursive !== false
  const out = []
  if (!dir) return out
  const seen = new Set()
  walk(path.resolve(dir), recursive, out, seen)
  // 稳定排序：标题 -> 路径，保证列表可复现（去重/进度记忆依赖稳定顺序）
  out.sort((a, b) => {
    if (a.title < b.title) return -1
    if (a.title > b.title) return 1
    if (a.uri < b.uri) return -1
    if (a.uri > b.uri) return 1
    return 0
  })
  return out
}

/**
 * localplayer 媒体清单的**纯逻辑**构建（零 cordis、零 HTTP 依赖）。
 *
 * 这份是从 `localplayer/media_lib.py` 的 `build_media_items()` 移植的**独立实现**：
 * 字段、顺序、id 算法逐一对齐，好让 S5-2 的 parity 测试能拿两份实现对比
 * （把 python 侧的产出当真值）。既然是「可替换 python 后端」这个目标，
 * 就不能靠 import python 来保证一致 —— 那样测试等于没测。
 *
 * 契约见 `schema/media-item.schema.json`：每项是规范 MediaItem，
 * 另带过渡别名 `name` / `type` / `path`（为兼容尚未迁移的扩展前端，未来阶段移除）。
 *
 * 与 python 侧的**刻意对齐点**（都实测比对过）：
 *   · 排序：`sorted(os.listdir())` ↔ 按 UTF-16 码元排序。两者在 BMP 内（含中文）一致。
 *   · **不判断 `isfile`**：python 侧只看扩展名，所以一个名叫 `foo.mp4` 的**目录**也会入列。
 *     这里原样保留该行为（drop-in 替换要求输出一致），并写进测试用例锁住。
 *   · id = `lp-` + sha1(uri) 的前 16 位十六进制。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 与 media_lib.py 的 MEDIA_TYPES 完全一致 */
export const MEDIA_TYPES = {
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.mkv': 'video',
  '.mp3': 'audio',
  '.ogg': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.flac': 'audio',
}

/** python 的 `str` 排序按码点；这里显式按码元比较，避免默认 `sort()` 的实现差异 */
function compareCodeUnits(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * 扫描 mediaDir（非递归），返回 MediaItem[]。
 *
 * @param {string} mediaDir 媒体目录
 * @param {string} hostUrl  对外基地址（如 `http://127.0.0.1:5000`），用于拼 `uri`
 */
export function buildMediaItems(mediaDir, hostUrl) {
  const items = []
  if (!mediaDir) return items
  try {
    if (!fs.statSync(mediaDir).isDirectory()) return items
  } catch {
    return items
  }
  const base = hostUrl ? hostUrl.replace(/\/+$/, '') : ''

  let names
  try {
    names = fs.readdirSync(mediaDir)
  } catch {
    return items
  }

  for (const fn of names.sort(compareCodeUnits)) {
    const rawExt = path.extname(fn)
    const mtype = MEDIA_TYPES[rawExt.toLowerCase()]
    if (!mtype) continue
    const uri = `${base}/media/${fn}`
    items.push({
      // ---- 规范 MediaItem 字段 ----
      id: 'lp-' + crypto.createHash('sha1').update(uri, 'utf8').digest('hex').slice(0, 16),
      uri,
      title: path.basename(fn, rawExt),
      artist: null,
      kind: mtype,
      durationMs: null,
      source: 'remote',
      subtitleTracks: [],
      thumbnail: null,
      // ---- 过渡别名（兼容未迁移前端，未来阶段移除）----
      name: fn,
      type: mtype,
      path: uri,
    })
  }
  return items
}

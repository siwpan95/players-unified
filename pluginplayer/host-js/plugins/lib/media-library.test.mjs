// media-library.test.mjs — 纯 schema 校验测试（不依赖 cordis / 播放器）
//
// 验证 media-library-core.mjs 的 scanLibrary 产出确实符合
// schema/media-item.schema.json 的 MediaItem 契约（与 daily_player / localplayer 对齐）。
// 运行：node pluginplayer/host-js/plugins/lib/media-library.test.mjs
// 退出码：0 = 全部通过，1 = 有失败断言。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'
import { scanLibrary, mediaItemId } from './media-library-core.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'schema', 'media-item.schema.json')
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))
const MEDIA_SCHEMA = SCHEMA.definitions.MediaItem

// ---- 迷你 JSON-Schema 解释器：仅覆盖本 schema 用到的关键字 ----
// type（含字符串数组形式的 nullable）/ required / properties / items / enum
function checkType(value, type) {
  if (Array.isArray(type)) return type.some((t) => checkType(value, t))
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    case 'array': return Array.isArray(value)
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    default: return true
  }
}
function validate(item, schema, where) {
  const errors = []
  for (const k of (schema.required || [])) {
    if (!(k in item)) errors.push(`${where}.${k} 缺失（required）`)
  }
  const props = schema.properties || {}
  for (const [k, v] of Object.entries(item)) {
    const ps = props[k]
    if (!ps) continue // 不强制 additionalProperties=false
    if (ps.type && !checkType(v, ps.type)) {
      errors.push(`${where}.${k} 类型不符（期望 ${JSON.stringify(ps.type)}，实得 ${typeof v}）`)
    }
    if (ps.enum && !ps.enum.includes(v)) {
      errors.push(`${where}.${k} 不在枚举 ${JSON.stringify(ps.enum)}`)
    }
    if (ps.type === 'array' && ps.items && Array.isArray(v)) {
      v.forEach((it, i) => errors.push(...validate(it, ps.items, `${where}.${k}[${i}]`)))
    }
  }
  return errors
}

// ---- 建临时媒体库（含非媒体文件 + 子目录） ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-lib-'))
const top = ['movie A.mp4', 'song B.mp3', 'clip.mkv', 'audio.wav', 'notes.txt', 'ignored.png']
for (const f of top) fs.writeFileSync(path.join(tmp, f), 'x')
fs.mkdirSync(path.join(tmp, 'sub'))
fs.writeFileSync(path.join(tmp, 'sub', 'deep.flac'), 'x')

const items = scanLibrary(tmp) // 默认 recursive=true
console.log(`[test] 递归扫描 -> ${items.length} 个媒体（期望 5：mp4/mkv/mp3/wav/flac；排除 txt/png）`)

// ---- 组成断言 ----
assert.strictEqual(items.length, 5, `媒体数量应为 5，实得 ${items.length}`)
const byName = Object.fromEntries(items.map((i) => [path.basename(i.uri), i]))
assert.ok(byName['movie A.mp4'], '应含 movie A.mp4')
assert.ok(byName['song B.mp3'], '应含 song B.mp3')
assert.ok(byName['clip.mkv'], '应含 clip.mkv')
assert.ok(byName['audio.wav'], '应含 audio.wav')
assert.ok(byName['deep.flac'], '应递归含 sub/deep.flac')
assert.ok(!byName['notes.txt'], '不应含 notes.txt')
assert.ok(!byName['ignored.png'], '不应含 ignored.png')

// ---- recursive 开关 ----
const flat = scanLibrary(tmp, { recursive: false })
assert.strictEqual(flat.length, 4, `recursive:false 应为 4（子目录不进），实得 ${flat.length}`)

// ---- 逐条 schema 契约校验 ----
const ids = new Set()
for (const it of items) {
  const errs = validate(it, MEDIA_SCHEMA, 'MediaItem')
  assert.strictEqual(errs.length, 0, 'schema 校验失败:\n' + errs.join('\n'))

  assert.ok(['audio', 'video'].includes(it.kind), `kind 非法: ${it.kind}`)
  assert.match(it.id, /^pp-[0-9a-f]{16}$/, `id 格式不符: ${it.id}`)
  assert.ok(!ids.has(it.id), `id 重复: ${it.id}`)
  ids.add(it.id)
  assert.strictEqual(it.source, 'plugin:media-library', 'source 标识应为 plugin:media-library')
  assert.strictEqual(path.isAbsolute(it.uri), true, 'uri 应为绝对路径')
  assert.strictEqual(it.artist, null, 'artist 应为 null')
  assert.strictEqual(it.durationMs, null, 'durationMs 应为 null')
  assert.deepStrictEqual(it.subtitleTracks, [], 'subtitleTracks 应为空数组')
  assert.strictEqual(it.thumbnail, null, 'thumbnail 应为 null')
}

// ---- id 稳定性（同路径两次扫描 id 一致） ----
const again = scanLibrary(tmp)
assert.strictEqual(again[0].id, items[0].id, '同路径两次扫描 id 应稳定')
assert.strictEqual(mediaItemId(path.join(tmp, 'movie A.mp4')),
                   again.find((i) => i.uri.endsWith('movie A.mp4')).id, 'mediaItemId 应可复现')

console.log('[test] 全部断言通过 ✅  MediaItem[] 符合 schema/media-item.schema.json')
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(0)

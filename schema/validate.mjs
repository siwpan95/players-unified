/**
 * players-unified 契约校验器（Node ESM，零三方依赖）
 *
 * 与 schema/validate.py 等价，供 JS 侧（localplayer / PluginPlayer）测试共用，
 * 避免各端各写一份校验逻辑。
 *
 * 仅实现 schema/media-item.schema.json 实际用到的子能力：
 *   $ref / type（含 ["string","null"] 联合）/ enum / required / properties / items
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const SCHEMA_PATH = path.resolve(__dirname, 'media-item.schema.json')

export function loadSchema(p = SCHEMA_PATH) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function typeOk(value, t) {
  switch (t) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && !Number.isNaN(value)
    case 'integer': return Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'array': return Array.isArray(value)
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'null': return value === null
    default: return false
  }
}

export function validate(value, schema, root = schema, p = '') {
  if (schema.$ref) {
    const parts = schema.$ref.replace(/^#\//, '').split('/')
    let target = root
    for (const k of parts) target = target[k]
    return validate(value, target, root, p)
  }
  if (schema.type !== undefined) {
    const t = schema.type
    const ok = Array.isArray(t) ? t.some((x) => typeOk(value, x)) : typeOk(value, t)
    if (!ok) {
      throw new Error(`${p || '<root>'}: 期望类型 ${JSON.stringify(t)}，实际 ${JSON.stringify(value)}`)
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`${p || '<root>'}: 值 ${JSON.stringify(value)} 不在 enum ${JSON.stringify(schema.enum)}`)
  }
  if (schema.required) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${p || '<root>'}: required 需要 object，实际 ${JSON.stringify(value)}`)
    }
    for (const r of schema.required) {
      if (!(r in value)) throw new Error(`${p || '<root>'}: 缺必需字段 ${r}`)
    }
  }
  if (schema.properties && value !== null && typeof value === 'object') {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in value) validate(value[k], sub, root, p ? `${p}.${k}` : k)
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((it, i) => validate(it, schema.items, root, `${p}[${i}]`))
  }
  return true
}

export function validateMediaItem(item, schema) {
  const s = schema || loadSchema()
  return validate(item, s.definitions.MediaItem, s)
}

export function validatePlayerState(state, schema) {
  const s = schema || loadSchema()
  return validate(state, s.definitions.PlayerState, s)
}

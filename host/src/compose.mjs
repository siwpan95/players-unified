/**
 * 合成层：Profile → Bundle → Patch —— 学 dsh 的形态。
 *
 * dsh 的启动配置不是「一个文件」，而是若干层叠出来的：
 *
 *     base（基座）  →  bundles（可复用的一组插件）  →  profile（选了哪些 bundle/参数）
 *                                                  →  patches（有序覆盖层，命令行给）
 *
 * 把每层的 `entries` 按 **分层 id**（`sources:pluginplayer`）合并成一棵树，
 * 再交给 `@cordisjs/plugin-loader` 真正装载。`--dump-config` 打印的是装载**之后**的树。
 *
 * 关于文件格式：dsh 用 YAML，这里用 JSON。原因是没有引第三方 YAML 解析器，
 * 而 Node 原生有 JSON —— 合成语义（分层、覆盖、停用、可寻址）才是要学的东西，
 * 文件语法不是。这个取舍记在这里，免得以后误以为是照抄不全。
 *
 * 层文件结构：
 *   {
 *     "host":    { "root": "..", "defaultProfile": "desktop" },   // 仅基座层有效
 *     "bundles": ["sources"],                                     // 仅 profile 层有效
 *     "entries": [ <EntryOptions 或带 $ 指令> ]
 *   }
 *
 * `$` 前缀的键是**合成指令**：
 *   $group  该条目的 config 是「子条目数组」（等价于 loader 的 EntryGroup，
 *           但**不写** loader 的 `group: true` —— 那会让条目永远无法停用，见 core/group.mjs）
 *   $note   备注，只出现在 dump 里
 *   合成器另外会算出 $layer（最后一次改到该条目的是哪一层）并留在 options 上，
 *   dump 的溯源靠读它；loader 对 options 上多出的键是容忍的（实测确认 options 就是
 *   合成器给的那个对象引用，只有非 group 的 config 会被 interpolate 克隆）。
 *
 * 实现要点：**两阶段**。先在「路径 → 节点」的表上把所有层合并完，再一次性把树构建成
 * loader 能吃的 entries。不要把「构建 loader entries」和「遍历层数据」混在一起 ——
 * 早先那版一边遍历一边往同一个 config 数组里 push，直接把子条目插了两遍。
 */

import fs from 'node:fs'
import path from 'node:path'

export const HOST_DIR = path.resolve(import.meta.dirname, '..')
export const PROFILES_DIR = path.join(HOST_DIR, 'profiles')
export const BUNDLES_DIR = path.join(HOST_DIR, 'bundles')
export const PATCHES_DIR = path.join(HOST_DIR, 'patches')

const DIRECTIVE_PREFIX = '$'
/** loader 的分层 id 分隔符（`EntryTree.sep`），这里刻意保持一致 */
const SEP = ':'

export class ComposeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ComposeError'
  }
}

export function readLayer(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new ComposeError(`读不到层文件 ${file}：${error.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new ComposeError(`层文件不是合法 JSON ${file}：${error.message}`)
  }
}

export function listProfiles(hostDir = HOST_DIR) {
  const dir = path.join(hostDir, 'profiles')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort()
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isDirective = (key) => key.startsWith(DIRECTIVE_PREFIX)

/** 拆出指令与普通 options；同时把 config 深拷贝，避免各层共享同一批对象 */
function splitRaw(raw) {
  const directives = {}
  const options = {}
  for (const [key, value] of Object.entries(raw)) {
    if (isDirective(key)) directives[key.slice(1)] = value
    else if (key === 'config' && Array.isArray(value)) options.config = value.map((c) => ({ ...c }))
    else if (key === 'config' && isPlainObject(value)) options.config = structuredClone(value)
    else options[key] = value
  }
  return { directives, options }
}

/** 合并 config：两个数组按 id 递归合并；两个对象逐键合并；其余后者覆盖 */
function mergeConfig(base, patch) {
  if (Array.isArray(base) && Array.isArray(patch)) {
    const out = base.map((child) => ({ ...child }))
    const at = new Map(out.map((child, i) => [child.id, i]))
    for (const child of patch) {
      const i = child?.id === undefined ? undefined : at.get(child.id)
      if (i === undefined) {
        out.push({ ...child })
        at.set(child?.id, out.length - 1)
      } else {
        out[i] = mergeRaw(out[i], child)
      }
    }
    return out
  }
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out = { ...base }
    for (const [key, value] of Object.entries(patch)) {
      out[key] = isPlainObject(out[key]) && isPlainObject(value) ? mergeConfig(out[key], value) : value
    }
    return out
  }
  return patch
}

/** 合并两个同 id 的层数据（patch 优先，config 深度合并） */
function mergeRaw(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'config' && key in base) out.config = mergeConfig(base.config, value)
    else out[key] = value
  }
  return out
}

/**
 * 合成。返回 { entries, host, profile, layerNames, paths }。
 * `entries` 直接就是 loader 能消费的 EntryOptions 树。
 */
export function compose({ profile, patches = [], hostDir = HOST_DIR } = {}) {
  const layers = []
  const addLayer = (label, data) => layers.push({ label, data })

  addLayer('cordis.json', readLayer(path.join(hostDir, 'cordis.json')))
  const base = layers[0].data

  const host = { root: '..', defaultProfile: 'desktop', ...(base.host ?? {}) }
  const profileName = profile ?? host.defaultProfile
  if (!profileName) throw new ComposeError('没有指定 profile，且基座层没有 defaultProfile')

  const profileFile = path.join(hostDir, 'profiles', `${profileName}.json`)
  if (!fs.existsSync(profileFile)) {
    throw new ComposeError(`未知 profile：${profileName}（可选：${listProfiles(hostDir).join(', ') || '无'}）`)
  }
  const profileLayer = readLayer(profileFile)

  // bundle 先铺，再叠 profile 自己的 entries：与 dsh「profile 选 bundle，再局部改」一致
  for (const bundleName of profileLayer.bundles ?? []) {
    const bundleFile = path.join(hostDir, 'bundles', `${bundleName}.json`)
    if (!fs.existsSync(bundleFile)) throw new ComposeError(`profile ${profileName} 引用了不存在的 bundle：${bundleName}`)
    addLayer(`bundles/${bundleName}.json`, readLayer(bundleFile))
  }
  addLayer(`profiles/${profileName}.json`, { entries: profileLayer.entries ?? [] })

  for (const p of patches) {
    const file = path.isAbsolute(p) ? p : path.resolve(p)
    addLayer(`patches/${path.basename(file)}`, readLayer(file))
  }

  /* ================= 阶段 1：在「路径 → 节点」表上合并所有层 ================= */
  /** path -> { raw, isGroup, children: string[] } */
  const nodes = new Map()
  const roots = []

  const insert = (raw, parentPath, layerLabel) => {
    if (!raw?.id) throw new ComposeError(`层 ${layerLabel} 里的条目缺少 id：${JSON.stringify(raw)}`)
    const { directives, options } = splitRaw(raw)
    // 层里可以用分层路径寻址（`sources:pluginplayer`），但条目**自身**的 id 必须是最后一段：
    // loader 装载时会自己再拼上父条目的 id。若把完整路径当 id 存回去，装载后就变成
    // `sources:sources:pluginplayer`（实测踩过，dump 里一眼可见）。
    const declared = options.id
    const localId = declared.includes(SEP) ? declared.slice(declared.lastIndexOf(SEP) + 1) : declared
    const declaredPrefix = declared.includes(SEP) ? declared.slice(0, declared.lastIndexOf(SEP)) : null
    if (declaredPrefix && parentPath && declaredPrefix !== parentPath) {
      throw new ComposeError(`层 ${layerLabel}：条目 id ${declared} 的路径前缀与所在分组 ${parentPath} 不一致`)
    }
    options.id = localId
    const fullPath = parentPath ? `${parentPath}${SEP}${localId}` : declared
    const existing = nodes.get(fullPath)

    if (existing) {
      if (options.name && existing.raw.name && options.name !== existing.raw.name) {
        throw new ComposeError(
          `层 ${layerLabel} 想把 ${fullPath} 的插件从 ${existing.raw.name} 换成 ${options.name}` +
          '（只允许改 config/disabled，不允许在覆盖层改插件本体）',
        )
      }
      existing.raw = mergeRaw(existing.raw, options)
      existing.raw.$layer = layerLabel
      if (directives.group) existing.isGroup = true
      if (directives.note) existing.raw.$note = directives.note
    } else {
      if (parentPath && !nodes.has(parentPath)) {
        throw new ComposeError(`层 ${layerLabel} 想覆盖 ${fullPath}，但父级 ${parentPath} 不存在（需先由基座/bundle 建出父级）`)
      }
      const node = {
        raw: { ...options, $layer: layerLabel, ...(directives.note ? { $note: directives.note } : {}) },
        isGroup: !!directives.group,
        children: [],
      }
      nodes.set(fullPath, node)
      if (parentPath) {
        const parent = nodes.get(parentPath)
        parent.children.push(fullPath)
      } else {
        roots.push(fullPath)
      }
    }

    // 子条目：**遍历快照**，并且只往 nodes 表里写，绝不改动 authored 数组
    const authored = Array.isArray(raw.config) ? raw.config : []
    for (const child of authored) insert(child, fullPath, layerLabel)
  }

  for (const layer of layers) {
    for (const raw of layer.data.entries ?? []) insert(raw, null, layer.label)
  }

  /* ================= 阶段 2：构建 loader 能吃的树 ================= */
  const build = (fullPath) => {
    const node = nodes.get(fullPath)
    const out = {}
    for (const [key, value] of Object.entries(node.raw)) {
      if (!isDirective(key)) out[key] = value
    }
    out.$layer = node.raw.$layer
    if (node.raw.$note) out.$note = node.raw.$note
    if (node.isGroup) out.config = node.children.map(build)
    return out
  }

  const paths = [...nodes.keys()]
  return {
    entries: roots.map(build),
    host,
    profile: profileName,
    layerNames: layers.map((l) => l.label),
    paths,
  }
}

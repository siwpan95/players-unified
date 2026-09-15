/**
 * `--dump-config` 的渲染。
 *
 * 关键点：渲染的是**启动之后**的 loader 树（`ctx.loader.entries()`），不是在文件里
 * 拼出来的理想配置。dsh 的 `--dump-config` 之所以有用，就是因为它打印的是「实际启动了
 * 什么、被谁改过、现在是不是活的」，而不是「我以为我配了什么」。
 * 所以这里同时给出三样东西：
 *   · 装载顺序（DFS 先序，父条目紧跟其子）
 *   · $layer —— 最后一次改到该条目的是哪一层（Profile/Patch 的实际效果一目了然）
 *   · active —— 该条目当前是否真的装载着（fiber 活着）
 */

/** 需要打码的 config 键：令牌绝不落到终端或日志里 */
const SECRET_KEY = /token|secret|password|passwd|credential|apikey|api_key/i

export function redact(value, key = '') {
  if (SECRET_KEY.test(key)) return value ? '***（已设置）' : ''
  if (Array.isArray(value)) return value.map((v) => redact(v, key))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]))
  }
  return value
}

function fmtConfig(config, indent) {
  if (config === undefined) return []
  const pad = ' '.repeat(indent)
  if (Array.isArray(config)) {
    return config.flatMap((item, i) => [`${pad}[${i}]`, ...fmtConfig(item, indent + 2)])
  }
  if (config && typeof config === 'object') {
    return Object.entries(config).flatMap(([k, v]) => {
      const rv = redact(v, k)
      if (rv && typeof rv === 'object') return [`${pad}${k}:`, ...fmtConfig(rv, indent + 2)]
      return [`${pad}${k}: ${JSON.stringify(rv)}`]
    })
  }
  return [`${pad}${JSON.stringify(config)}`]
}

/** FiberState.ACTIVE —— cordis 的 Fiber.state 是数字枚举（PENDING=0 LOADING=1 ACTIVE=2 FAILED=3 DISPOSED=4） */
const FIBER_ACTIVE = 2

/** 从启动后的 loader 收集条目信息（只在 dump 时遍历一次） */
export function collectEntries(loader) {
  const out = []
  const walk = (tree, depth) => {
    for (const entry of Object.values(tree.store)) {
      const options = entry.options ?? {}
      out.push({
        id: entry.id,
        name: options.name,
        depth,
        layer: options.$layer,
        note: options.$note,
        disabled: entry.disabled,
        active: entry.fiber?.state === FIBER_ACTIVE,
        hasChildren: !!entry.subtree,
        config: redact(options.config),
      })
      if (entry.subtree) walk(entry.subtree, depth + 1)
    }
  }
  walk(loader, 0)
  return out
}

export function renderText({ profile, layers, host, entries, sources }) {
  const lines = []
  lines.push('# players-unified host')
  lines.push(`# profile : ${profile}`)
  lines.push(`# 层      : ${layers.join('  →  ')}`)
  lines.push(`# root    : ${host.root}`)
  lines.push('#')
  lines.push('# 条目（来自实际启动后的 loader 树；顺序 = 装载顺序，深度优先先序）')
  for (const e of entries) {
    const indent = '  '.repeat(e.depth)
    const flags = [e.disabled ? 'disabled' : null, e.active ? 'active' : 'inactive'].filter(Boolean).join(' ')
    lines.push(`${indent}${e.id}${' '.repeat(Math.max(1, 34 - indent.length - e.id.length))}${e.name}   [${flags}]${e.layer ? `  ← ${e.layer}` : ''}`)
    if (e.note) lines.push(`${indent}  # ${e.note}`)
    // 有子条目的条目不再重复打印 config（其 config 就是子条目列表，下面已经逐条列出）
    if (e.hasChildren) {
      lines.push(`${indent}  (子条目 ${e.config?.length ?? 0} 个，见下)`)
      continue
    }
    for (const l of fmtConfig(e.config, indent.length + 4)) lines.push(l)
  }
  if (sources) {
    lines.push('#')
    lines.push(`# ctx.media 已注册来源（${sources.length}）：`)
    for (const s of sources) {
      const mark = s.ok === undefined ? '' : s.ok ? `  ok=${s.count}` : `  error=${s.error}`
      lines.push(`#   ${s.id.padEnd(16)} ${s.label}${mark}`)
    }
  }
  return lines.join('\n') + '\n'
}

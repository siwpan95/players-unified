/**
 * `ctx.media` —— 宿主的核心服务：媒体来源的注册表 + 聚合 + 深链分发。
 *
 * 这是 launcher 里那套 `aggregate()/planOpen()` 逻辑在 Cordis 里的形态：
 *   · 聚合逻辑不变（保证与 launcher 输出可比），但从「一个函数遍历 config.sources」
 *     变成「一个服务 + 若干 source 插件各自把自己注册进来」。
 *   · 来源的注册是**可撤销副作用**：source 插件用 `ctx.effect` 包住 `define()`，
 *     插件被停用/卸载时来源自动摘掉。这就是 Cordis「一切都是可插拔副作用」的用法，
 *     也是 Profile/Patch 能整组开关来源的前提。
 *
 * config: { root?: string }  —— 相对路径解析基准，默认 '..'（即仓库根）
 */

import path from 'node:path'
import { Service } from 'cordis'
import { createTransport } from './transport.mjs'
import { HOST_DIR } from '../compose.mjs'

export const name = 'media'

export class MediaService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'media')
    const root = path.isAbsolute(config.root ?? '')
      ? config.root
      : path.resolve(HOST_DIR, config.root ?? '..')
    this.root = root
    this.transport = createTransport(root)
    /** id -> { id, label, priority, list, planOpen, descriptor } */
    this.sources = new Map()
    this.lastAggregate = null
  }

  /**
   * 注册一个来源。返回撤销函数；调用方应当用 `ctx.effect` 包住，让插件卸载时自动摘除。
   * 同 id 重复注册是错误（而不是静默覆盖）—— 分层覆盖应当发生在**合成阶段**，
   * 而不是靠运行时互相顶掉。
   */
  define(def) {
    if (!def?.id) throw new Error('media.define 需要一个 id')
    if (this.sources.has(def.id)) {
      throw new Error(`来源 ${def.id} 已注册（来自 ${this.sources.get(def.id).registeredBy}）`)
    }
    const entry = { ...def, registeredBy: this.ctx.fiber.name }
    this.sources.set(def.id, entry)
    return () => this.sources.delete(def.id)
  }

  ids() {
    return [...this.sources.keys()]
  }

  get(id) {
    return this.sources.get(id)
  }

  /** 供 aggregate 用的 launcher 同形描述符数组 */
  descriptors() {
    return [...this.sources.values()].map((s) => ({
      id: s.id,
      label: s.label,
      list: s.list,
      open: s.descriptor?.open ?? { kind: 'custom' },
    }))
  }

  /** 与 launcher `aggregate()` 同形、同序：{ sources, items, total, generatedAt } */
  async aggregate() {
    const result = await this.transport.aggregate(this.descriptors())
    this.lastAggregate = result
    return result
  }

  /** 纯决策，不产生副作用 —— 与 launcher 的 `planOpen(src,item)` 等价 */
  planOpen(sourceId, item) {
    const src = this.sources.get(sourceId)
    if (!src) throw new Error(`未注册的来源：${sourceId}`)
    return src.planOpen(item)
  }

  /**
   * 执行深链。`dryRun` 时只返回计划动作。
   * 与 launcher /api/open 的行为对齐：browser 动作由前端 `window.open` 完成，宿主不执行。
   */
  async open(sourceId, item, { dryRun = false } = {}) {
    const src = this.sources.get(sourceId)
    if (!src) return { ok: false, error: `未注册的来源：${sourceId}` }
    const action = src.planOpen(item)
    if (dryRun) return { ok: true, action, executed: false, dryRun: true }

    if (action.action === 'rpc') {
      const open = src.descriptor?.open ?? {}
      const token = open.token ? open.token : this.transport.readToken(open.tokenFile)
      await this.transport.rpcOpen(action, token)
      return { ok: true, action, executed: true, dryRun: false }
    }
    if (action.action === 'spawn') {
      this.transport.spawnOpen(action)
      return { ok: true, action, executed: true, dryRun: false }
    }
    return {
      ok: true,
      action,
      executed: false,
      dryRun: false,
      note: action.action === 'browser' ? 'browser 动作由前端 window.open 打开' : null,
    }
  }
}

export default MediaService

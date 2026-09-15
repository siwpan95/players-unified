/**
 * 分组插件（宿主自建）—— 一个真正的「子配置树」。
 *
 * 为什么不用 loader 自带的 `Group`：
 *   实测（tests/loader-semantics.mjs §2）证明 `Group` 的子条目注册在**根 store**，
 *   id 不加前缀、`resolve('父:子')` 直接失败 —— 它只是「逻辑分组」，不是「嵌套树」。
 *   而分层 id 恰恰来自 `EntryTree` 构造函数里的 `ctx.fiber.entry.subtree = this`：
 *   只有**插件自己 new 一个 EntryTree**，子条目的 `Entry.id` 才会取到
 *   `父条目id + ':' + 子id`（见 loader 的 `get id()`）。
 *
 *   Profile → Bundle → Patch 的分层覆盖要能按路径寻址（`sources:pluginplayer`），
 *   依赖的就是这个嵌套树，所以这里自建一个。
 *
 * 顺带拿到 `EntryTree.commit(change)` —— 它是 loader 的「树上变更事件」钩子，
 * 每次 create/update/remove 都被同步调用，携带
 *   { id, group, from?, options?, legacy? }
 * 这是 `--dump-config` 能回答「这个条目来自哪一层、被哪一层改过」的依据。
 */

import { EntryTree } from '@cordisjs/plugin-loader'

/**
 * 子配置树：把树上的每次变更记进 `changes`，供 dump 溯源。
 * `EntryTree` 在 JS 侧可实例化，但 create/update/remove 会调用 `commit()`，
 * 而它在 TS 里是 abstract，所以这里必须实现。
 */
export class Subtree extends EntryTree {
  constructor(ctx, onCommit) {
    super(ctx)
    this.onCommit = onCommit
    this.changes = []
  }

  commit(change) {
    this.changes.push({
      id: change.id,
      action: change.options ? (change.legacy ? 'update' : 'create') : 'remove',
    })
    this.onCommit?.(change)
  }
}

/**
 * 以插件形式使用；config 是子条目数组（EntryOptions[]）。
 *
 * ⚠️ 两个实测踩到的坑（都记在这里，别再踩）：
 *
 * 1) **不要在条目 options 里写 `group: true`。**
 *    loader 的 `Entry.disabled` 第一行就是 `if (this.options.group) return false` ——
 *    带这个标记的条目**永远不可停用**，`update(id,{disabled:true})` 会被静默忽略，
 *    整组停用因此失效。而 `_resolveConfig` 认的是 `EntryGroup.key` 这个 symbol，
 *    与 `group: true` 无关，所以不写它照旧被当作 group 处理。
 *    不写 → 整组可停用（Profile/Patch 需要「整个 bundle 关掉」这个能力）。
 *
 * 2) **apply 不能是 async、也不能返回非函数值。**
 *    cordis 的 `Fiber._execute` 会把插件回调的返回值当副作用校验：返回 Promise 时
 *    走 `then(safeCollect)`，resolve 出的值必须是函数或 null，否则抛
 *    `TypeError: Invalid effect`。异步 apply 若 `return tree` 就会踩这个坑，
 *    而且症状会以「子树没注册进 entries()」这种不相干的形式表现，极难定位。
 *    装载是异步的，但 `EntryTree.getTasks()` 会把子条目的 `_initTask` 交出去，
 *    `await ctx.loader.await()` 自然会等到它们落地。
 *
 * 本插件带 `EntryGroup.key` 标记 → loader 的 `_resolveConfig` 会**原样**返回 config
 * （不做 interpolate），这样子条目对象保持同一引用，层级标记 `$layer` 不会丢。
 */
export function apply(ctx, config) {
  const tree = new Subtree(ctx)
  // 让嵌套树跟随 loader 的日志开关（否则 --trace 只看得到顶层条目的装载）
  tree.enableLogs = ctx.loader?.enableLogs === true
  const children = Array.isArray(config) ? config : []

  ctx.effect(() => () => {
    // 逆序卸载，且**串行 await**：`fiber.dispose()` 是异步的，只保证「发起顺序」不足以
    // 保证「完成顺序」。串行 await 才能让清理顺序确定，dump 出来的树才是确定性的。
    //
    // 只遍历**本树的直接子条目**（`tree.store`），不用递归的 `tree.entries()`：
    // 后者的外层循环会把嵌套子树的条目也算进来，导致 `a:b` 被外层和内层各 dispose 一次
    // （实测 trace 里 `sources:web:remote` 出现两次）。嵌套组由它自己的清理负责收回自己的
    // 子树，所以只处理直接子条目既去掉了重复，又保持了「先拆子树再拆前面的兄弟」的顺序。
    // HOST_TRACE=1 可打印实际卸载发起顺序。
    return (async () => {
      const order = Object.values(tree.store).reverse()
      // 把「卸载发起顺序」发出来：cordis 的 `dispose()` 不 await 各 effect 返回的 promise，
      // 所以**完成**顺序不确定；能被确定保证、也值得断言的是**发起**顺序。
      ctx.emit('host/group-teardown', order.map((entry) => entry.id))
      let seq = 0
      for (const entry of order) {
        if (process.env.HOST_TRACE) console.error(`[group] dispose#${seq++} ${entry.id}`)
        try {
          await entry.fiber?.dispose()
        } catch (error) {
          ctx.logger?.warn?.(error)
        }
      }
      // 清掉嵌套树内的记录：否则 loader.entries() 仍会顺着 entry.subtree 吐出已死条目
      tree.root.stop()
    })()
  })

  // 子条目按声明顺序装载（不 await：交给 loader.await() 统一收敛）
  for (const child of children) tree.create({ ...child })
  ctx.emit('host/group-ready', tree)
}

/**
 * ⚠️ 插件用**对象形态**导出（`{ name, inject, apply }`），而不是「函数 + 模块级
 *    `export const inject`」。原因：loader 的 `unwrapExports()` 会把 `default` 取成
 *    插件本体，模块级的 `inject` 留在 namespace 上根本传不到 registry ——
 *    fiber 的 inject 会变成空，插件访问 `ctx.media` 时直接以 FAILED 收场。
 *    对象形态是 cordis 拿 `name`/`inject` 的正规位置（见 registry.plugin：
 *    `plugin.name` 与 `Inject.resolve(plugin.inject)`）。
 *    另外函数/类的 `name` 属性是 `writable: false`，`apply.name = ...` 在严格模式下
 *    会直接抛 TypeError —— 别用赋值改名字。
 */
export default {
  name: 'group',
  // 让 loader 认它是 group（该标记在 loader 里唯一用途即 _resolveConfig）
  [Symbol.for('cordis.group')]: true,
  apply,
}

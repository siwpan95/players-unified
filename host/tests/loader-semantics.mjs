/**
 * loader 语义探针 —— 在写宿主之前，先把 `@cordisjs/plugin-loader` 的关键语义
 * **实测**出来，而不是照着 .d.ts 猜。只依赖 loader + cordis + 我们自己写的
 * `src/core/group.mjs`，不依赖宿主其它部分。
 *
 * 被测假设：
 *   H1  自带 `Group`（name='cordis:group'）只是**逻辑分组**：子条目注册在根 store，
 *       id 不带前缀，`resolve('父:子')` 失败  ← 实测结论，宿主的 group 因此自建
 *   H2  自建 group（插件内 new EntryTree）产生**嵌套树**：id 形如 `父:子`、
 *       `resolve('父:子')` 可用、可递归嵌套
 *   H3  update(id,{config}) 重载条目；update(id,{disabled}) 卸载/重装
 *   H4  create(parent)/remove(id) 动态增删；条目停用后其子树不得再被视为活的
 *   H5  await() 能把所有初始化任务等到落地
 *   H6  逆序卸载：group 卸载时子条目按相反顺序释放
 *
 * 运行：node host/tests/loader-semantics.mjs
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader, { Group } from '@cordisjs/plugin-loader'

const HOST_DIR = path.resolve(import.meta.dirname, '..')
const BASE_URL = pathToFileURL(path.join(HOST_DIR, 'cordis.json')).href
const ECHO = './tests/fixtures/echo.mjs'
const OUR_GROUP = './src/core/group.mjs'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `\n        ${detail}`}`)
}

const log = () => (globalThis.__ECHO_LOG ??= [])
const names = (event) => log().filter((e) => e.event === event).map((e) => e.id)
const ids = () => [...ctx.loader.entries()].map((e) => e.id)

console.log('== loader 语义探针 ==')
console.log(`BASE_URL   = ${BASE_URL}`)
console.log(`OUR_GROUP  = ${OUR_GROUP}\n`)

/* ---------- 1. 接线 ---------- */
const ctx = new Context()
/** 卸载发起顺序：group 插件在清理时发出（完成顺序由 cordis 异步调度，不作断言） */
const teardowns = []
ctx.on('host/group-teardown', (ids) => teardowns.push(ids))
await ctx.plugin(Loader, { baseUrl: BASE_URL })
check('H0 ctx.loader 由 ctx.plugin(Loader) 提供', !!ctx.loader, `loader.name = ${ctx.loader?.name}`)
console.log(`     loader.internal = ${ctx.loader.internal ? `ModuleLoader(${ctx.loader.internal.version})` : 'undefined → 裸名走 .cordis/resolve.mjs 回退'}`)

await ctx.loader.create({ id: 'alpha', name: ECHO, config: { n: 1 } })
await ctx.loader.await()
check('H0 扁平条目已装载', names('apply').includes('alpha'), `applied = ${JSON.stringify(names('apply'))}`)

/* ---------- 2. 自带 Group：确认为平铺 ---------- */
// `cordis:xxx` 走 loader.builtins，而 builtins 在 loader 里**从不被填充**
// （new Loader 只初始化成空对象）。不注册的话 import('cordis:group') 返回 undefined，
// 随后 _resolveConfig(undefined) 直接抛 TypeError —— 下面这行是必需的。
ctx.loader.builtins.group = Group
await ctx.loader.create({
  id: 'builtinGroup',
  name: 'cordis:group',
  group: true,
  config: [
    { id: 'bg1', name: ECHO, config: { n: 2 } },
    { id: 'bg2', name: ECHO, config: { n: 3 } },
  ],
})
await ctx.loader.await()
const flatIds = ids()
console.log(`\n     entries() = ${JSON.stringify(flatIds)}`)
check('H1 自带 Group 的子条目**不带**分层前缀（平铺在根 store）',
  flatIds.includes('bg1') && !flatIds.includes('builtinGroup:bg1'))
check('H1 resolve("builtinGroup:bg1") 因此失败',
  (() => { try { ctx.loader.resolve('builtinGroup:bg1'); return false } catch { return true } })())
check('H1 但 resolveGroup("builtinGroup") 可拿到逻辑分组',
  (() => {
    try {
      const g = ctx.loader.resolveGroup('builtinGroup')
      return g.data.map((o) => o.id).join(',') === 'bg1,bg2'
    } catch { return false }
  })())
console.log('     → 结论：Group 不提供分层寻址，宿主的分组改用自建嵌套树\n')

/* ---------- 3. 自建 group：嵌套树 ---------- */
// 注意：这里**不写** `group: true` —— loader 的 `Entry.disabled` 对 options.group 为真的
// 条目直接 return false，写了就永远停用不了（见 src/core/group.mjs 顶部说明）。
await ctx.loader.create({
  id: 'sources',
  name: OUR_GROUP,
  config: [
    { id: 'pp', name: ECHO, config: { n: 10 } },
    { id: 'lp', name: ECHO, config: { n: 11 } },
    {
      id: 'web',
      name: OUR_GROUP,
      config: [{ id: 'remote', name: ECHO, config: { n: 12 } }],
    },
  ],
})
await ctx.loader.await()

const nestedIds = ids()
console.log(`     entries() = ${JSON.stringify(nestedIds)}`)
check('H2 自建 group 的子条目 id 带分层前缀',
  nestedIds.includes('sources:pp') && nestedIds.includes('sources:lp'),
  `applied = ${JSON.stringify(names('apply'))}`)
check('H2 支持递归嵌套（两层）', nestedIds.includes('sources:web:remote'))
check('H2 子条目确实被 apply', names('apply').includes('sources:pp'))
check('H2 条目顺序 = 深度优先先序（父紧跟其子）',
  nestedIds.slice(-5).join(',') === 'sources,sources:pp,sources:lp,sources:web,sources:web:remote',
  `尾部 = ${JSON.stringify(nestedIds.slice(-5))}`)

let resolved = null
try {
  const e = ctx.loader.resolve('sources:pp')
  resolved = { id: e.id, n: e.options.config.n }
} catch (err) {
  resolved = { error: String(err.message) }
}
check('H2 resolve("sources:pp") 可用', resolved.id === 'sources:pp', JSON.stringify(resolved))

let deep = null
try {
  deep = ctx.loader.resolve('sources:web:remote').options.config.n
} catch (err) {
  deep = String(err.message)
}
check('H2 resolve 可穿透两层嵌套', deep === 12, `n = ${JSON.stringify(deep)}`)

check('H2 resolveGroup("sources") 拿到自建子组（可见 create）',
  (() => {
    try {
      const g = ctx.loader.resolveGroup('sources')
      return g.data.map((o) => o.id).join(',') === 'pp,lp,web' && typeof g.create === 'function'
    } catch { return false }
  })())

/* ---------- 4. update config / disabled ---------- */
const mark = () => log().length
let t = mark()
await ctx.loader.update('alpha', { config: { n: 9 } })
await ctx.loader.await()
check('H3 update(config) 触发卸载+重装',
  log().slice(t).map((e) => `${e.event}:${e.id}`).join('>') === 'dispose:alpha>apply:alpha',
  `日志 = ${JSON.stringify(log().slice(t).map((e) => e.event + ':' + e.id))}`)
check('H3 新 config 生效', ctx.loader.resolve('alpha').options.config.n === 9)

t = mark()
await ctx.loader.update('alpha', { disabled: true })
await ctx.loader.await()
check('H3 disabled:true 卸载条目', log().slice(t).some((e) => e.event === 'dispose' && e.id === 'alpha'),
  `日志 = ${JSON.stringify(log().slice(t).map((e) => e.event + ':' + e.id))}`)
check('H3 disabled 状态可读', ctx.loader.resolve('alpha').disabled === true)
check('H3 停用后条目仍在树里（不是被删除）', ids().includes('alpha'))

await ctx.loader.update('alpha', { disabled: false })
await ctx.loader.await()
check('H3 disabled:false 重新装载', names('apply').filter((i) => i === 'alpha').length >= 3,
  `alpha apply 次数 = ${names('apply').filter((i) => i === 'alpha').length}`)

/* ---------- 5. 停用整组 → 子树不得再算活的 ---------- */
t = mark()
teardowns.length = 0
await ctx.loader.update('sources', { disabled: true })
await ctx.loader.await()
const afterDisable = ids()
console.log(`\n     停用 sources 后 entries() = ${JSON.stringify(afterDisable)}`)
console.log(`     卸载发起顺序（事件）= ${JSON.stringify(teardowns)}`)
check('H4 停用整组会释放全部子条目（含两层嵌套）',
  ['sources:pp', 'sources:lp', 'sources:web', 'sources:web:remote'].every((i) =>
    teardowns.flat().includes(i) || log().slice(t).some((e) => e.event === 'dispose' && e.id === i)))
check('H4 停用整组后子条目不再出现在 entries()',
  !afterDisable.some((i) => i.startsWith('sources:')))
check('H6 本树按「逆声明顺序」卸载（web 先于 lp 先于 pp）',
  JSON.stringify(teardowns[0]) === JSON.stringify(['sources:web', 'sources:lp', 'sources:pp']),
  `第一个 teardown 事件 = ${JSON.stringify(teardowns[0])}`)
check('H6 嵌套组被拆时连同其整棵子树一起拆（web 子树先于前面的兄弟）',
  teardowns.length === 2
  && JSON.stringify(teardowns[1]) === JSON.stringify(['sources:web:remote'])
  && teardowns[0][0] === 'sources:web',
  `全部 teardown 事件 = ${JSON.stringify(teardowns)}`)

t = mark()
await ctx.loader.update('sources', { disabled: false })
await ctx.loader.await()
check('H4 整组重新启用后子条目回来',
  names('apply').slice(-3).some((i) => i === 'sources:web:remote'),
  `最后 3 条 apply = ${JSON.stringify(names('apply').slice(-3))}`)

/* ---------- 6. create(parent) / remove ---------- */
await ctx.loader.create({ id: 'extra', name: ECHO, config: { n: 20 } }, 'sources')
await ctx.loader.await()
check('H5 create(parent="sources") 挂到子组', ids().includes('sources:extra'),
  `entries = ${JSON.stringify(ids())}`)

t = mark()
ctx.loader.remove('sources:extra')
await ctx.loader.await()
check('H5 remove 卸下条目',
  !ids().includes('sources:extra') && log().slice(t).some((e) => e.event === 'dispose' && e.id === 'sources:extra'),
  `日志 = ${JSON.stringify(log().slice(t).map((e) => e.event + ':' + e.id))}`)

/* ---------- 7. locate ---------- */
const alphaFiber = ctx.loader.resolve('alpha').fiber
check('H0 locate 可反查 fiber 所属条目 id', ctx.loader.locate(alphaFiber) === 'alpha',
  `locate(alpha.fiber) = ${ctx.loader.locate(alphaFiber) ?? '(未解析)'}`)
check('H0 locate 可穿透嵌套条目', ctx.loader.locate(ctx.loader.resolve('sources:pp').fiber) === 'sources:pp',
  `locate(sources:pp.fiber) = ${ctx.loader.locate(ctx.loader.resolve('sources:pp').fiber) ?? '(未解析)'}`)

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.ok)
console.log(`\n== 汇总：${results.length - failed.length}/${results.length} 通过 ==`)
for (const f of failed) console.log(`  FAIL  ${f.name}`)
process.exit(failed.length ? 1 : 0)

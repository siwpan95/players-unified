/**
 * 血音来源验收（P1 生态收编）—— BloodMusic 生成物进统一编排层。
 *
 * 实测三件事（不是静态检查）：
 *   1. bloodmusic 来源真实枚举：count > 0 且首项契约字段齐全（MediaItem）
 *   2. 深链转换：planOpen 把 Windows 绝对路径转成 file:/// URI（浏览器可开）
 *   3. 来源注册随插件生命周期：停用条目 → 自动摘除；恢复 → 自动回来
 *      （ctx.effect 回收语义，来源插件的标准形态）
 *
 * 启动方式与 src/cli.mjs 一致（compose → Loader → create → await）。
 * 运行：node tests/bloodmusic-source.mjs
 */

import { strict as assert } from 'node:assert'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { compose, HOST_DIR } from '../src/compose.mjs'

async function main() {
  const composed = compose({ profile: 'desktop' })

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(path.join(HOST_DIR, 'cordis.json')).href
  await ctx.plugin(Loader, { baseUrl: ctx.baseUrl })
  for (const entry of composed.entries) await ctx.loader.create(entry)
  await ctx.loader.await()

  const results = []
  const check = (name, fn) => results.push((async () => {
    try { await fn(); process.stdout.write(`✓ ${name}\n`); return true } catch (e) { process.stdout.write(`✗ ${name}\n    ${e.message}\n`); return false }
  })())

  try {
    check('bloodmusic 来源已注册', () => {
      assert(ctx.media.ids().includes('bloodmusic'), `ids: ${ctx.media.ids()}`)
    })

    check('枚举产出 MediaItem[]（count > 0，契约字段齐全）', async () => {
      const { items } = await ctx.media.aggregate()
      const bm = items.filter((i) => i._end === 'bloodmusic')
      assert(bm.length > 0, 'bloodmusic 枚举为空')
      const it = bm[0]
      for (const field of ['id', 'uri', 'title', 'kind', 'source']) {
        assert(it[field] != null, `缺字段 ${field}`)
      }
      assert(it.source === 'bloodmusic' && it.kind === 'audio', `字段值异常: ${it.source}/${it.kind}`)
    })

    check('深链：Windows 绝对路径 → file:/// URI', async () => {
      const { items } = await ctx.media.aggregate()
      const bm = items.filter((i) => i._end === 'bloodmusic')
      const action = ctx.media.planOpen('bloodmusic', bm[0])
      assert(action.action === 'browser', `action=${action.action}`)
      assert(/^file:\/\/\/[A-Za-z]:\//.test(action.url), `url 不是 file URI: ${action.url}`)
    })

    check('来源注册随插件停用自动摘除（effect 回收）', async () => {
      await ctx.loader.update('sources:bloodmusic', { disabled: true })
      await ctx.loader.await()
      await new Promise((r) => setTimeout(r, 300))
      assert(!ctx.media.ids().includes('bloodmusic'), '停用后仍注册')
      await ctx.loader.update('sources:bloodmusic', { disabled: false })
      await ctx.loader.await()
      await new Promise((r) => setTimeout(r, 300))
      assert(ctx.media.ids().includes('bloodmusic'), '恢复后未注册回来')
    })

    const outcomes = await Promise.all(results)
    /* 收尾与 src/cli.mjs 同形：逆序 remove 所有根条目，触发 effect 清理（web 端口等） */
    for (const id of Object.keys(ctx.loader.store)) {
      try { await ctx.loader.remove(id) } catch { /* 单条失败不阻断退出 */ }
    }
    return outcomes.every(Boolean) ? 0 : 1
  } catch (error) {
    console.error(error)
    for (const id of Object.keys(ctx.loader.store)) {
      try { await ctx.loader.remove(id) } catch { /* ignore */ }
    }
    return 1
  }
}

main()
  .then((code) => {
    process.exitCode = code
    setTimeout(() => process.exit(code), 2000).unref()
  })

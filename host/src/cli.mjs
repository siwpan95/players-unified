#!/usr/bin/env node
/**
 * players-unified 统一 Cordis 宿主 —— 入口（形态参考 deepseek harness / dsh）。
 *
 * 用法：
 *   node src/cli.mjs --profile desktop --dump-config          # 打印实际启动后的配置树
 *   node src/cli.mjs --profile desktop --dump-config=json     # 机器可读
 *   node src/cli.mjs --profile desktop --aggregate            # 跑一遍聚合（真的去连各来源）
 *   node src/cli.mjs --profile library-only --check           # 门禁：所有启用的条目都必须真的活着
 *   node src/cli.mjs --list-profiles
 *   node src/cli.mjs --profile desktop --patch patches/local-fast.json --dump-config
 *
 * 合成语义（基座 → bundle → profile → patch 有序覆盖）见 src/compose.mjs。
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

import { compose, ComposeError, listProfiles, HOST_DIR } from './compose.mjs'
import { collectEntries, renderText } from './dump.mjs'
import { attachConsoleLogger } from './logging.mjs'

function parseArgv(argv) {
  const out = { patches: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const [key, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    switch (key) {
      case '--profile': out.profile = inline ?? argv[++i]; break
      case '--patch': out.patches.push(inline ?? argv[++i]); break
      case '--dump-config': out.dump = inline ?? true; break
      case '--aggregate': out.aggregate = inline ?? true; break
      case '--check': out.check = true; break
      case '--list-profiles': out.listProfiles = true; break
      case '--open': out.open = inline ?? argv[++i]; break
      case '--dry-run': out.dryRun = true; break
      case '--host-dir': out.hostDir = inline ?? argv[++i]; break
      case '--json': out.json = true; break
      case '--trace': out.trace = true; break
      case '--help': case '-h': out.help = true; break
      default:
        if (arg.startsWith('-')) throw new ComposeError(`无法识别的参数：${arg}`)
    }
  }
  return out
}

const HELP = `players-unified Cordis 宿主

  --profile <name>        选择 profile（默认取基座层的 host.defaultProfile）
  --patch <file>          叠加一个 patch 层，可重复；按命令行顺序生效
  --dump-config[=json]    打印实际启动后的配置树
  --aggregate[=json]      跑一遍 ctx.media.aggregate()（会真的去连各来源）
  --open <itemId>         执行一次深链跳转（需先 --aggregate 拿到 id）
  --dry-run               配合 --open：只返回计划动作，不产生副作用
  --check                 门禁：所有启用的条目都必须真的装载成功
  --list-profiles         列出可用 profile
  --host-dir <dir>        指定宿主目录（默认本文件所在目录的上一级）
  --trace                 打印 loader 的装载/卸载日志
`

async function main() {
  const args = parseArgv(process.argv.slice(2))
  const hostDir = args.hostDir ? path.resolve(args.hostDir) : HOST_DIR

  if (args.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (args.listProfiles) {
    for (const p of listProfiles(hostDir)) process.stdout.write(p + '\n')
    return 0
  }

  const composed = compose({ profile: args.profile, patches: args.patches, hostDir })

  /* ---------- 启动 loader ---------- */
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(path.join(hostDir, 'cordis.json')).href
  // 不接日志的话，插件装载失败会完全静默 —— 见 src/logging.mjs 的说明
  attachConsoleLogger(ctx, { level: args.trace ? 'debug' : 'info', color: !process.env.NO_COLOR })
  await ctx.plugin(Loader, { baseUrl: ctx.baseUrl })
  if (args.trace) ctx.loader.enableLogs = true

  for (const entry of composed.entries) await ctx.loader.create(entry)
  await ctx.loader.await()

  /* ---------- 动作 ---------- */
  const entries = collectEntries(ctx.loader)
  const media = ctx.media
  const codes = []

  const wantDump = args.dump !== undefined || (!args.aggregate && !args.check && !args.open)
  if (wantDump) {
    const registered = (media?.ids() ?? []).map((id) => {
      const s = media.get(id)
      return { id, label: s.label }
    })
    if (args.dump === 'json' || args.json) {
      process.stdout.write(JSON.stringify({
        profile: composed.profile,
        layers: composed.layerNames,
        host: { dir: hostDir, root: media?.root ?? null, configuredRoot: composed.host.root },
        entries,
        sources: registered,
      }, null, 2) + '\n')
    } else {
      process.stdout.write(renderText({
        profile: composed.profile,
        layers: composed.layerNames,
        host: { root: media?.root ?? composed.host.root },
        entries,
        sources: registered,
      }))
    }
  }

  if (args.check) {
    const bad = entries.filter((e) => !e.disabled && !e.active)
    const active = entries.filter((e) => e.active)
    process.stdout.write(`[check] 条目 ${entries.length} 个，active ${active.length}，disabled ${entries.length - active.length - bad.length}\n`)
    if (bad.length) {
      process.stdout.write(`[check] 未成功装载：${bad.map((e) => e.id).join(', ')}\n`)
      codes.push(1)
    } else {
      process.stdout.write('[check] OK\n')
    }
  }

  let aggregateResult = null
  if (args.aggregate || args.open) {
    if (!media) throw new ComposeError('该 profile 没有装载 ctx.media，无法聚合')
    aggregateResult = await media.aggregate()
    if (args.aggregate) {
      if (args.aggregate === 'json' || args.json) process.stdout.write(JSON.stringify(aggregateResult, null, 2) + '\n')
      else {
        process.stdout.write(`[aggregate] total=${aggregateResult.total}\n`)
        for (const s of aggregateResult.sources) {
          process.stdout.write(`[aggregate]   ${s.id.padEnd(14)} ${s.ok ? `ok count=${s.count}` : `error ${s.error}`}\n`)
        }
      }
    }
  }

  if (args.open) {
    const item = aggregateResult.items.find((it) => it.id === args.open)
    if (!item) {
      process.stdout.write(`[open] 找不到 id=${args.open} 的媒体\n`)
      codes.push(1)
    } else {
      const r = await media.open(item._end, item, { dryRun: args.dryRun })
      process.stdout.write(`[open] ${JSON.stringify(r)}\n`)
      if (!r.ok) codes.push(1)
    }
  }

  /* ---------- 收尾：一次性 CLI 必须自己退干净 ---------- */
  // 宿主里 `ctx.web` 持有监听 handle（还可能有子进程），只设 process.exitCode 的话
  // 事件循环永远不空 → `--dump-config` 会挂住不退出。这里按「逆向卸载所有根条目」
  // 触发各插件的 effect 清理（组的 remove 会连整棵子树一起释放，loader-semantics H4 已验证）。
  for (const id of Object.keys(ctx.loader.store)) {
    try {
      await ctx.loader.remove(id)
    } catch (error) {
      process.stderr.write(`[cleanup] 卸载条目 ${id} 失败：${error.message}\n`)
    }
  }

  return codes.length ? Math.max(...codes) : 0
}

main()
  .then((code) => {
    process.exitCode = code
    // 兜底：卸载完还不空说明有插件漏关了 handle，2 秒后强退，别把命令行卡死。
    // unref() 保证它在正常情况下不会拖住进程。
    setTimeout(() => process.exit(code), 2000).unref()
  })
  .catch((error) => {
    if (error instanceof ComposeError) {
      process.stderr.write(`合成配置失败：${error.message}\n`)
      process.exitCode = 2
      return
    }
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 1
  })

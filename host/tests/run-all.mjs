/**
 * 宿主测试总入口：按顺序跑完 host/tests 下的全部验收脚本，汇总结果。
 *
 * 为什么要有它：S5 之后测试有 4 个文件、各自会起真进程/真端口，靠手敲容易漏跑一个。
 * 顺序上先跑不依赖网络的纯逻辑（loader 语义），再跑会起进程的（对拍）——
 * 万一某个端口/进程没清干净，影响面最小。
 *
 * 运行：node host/tests/run-all.mjs [--only=名字片段]
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { HOST_DIR } from '../src/compose.mjs'

const NODE = process.execPath
const SUITE = [
  ['loader-semantics.mjs', 'loader 真实语义（S5-1）'],
  ['parity.mjs', '聚合/深链与 launcher 逐项对拍（S5-1）'],
  ['library-parity.mjs', '列表面与 python media_lib 对拍（S5-2）'],
  ['ws-rfc6455.mjs', '手写 RFC6455 帧级验收（S5-3）'],
  ['remote-parity.mjs', '信令中继跨语言 A/B 对拍（S5-3）'],
  ['bloodmusic-source.mjs', '血音来源收编验收（P1 生态收编）'],
]

const onlyArg = process.argv.find((a) => a.startsWith('--only='))
const only = onlyArg?.slice('--only='.length)
const suite = only ? SUITE.filter(([file]) => file.includes(only)) : SUITE

const summary = []
for (const [file, label] of suite) {
  process.stdout.write(`\n===== ${file} —— ${label}\n`)
  const started = Date.now()
  const result = spawnSync(NODE, [path.join(HOST_DIR, 'tests', file)], { stdio: 'inherit', windowsHide: true })
  summary.push({ file, label, code: result.status, ms: Date.now() - started })
}

process.stdout.write('\n===== 汇总\n')
for (const row of summary) {
  const mark = row.code === 0 ? 'PASS' : 'FAIL'
  process.stdout.write(`${mark}  ${row.file.padEnd(24)} ${String(row.ms).padStart(6)}ms  ${row.label}\n`)
}
const failed = summary.filter((r) => r.code !== 0)
process.stdout.write(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 个文件有失败项`}（${summary.length - failed.length}/${summary.length}）\n`)
process.exit(failed.length ? 1 : 0)

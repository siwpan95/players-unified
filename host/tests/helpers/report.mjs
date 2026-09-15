/**
 * 报告落盘闸门：**默认不写盘**，要刷新证据得显式开启。
 *
 * 为什么需要这个闸门
 * ----------------
 * `docs/*.json` 是被 git 跟踪的「发版级证据」，但报告里天然含有**逐次运行都会变**的坐标：
 *   · `generatedAt` 时间戳
 *   · 夹具用的随机端口（`127.0.0.1:9151` 之类）
 *   · `mkdtemp` 出来的临时目录名（`puh-parity-0tAOtm`）
 *   · 客户端随机 key 导出的 `Sec-WebSocket-Accept` 回显
 * 于是「跑一遍测试来验证」这个动作本身会把 4 个被跟踪的文件改脏 ——
 * 刚提交完的干净树，在验证之后又被自己的测试弄脏了，而且这些差异**没有信息量**。
 *
 * 所以：默认静默跳过写盘；要刷新证据时显式开启：
 *     PU_REPORT=1 node host/tests/run-all.mjs
 *     node host/tests/ws-rfc6455.mjs --report
 *
 * 诚实的边界
 * ----------
 * 即使开启，也**不要**期待字节级复现 —— 可复现的是**判定结果**（断言名 / ok / 计数 /
 * conclusion），不是夹具坐标。要确认一次重跑没有引入实质改动，看：
 *     git diff --stat docs/          # 只有坐标在动 = 无信息增益
 *
 * 这条与 `docs/s1-spike-report.json` / `docs/kernel-e2e-report.json` 的既有做法一致：
 * 那两个报告本就不含 `generatedAt`，也不该被每次跑测试改写。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 是否显式要求写盘：`PU_REPORT=1` 或命令行 `--report`。 */
export function reportEnabled(
  argv = process.argv.slice(2),
  env = process.env,
) {
  if (env.PU_REPORT === '1') return true
  return argv.includes('--report')
}

/**
 * 写报告（默认不写）。
 * @returns {boolean} 真的落盘了才返回 true
 */
export function writeReport(file, report, log = console.log) {
  if (!reportEnabled()) {
    log('报告： 未写盘（默认关闭，避免改动被跟踪的 docs/*.json；要刷新加 PU_REPORT=1）')
    return false
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8')
  log(`报告： ${file}`)
  return true
}

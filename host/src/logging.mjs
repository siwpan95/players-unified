/**
 * 把 cordis 的日志接到进程 stdout/stderr 上。
 *
 * 为什么必须有这个：cordis 的 `ctx.logger` 默认**没有 exporter**，日志全部被丢掉。
 * 而 loader 的失败路径几乎都是 `this.ctx.logger.error(error)`（插件 import 失败、
 * 插件 apply 抛异常都在这里），所以不接日志的后果是「条目静默不生效」——
 * 查起来极其费劲（本宿主开发时就在这里绕过一大圈）。error/warn 走 stderr，
 * 其余走 stdout，方便 `--dump-config` 的 stdout 保持可管道。
 */

import { Logger } from 'cordis'

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

/**
 * @param {{level?: 'error'|'warn'|'info'|'debug'|'silent', color?: boolean}} options
 *   level='silent' 时**不接 exporter** —— cordis 默认就没有 exporter，日志自然全丢。
 *   测试里常用它把「正常关闭」之类的 info 噪音挡掉，只留断言结果。
 */
export function attachConsoleLogger(ctx, { level = 'info', color = false } = {}) {
  if (level === 'silent') return null
  const exporter = {
    colors: color ? undefined : false,
    maxLength: 400,
    levels: { ...LEVELS, [level]: 3 },
    export(message) {
      const line = Logger.format(exporter, message)
      const stream = message.level <= LEVELS.warn ? process.stderr : process.stdout
      stream.write(line + '\n')
    },
  }
  return ctx.logger.exporter(exporter)
}

/**
 * 测试替身插件：把「被装载 / 被卸载」记录下来，供 loader 语义探针断言。
 *
 * 这是宿主测试专用的最小插件，形态与真实插件完全一致：
 *   - 具名导出 `name` / `inject`
 *   - default 导出 apply 函数
 * 这样探针验证的是 loader 的真实装载路径，而不是 mock 出来的假路径。
 */

export const name = 'echo'
export const inject = []

export function echoLog() {
  return (globalThis.__ECHO_LOG ??= [])
}

function push(event, id, config) {
  echoLog().push({ event, id, config, seq: echoLog().length })
}

export default function apply(ctx, config) {
  const id = ctx.loader?.locate?.(ctx.fiber) ?? '(no-entry)'
  push('apply', id, config)
  ctx.effect(() => () => push('dispose', id, config))
}

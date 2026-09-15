/**
 * 来源适配器：daily_player（Python + tkinter + libVLC）
 *
 * 它没有 HTTP 面，所以枚举**直接调用它自己的 Python 代码**
 * （`media_source.LocalFileSource.list()`，子进程跑一段内联脚本），
 * 打开则 spawn `play.py <path>`。这样聚合出来的就是每天的播放器真正的枚举产出，
 * 而不是宿主另写一份目录扫描。
 */

export const name = 'source-daily'

function apply(ctx, config = {}) {
  if (!config.dir) throw new Error('daily 来源缺少 dir')
  const transport = ctx.media.transport
  const id = config.id ?? 'daily'
  const descriptor = {
    id,
    label: config.label ?? 'daily_player · 本地目录',
    list: {
      kind: 'python',
      dir: config.dir,
      moduleDir: config.moduleDir ?? 'daily_player',
      python: config.python,
      recursive: config.recursive !== false,
      timeoutMs: config.timeoutMs,
    },
    open: { kind: 'spawn', ...(config.open ?? {}) },
  }

  ctx.effect(() =>
    ctx.media.define({
      id,
      label: descriptor.label,
      descriptor,
      list: descriptor.list,
      planOpen: (item) => transport.planOpen(descriptor, item),
    }),
  )
}

// 对象形态提供 name/inject（模块级导出传不到 registry，见 pluginplayer.mjs 的说明）
export default {
  name: 'source-daily',
  inject: ['media'],
  apply,
}

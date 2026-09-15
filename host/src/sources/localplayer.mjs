/**
 * 来源适配器：localplayer（Chrome MV3 扩展的远端后端）
 *
 * 枚举走 `server.py` 的 `GET /api/list`；打开方式是让浏览器直接访问该媒体 URL
 * （扩展自己在页面上接管播放），所以宿主侧只产出 browser 动作、不执行副作用。
 *
 * S5-2 会把 `server.py` 的这个列表面吸收成宿主自己的 Cordis 插件，
 * 那时这个来源的 `url` 会从 5000（python）换成宿主端口，扩展端零改动。
 */

export const name = 'source-localplayer'

function apply(ctx, config = {}) {
  if (!config.url) throw new Error('localplayer 来源缺少 url')
  const transport = ctx.media.transport
  const id = config.id ?? 'localplayer'
  const descriptor = {
    id,
    label: config.label ?? 'localplayer · 远端后端',
    list: {
      kind: 'http',
      url: config.url,
      token: config.token,
      tokenFile: config.tokenFile,
      timeoutMs: config.timeoutMs,
    },
    open: { kind: 'browser', ...(config.open ?? {}) },
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
  name: 'source-localplayer',
  inject: ['media'],
  apply,
}

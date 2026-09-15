/**
 * 来源适配器：PluginPlayer（C++ 播放器）
 *
 * 枚举走它自带的 HTTP 面 `GET /api/library`（带 X-PP-Token 头）；
 * 打开走控制通道 RPC `player.open`（TCP + 换行分隔 JSON-RPC，默认端口 7911）。
 *
 * 这是「来源插件」的样板：插件只负责把该端的真实枚举/打开路径**声明**给 `ctx.media`，
 * 聚合与分发都由服务统一做。注册包在 `ctx.effect` 里 → 插件一停用来源就自动摘掉。
 */

export const name = 'source-pluginplayer'

function apply(ctx, config = {}) {
  if (!config.url) throw new Error('pluginplayer 来源缺少 url')
  const transport = ctx.media.transport
  const id = config.id ?? 'pluginplayer'
  const descriptor = {
    id,
    label: config.label ?? 'PluginPlayer · 媒体库',
    list: {
      kind: 'http',
      url: config.url,
      token: config.token,
      tokenFile: config.tokenFile,
      timeoutMs: config.timeoutMs,
    },
    open: { kind: 'rpc', ...(config.open ?? {}) },
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

/**
 * ⚠️ `inject` / `name` 必须放在**对象形态**的插件上，不能作为模块级导出、
 *    也不能写成 `apply.inject = [...]` 之外的函数属性赋值（函数 `name` 是
 *    `writable: false`，赋值在严格模式下直接抛 TypeError）。
 *    loader 的 `unwrapExports()` 会把 `export default` 取成插件本体；模块级导出
 *    留在 namespace 上，registry 看不到 → fiber 的 inject 为空 → 插件访问
 *    `ctx.media` 时以 FAILED 收场（报 "cannot get property media without inject"）。
 *    实测踩过，详见 host/README.md「踩坑」一节。
 */
export default {
  name: 'source-pluginplayer',
  inject: ['media'],
  apply,
}

/**
 * 来源适配器：BloodMusic（程序化音频合成引擎，Cordis 宿主化的第一个跨仓来源）
 *
 * 枚举走 BloodMusic **自己仓库里的** `host-js/python/list_media.py`
 * （产出 MediaItem[] 契约，roots 覆盖 album_output / mirror_output /
 * album_maker_quick / %TEMP%/bloodmusic-rpc）；打开走宿主 web 面（browser）。
 *
 * 这是 P1「生态收编」实证：Phase A 已把 BloodMusic 的 Cordis 宿主
 * （G:/repos/audio-generation/host-js）落地；本来源让统一编排层能直接聚合
 * BloodMusic 的生成物。设计文档见 audio-generation/docs/PLAN_cordis_host.md
 * 与 docs/REVIEW_phase_b_20260918.md（P1）。
 */

export const name = 'source-bloodmusic'

function apply(ctx, config = {}) {
  if (!config.script) throw new Error('bloodmusic 来源缺少 script')
  const transport = ctx.media.transport
  const id = config.id ?? 'bloodmusic'
  const descriptor = {
    id,
    label: config.label ?? 'BloodMusic · 程序化生成物',
    list: {
      kind: 'python-script',
      python: config.python,
      script: config.script,
      args: config.args,
      timeoutMs: config.timeoutMs,
    },
    // 打开：宿主 web 面直接以 file:// 播放 WAV（浏览器原生支持 WAV 播放）
    open: { kind: 'browser', ...(config.open ?? {}) },
  }

  ctx.effect(() =>
    ctx.media.define({
      id,
      label: descriptor.label,
      descriptor,
      list: descriptor.list,
      planOpen: (item) => {
        const action = transport.planOpen(descriptor, item)
        // file:// 深链：Windows 绝对路径需转 URI（G:\x\y.wav → file:///G:/x/y.wav）
        if (action.action === 'browser' && /^([a-zA-Z]:[\\/]|\\\\)/.test(action.url || '')) {
          action.url = 'file:///' + action.url.replace(/\\/g, '/')
        }
        return action
      },
    }),
  )
}

// 对象形态提供 name/inject（模块级导出传不到 registry，见 pluginplayer.mjs 的说明）
export default {
  name: 'source-bloodmusic',
  inject: ['media'],
  apply,
}

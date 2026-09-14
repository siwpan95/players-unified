/**
 * PluginPlayer PlayerEngine 适配器（Phase 2：共享 UX 控制契约）
 *
 * 把 `ctx.player`（控制通道 JSON-RPC，见 src/player-service.mjs）适配成
 * ARCHITECTURE §3 定义的 PlayerEngine 端口：
 *     load(item) / play() / pause() / seek(ms) / setRate(rate) /
 *     setVolume(vol 0..100) / snapshot(path) / getState() -> PlayerState
 *
 * 单位/量纲换算（与 daily_player、localplayer 对齐的关键）：
 *   - ctx.player.seek(seconds) 收**秒**，PlayerEngine.seek(ms) 收**毫秒** → /1000
 *   - ctx.player.volume(v) 收 **0..1**，PlayerEngine.setVolume 收 **0..100** → /100
 *   - ctx.player.speed(v) 即倍速 → 对应 setRate
 *   - player.stats() 返回 { position, duration, speed, paused, ... }（单位秒）
 *
 * 能力说明：
 *   - snapshot(path)：经原生 snapshot 插件的命令 `snapshot [dir]` 实现
 *     （见 src/plugins/snapshot/plugin.cpp），故取 path 的目录部分传入。
 *   - volume / muted / fullscreen：控制通道**没有对应 getter**
 *     （player.stats 不含这三项），因此由本适配器本地跟踪（经自身 setter 更新）。
 */

export const RATE_MIN = 0.25
export const RATE_MAX = 3.0

export function clampRate(r) {
  const n = Number(r)
  if (!isFinite(n)) return 1
  return Math.min(RATE_MAX, Math.max(RATE_MIN, n))
}

export function clampVolume(v) {
  const n = Number(v)
  if (!isFinite(n)) return 0
  return Math.min(100, Math.max(0, Math.round(n)))
}

/** 取路径的目录部分（支持 / 与 \）。无分隔符时返回 ''。 */
export function dirname(p) {
  const s = String(p == null ? '' : p)
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(0, i) : ''
}

/**
 * @param {object} player  ctx.player（PlayerService 实例或同等形状的对象）
 */
export function createPlayerEngine(player) {
  let volume = 100
  let muted = false
  let fullscreen = false

  const engine = {
    capabilities: { snapshot: true },

    async load(item) {
      const uri = (item && typeof item === 'object') ? item.uri : String(item)
      await player.open(uri)
      return engine
    },
    async play() { await player.play(); return engine },
    async pause() { await player.pause(); return engine },

    /** 毫秒 → 秒（控制通道 seek 收秒） */
    async seek(ms) {
      const n = Number(ms)
      await player.seek((isFinite(n) ? Math.max(0, n) : 0) / 1000)
      return engine
    },
    async setRate(rate) { await player.speed(clampRate(rate)); return engine },

    /** 0..100 → 0..1（控制通道 volume 收 0..1） */
    async setVolume(v) {
      volume = clampVolume(v)
      await player.volume(volume / 100)
      return engine
    },
    async setMuted(m) { muted = !!m; await player.mute(muted); return engine },

    /** 经原生 snapshot 插件命令 `snapshot [dir]` 落盘 */
    async snapshot(p) {
      const dir = dirname(p)
      return await player.command('snapshot', dir ? [dir] : [])
    },

    async getState() {
      const st = await player.stats()
      return {
        playing: !st.paused,
        timeMs: Math.round((Number(st.position) || 0) * 1000),
        durationMs: (Number(st.duration) > 0) ? Math.round(Number(st.duration) * 1000) : null,
        rate: (Number(st.speed) > 0) ? Number(st.speed) : 1,
        volume,        // 控制通道无 getter → 本地跟踪值
        muted,
        fullscreen
      }
    }
  }
  return engine
}

export default createPlayerEngine

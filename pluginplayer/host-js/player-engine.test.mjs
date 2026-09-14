/**
 * PluginPlayer PlayerEngine 适配器测试（P1 / Phase 2）
 *
 * 用「假 ctx.player」（mock 控制通道）驱动真实适配器，校验量纲换算
 * （ms↔s、0..100↔0..1）与 PlayerState 契约。零三方依赖。
 *
 * 运行：node pluginplayer/host-js/player-engine.test.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSchema, validate } from '../../schema/validate.mjs'
import { createPlayerEngine, clampRate, clampVolume, dirname } from './player-engine.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA = loadSchema()
const STATE_SCHEMA = SCHEMA.definitions.PlayerState

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function has(calls, expected) {
  return calls.some((c) => JSON.stringify(c) === JSON.stringify(expected))
}

function assertStateSchema(st) {
  validate(st, STATE_SCHEMA, SCHEMA)
  assert(
    JSON.stringify(Object.keys(st).sort()) ===
      JSON.stringify(['durationMs', 'fullscreen', 'muted', 'playing', 'rate', 'timeMs', 'volume']),
    `PlayerState 字段集不符: ${Object.keys(st)}`
  )
}

/** 假控制通道：记录所有调用，stats() 返回可配置的快照 */
function mockPlayer(stats = {}) {
  const calls = []
  return {
    calls,
    async open(p) { calls.push(['open', p]) },
    async play() { calls.push(['play']) },
    async pause() { calls.push(['pause']) },
    async seek(sec) { calls.push(['seek', sec]) },
    async volume(v) { calls.push(['volume', v]) },
    async mute(v) { calls.push(['mute', v]) },
    async speed(v) { calls.push(['speed', v]) },
    async command(name, args) { calls.push(['command', name, JSON.stringify(args)]); return 0 },
    async stats() {
      return Object.assign({ position: 0, duration: 0, speed: 1, paused: 1 }, stats)
    }
  }
}

// ---- 纯函数 ----
assert(clampRate(5) === 3.0, 'rate 上限 3.0')
assert(clampRate(0.1) === 0.25, 'rate 下限 0.25')
assert(clampRate('bad') === 1, '非法 rate 回落 1')
assert(clampVolume(150) === 100, 'volume 上限 100')
assert(clampVolume(-3) === 0, 'volume 下限 0')
assert(dirname('C:\\media\\shot.png') === 'C:\\media', 'dirname 应处理反斜杠')
assert(dirname('/media/shot.png') === '/media', 'dirname 应处理正斜杠')
assert(dirname('shot.png') === '', '无分隔符时 dirname 为空')

// ---- 主流程：正常播放态 ----
const p1 = mockPlayer({ position: 12.34, duration: 60, speed: 1.5, paused: 0 })
const eng = createPlayerEngine(p1)

await eng.load({ id: 'x', uri: 'C:\\media\\movie.mp4', title: 'movie', kind: 'video', source: 'plugin:media-library' })
assert(has(p1.calls, ['open', 'C:\\media\\movie.mp4']), 'load 应 open(MediaItem.uri)')

await eng.play()
await eng.pause()
assert(has(p1.calls, ['play']), 'play 应调用 player.play')
assert(has(p1.calls, ['pause']), 'pause 应调用 player.pause')

// seek：毫秒 → 秒
await eng.seek(1500)
assert(has(p1.calls, ['seek', 1.5]), 'seek(1500ms) 应换算为 seek(1.5s)')
await eng.seek(-5)
assert(has(p1.calls, ['seek', 0]), '负偏移应夹到 0')

// setRate → speed（夹紧）
await eng.setRate(5)
assert(has(p1.calls, ['speed', 3.0]), 'setRate(5) 应夹到 speed(3.0)')
await eng.setRate(0.1)
assert(has(p1.calls, ['speed', 0.25]), 'setRate(0.1) 应夹到 speed(0.25)')

// setVolume：0..100 → 0..1
await eng.setVolume(150)
assert(has(p1.calls, ['volume', 1]), 'setVolume(150) 应夹到 volume(1)')
await eng.setVolume(42)
assert(has(p1.calls, ['volume', 0.42]), 'setVolume(42) → volume(0.42)')

// setMuted
await eng.setMuted(true)
assert(has(p1.calls, ['mute', true]), 'setMuted(true) → mute(true)')

// snapshot → 原生 snapshot 插件命令（传目录）
await eng.snapshot('C:\\media\\shot.png')
assert(has(p1.calls, ['command', 'snapshot', '["C:\\\\media"]']),
  'snapshot 应调用 command("snapshot", [dir])')

// getState
const st = await eng.getState()
assertStateSchema(st)
assert(st.playing === true, 'paused=0 → playing true')
assert(st.timeMs === 12340, `timeMs 应为 12340，实际 ${st.timeMs}`)
assert(st.durationMs === 60000, `durationMs 应为 60000，实际 ${st.durationMs}`)
assert(st.rate === 1.5, `rate 应取 stats.speed=1.5，实际 ${st.rate}`)
assert(st.volume === 42, `volume 应取本地跟踪值 42，实际 ${st.volume}`)
assert(st.muted === true, 'muted 应取本地跟踪值')
assert(st.fullscreen === false, 'fullscreen 默认 false')

// ---- 边界：暂停 / duration 为 0 → null ----
const p2 = mockPlayer({ position: 0, duration: 0, speed: 0, paused: 1 })
const st2 = await createPlayerEngine(p2).getState()
assertStateSchema(st2)
assert(st2.playing === false, 'paused=1 → playing false')
assert(st2.durationMs === null, 'duration=0 → durationMs null')
assert(st2.rate === 1, 'speed<=0 → rate 回落 1')
assert(st2.volume === 100, '未 setVolume 时默认 100')

console.log('[test] PluginPlayer PlayerEngine 全部断言通过 ✅  PlayerState 符合 schema')
process.exit(0)

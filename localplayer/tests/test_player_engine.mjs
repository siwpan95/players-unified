/**
 * localplayer PlayerEngine 适配器测试（P1 / Phase 2）
 *
 * player_engine.js 是经典脚本（扩展无打包器），这里用 `new Function` 在 Node 里
 * 执行它并取全局对象，再用「假 HTMLMediaElement」驱动真实适配器逻辑。
 * 零三方依赖。
 *
 * 运行：node localplayer/tests/test_player_engine.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSchema, validate } from '../../schema/validate.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_PATH = path.resolve(__dirname, '..', 'player_engine.js')

// ---- 加载经典脚本（它会把工厂挂到 globalThis.LpPlayerEngine）----
const src = fs.readFileSync(ENGINE_PATH, 'utf8')
const factory = new Function(src + '\nreturn globalThis.LpPlayerEngine;')
const LpPlayerEngine = factory()
if (!LpPlayerEngine) {
  console.error('[test] 未能从 player_engine.js 取到 LpPlayerEngine ❌')
  process.exit(1)
}

const SCHEMA = loadSchema()
const STATE_SCHEMA = SCHEMA.definitions.PlayerState

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function assertStateSchema(st) {
  validate(st, STATE_SCHEMA, SCHEMA)
  assert(
    JSON.stringify(Object.keys(st).sort()) ===
      JSON.stringify(['durationMs', 'fullscreen', 'muted', 'playing', 'rate', 'timeMs', 'volume']),
    `PlayerState 字段集不符: ${Object.keys(st)}`
  )
  assert(typeof st.playing === 'boolean', 'playing 应为 boolean')
  assert(typeof st.timeMs === 'number', 'timeMs 应为 number')
  assert(st.durationMs === null || typeof st.durationMs === 'number', 'durationMs 应为 number|null')
  assert(st.volume >= 0 && st.volume <= 100, 'volume 应在 0..100')
}

function fakeEl(init = {}) {
  return Object.assign({
    src: '',
    paused: true,
    currentTime: 12.34,
    duration: 60,
    playbackRate: 1,
    volume: 0.8,
    muted: false,
    loadCount: 0,
    play() { this.paused = false; return Promise.resolve() },
    pause() { this.paused = true },
    load() { this.loadCount++ }
  }, init)
}

// ---- 纯函数：夹紧 ----
assert(LpPlayerEngine.clampRate(5) === 3.0, 'rate 上限应夹到 3.0')
assert(LpPlayerEngine.clampRate(0.1) === 0.25, 'rate 下限应夹到 0.25')
assert(LpPlayerEngine.clampRate(2) === 2.0, 'rate 2 应保持')
assert(LpPlayerEngine.clampRate('bad') === 1, '非法 rate 应回落 1')
assert(LpPlayerEngine.clampVolume(150) === 100, 'volume 上限 100')
assert(LpPlayerEngine.clampVolume(-3) === 0, 'volume 下限 0')
assert(LpPlayerEngine.clampVolume(42.6) === 43, 'volume 应四舍五入')

// ---- load ----
const el = fakeEl()
const eng = LpPlayerEngine.create(el, { fullscreenGetter: () => true })
eng.load({ id: 'x', uri: 'http://127.0.0.1:5000/media/a.mp4', title: 'a', kind: 'video', source: 'remote' })
assert(el.src === 'http://127.0.0.1:5000/media/a.mp4', 'load 应把 MediaItem.uri 写入 el.src')
assert(el.loadCount === 1, 'load 应调用 el.load()')

// ---- play / pause ----
eng.play()
assert(el.paused === false, 'play 后应非暂停')
eng.pause()
assert(el.paused === true, 'pause 后应暂停')

// ---- seek：毫秒 → 秒 ----
eng.seek(1500)
assert(el.currentTime === 1.5, `seek(1500ms) 应写入 currentTime=1.5，实际 ${el.currentTime}`)
eng.seek(-5)
assert(el.currentTime === 0, '负偏移应夹到 0')

// ---- setRate / setVolume / setMuted ----
eng.setRate(5)
assert(el.playbackRate === 3.0, 'rate 应夹到 3.0')
eng.setRate(0.1)
assert(el.playbackRate === 0.25, 'rate 应夹到 0.25')
eng.setVolume(150)
assert(el.volume === 1, 'volume 150 → el.volume 1')
eng.setVolume(-3)
assert(el.volume === 0, 'volume -3 → el.volume 0')
eng.setVolume(42)
assert(Math.abs(el.volume - 0.42) < 1e-9, 'volume 42 → el.volume 0.42')
eng.setMuted(true)
assert(el.muted === true, 'setMuted(true) 应置 el.muted')

// ---- snapshot：浏览器不支持 ----
assert(eng.snapshot('/tmp/shot.png') === false, 'localplayer 的 snapshot 应返回 false（能力差异）')
assert(eng.capabilities.snapshot === false, 'capabilities.snapshot 应为 false')

// ---- getState（独立元素，避免上面 seek 改掉 currentTime）----
const el2 = fakeEl({ paused: false, currentTime: 12.34, duration: 60, volume: 0.8 })
const st = LpPlayerEngine.create(el2, { fullscreenGetter: () => true }).getState()
assertStateSchema(st)
assert(st.playing === true, 'playing 应为 true')
assert(st.timeMs === 12340, `timeMs 应为 12340，实际 ${st.timeMs}`)
assert(st.durationMs === 60000, `durationMs 应为 60000，实际 ${st.durationMs}`)
assert(st.rate === 1, 'rate 应为 1')
assert(st.volume === 80, `volume 应为 80，实际 ${st.volume}`)
assert(st.muted === false, 'muted 应为 false')
assert(st.fullscreen === true, 'fullscreenGetter 应生效')

// ---- 边界：duration 未知(NaN) → null；暂停态；默认 fullscreen ----
const el3 = fakeEl({ paused: true, currentTime: NaN, duration: NaN, volume: 0 })
const st3 = LpPlayerEngine.create(el3).getState()
assertStateSchema(st3)
assert(st3.playing === false, 'paused 时 playing 应为 false')
assert(st3.timeMs === 0, 'currentTime NaN → timeMs 0')
assert(st3.durationMs === null, 'duration NaN → durationMs null')
assert(st3.volume === 0, 'volume 0 → 0')
assert(st3.fullscreen === false, '未提供 getter 时 fullscreen 默认 false')

console.log('[test] localplayer PlayerEngine 全部断言通过 ✅  PlayerState 符合 schema')
process.exit(0)

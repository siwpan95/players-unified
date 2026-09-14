/* localplayer PlayerEngine 适配器（Phase 2：共享 UX 控制契约）
 *
 * 把 HTMLMediaElement（offscreen 文档里的 <audio>/<video>）适配成
 * ARCHITECTURE §3 定义的 PlayerEngine 端口：
 *     load(item) / play() / pause() / seek(ms) / setRate(rate) /
 *     setVolume(vol 0..100) / snapshot(path) / getState() -> PlayerState
 *
 * 形态说明
 * --------
 * 这是**经典脚本**（非 ESM），挂到 globalThis.LpPlayerEngine，
 * offscreen.js / popup.js 用普通 <script src> 引入即可（扩展没有打包器）。
 * 单测在 Node 里用 `new Function(src)` 执行本文件再取全局对象。
 *
 * 单位换算：<video>/<audio> 一律用**秒**，PlayerEngine 用**毫秒** → seek 要 /1000，
 * getState 的 timeMs/durationMs 要 *1000。
 *
 * 能力差异：浏览器无法按任意路径写盘，故 `snapshot()` 返回 false
 * （与 ARCHITECTURE §5 的 UX 表一致：localplayer 截图 ❌）。
 */
(function (global) {
    'use strict';

    var RATE_MIN = 0.25, RATE_MAX = 3.0;

    function clampRate(r) {
        var n = Number(r);
        if (!isFinite(n)) return 1;
        return Math.min(RATE_MAX, Math.max(RATE_MIN, n));
    }

    function clampVolume(v) {
        var n = Number(v);
        if (!isFinite(n)) return 0;
        return Math.min(100, Math.max(0, Math.round(n)));
    }

    /** 秒 → 毫秒；未知（NaN/<=0）→ 0（PlayerState.timeMs 是 number，不可为 null） */
    function secToMs(s) {
        var n = Number(s);
        return isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
    }

    /** 秒 → 毫秒；未知（NaN/<=0）→ null（durationMs 允许 null） */
    function durToMs(s) {
        var n = Number(s);
        return isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
    }

    function create(el, opts) {
        opts = opts || {};
        var getFullscreen = opts.fullscreenGetter || function () {
            try {
                return !!(global.document && global.document.fullscreenElement);
            } catch (e) {
                return false;
            }
        };

        var engine = {
            capabilities: { snapshot: false },

            load: function (item) {
                var uri = (item && typeof item === 'object') ? item.uri : String(item);
                el.src = uri;
                if (typeof el.load === 'function') el.load();
                return engine;
            },
            play: function () {
                var p = el.play();
                if (p && typeof p.catch === 'function') p.catch(function () {});
                return engine;
            },
            pause: function () { el.pause(); return engine; },

            /** ms → 秒（HTMLMediaElement.currentTime 单位是秒） */
            seek: function (ms) {
                var n = Number(ms);
                el.currentTime = (isFinite(n) ? Math.max(0, n) : 0) / 1000;
                return engine;
            },
            setRate: function (r) { el.playbackRate = clampRate(r); return engine; },
            setVolume: function (v) { el.volume = clampVolume(v) / 100; return engine; },
            setMuted: function (m) { el.muted = !!m; return engine; },

            /** 浏览器内不支持按路径落盘 → 恒返回 false（见文件头说明） */
            snapshot: function () { return false; },

            getState: function () {
                return {
                    playing: !el.paused,
                    timeMs: secToMs(el.currentTime),
                    durationMs: durToMs(el.duration),
                    rate: Number(el.playbackRate) || 1,
                    volume: clampVolume((Number(el.volume) || 0) * 100),
                    muted: !!el.muted,
                    fullscreen: !!getFullscreen()
                };
            }
        };
        return engine;
    }

    global.LpPlayerEngine = {
        create: create,
        clampRate: clampRate,
        clampVolume: clampVolume,
        RATE_MIN: RATE_MIN,
        RATE_MAX: RATE_MAX
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);

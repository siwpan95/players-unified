(function() {
    'use strict';

    // ---------- DOM 引用 ----------
    const player = document.getElementById('player');
    const mediaWrapper = document.getElementById('mediaWrapper');
    const playlistEl = document.getElementById('playlist');
    const fileCountEl = document.getElementById('fileCount');
    const currentMediaNameEl = document.getElementById('currentMediaName');
    const nowPlayingEl = document.getElementById('nowPlaying');
    const pipBtn = document.getElementById('pipBtn');
    const bgStatus = document.getElementById('bgStatus');
    const bgTitle = document.getElementById('bgTitle');
    const bgToggle = document.getElementById('bgToggle');
    const bgSeek = document.getElementById('bgSeek');
    const searchInput = document.getElementById('searchInput');
    const sortSelect = document.getElementById('sortSelect');
    const castBtn = document.getElementById('castBtn');
    const castStatus = document.getElementById('castStatus');
    let castOn = false;

    // ---------- 状态 ----------
    let currentIndex = -1;
    let isAudioMode = false;   // 当前是否为音频模式
    let files = [];            // 媒体清单（由混合加载填充）
    let currentMediaEl = null; // 当前媒体元素（视频或音频）
    let currentFile = null;    // 当前播放的媒体项
    let searchTerm = '';       // 搜索关键字
    let sortMode = 'default';  // 排序方式
    let usingOffscreenAudio = false; // 当前音频是否走 offscreen 后台播放
    let bgState = { playing: false, currentTime: 0, duration: 0 }; // 后台音频状态

    // ---------- 本地打包媒体（随扩展分发，由 media/manifest.json 动态列出） ----------
    // 扩展运行时无法枚举自身包内目录，故由 gen_media_manifest.py 扫描 media/ 生成清单，
    // popup 读取该清单得到实际存在的媒体文件（避免硬编码示例文件名）。
    async function loadBundledMedia() {
        try {
            const res = await fetch(chrome.runtime.getURL('media/manifest.json'), { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const list = await res.json();
            if (Array.isArray(list) && list.length) {
                return list.map(m => ({
                    name: m.name,
                    type: m.type,
                    path: chrome.runtime.getURL('media/' + m.file),
                    bundled: true,
                    tracks: Array.isArray(m.tracks) ? m.tracks : undefined
                }));
            }
        } catch (e) {
            console.warn('读取本地媒体清单失败，请先运行 gen_media_manifest.py:', e);
        }
        return [];
    }

    // ---------- 插件式媒体源（最小化，无外部框架） ----------
    // 接口见 plugins/plugin-api.js：每个「媒体源插件」形如
    //   { id, name, priority?, getMedia(): Promise<Array<{name,path,type}>> }
    // 核心按优先级取第一个返回非空列表的插件（fallback 链）。
    // 内置两个源：远端后端（高优先级）/ 本地打包（兜底）。
    LocalPlayer.plugins.register({
        id: 'backend',
        name: '远端后端',
        priority: 10,
        getMedia() {
            return new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ action: 'getMediaList' }, resp => {
                    if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
                    if (resp && resp.ok && Array.isArray(resp.files) && resp.files.length) {
                        resolve(resp.files.map(f => ({
                            name: f.name,
                            type: f.type,
                            path: f.path,
                            remote: true,
                            tracks: Array.isArray(f.tracks) ? f.tracks : undefined
                        })));
                    } else {
                        // 后端未启动/无媒体：静默回落本地源（LP_SILENT 前缀由 plugin-api 抑制日志）
                        reject(new Error('LP_SILENT: 远端后端未提供媒体（未启动或清单为空）'));
                    }
                });
            });
        }
    });

    LocalPlayer.plugins.register({
        id: 'local',
        name: '本地打包',
        priority: 0,
        async getMedia() {
            const list = await loadBundledMedia();
            if (list.length) return list;
            throw new Error('本地清单为空，请先运行 gen_media_manifest.py');
        }
    });

    // ---------- 混合加载：按插件优先级取第一个非空清单 ----------
    function loadMedia() {
        return LocalPlayer.plugins.collectMedia();
    }

    // ---------- 工具函数 ----------
    function getIconForType(type) {
        return type === 'audio' ? '🎧' : '🎬';
    }

    function formatBadge(type) {
        return type === 'audio' ? 'AUDIO' : 'VIDEO';
    }

    // ---------- 切换到音频模式 ----------
    function switchToAudioMode() {
        if (isAudioMode) return;
        isAudioMode = true;

        player.style.display = 'none';

        const oldAudio = document.getElementById('audioPlayer');
        if (oldAudio) oldAudio.remove();

        const audio = document.createElement('audio');
        audio.id = 'audioPlayer';
        audio.controls = true;
        audio.preload = 'metadata';
        mediaWrapper.style.aspectRatio = 'auto';
        mediaWrapper.style.padding = '12px 0';
        mediaWrapper.appendChild(audio);

        audio.addEventListener('ended', handleEnded);
        audio.addEventListener('timeupdate', onTimeUpdate);
        audio.addEventListener('play', () => setPlaybackState('playing'));
        audio.addEventListener('pause', () => setPlaybackState('paused'));

        updatePipVisibility();
        return audio;
    }

    // ---------- 切换回视频模式 ----------
    function switchToVideoMode() {
        if (!isAudioMode) return;
        isAudioMode = false;

        const audio = document.getElementById('audioPlayer');
        if (audio) {
            audio.pause();
            audio.removeEventListener('ended', handleEnded);
            audio.remove();
        }

        player.style.display = 'block';
        mediaWrapper.style.aspectRatio = '16 / 9';
        mediaWrapper.style.padding = '0';
        updatePipVisibility();
    }

    // ---------- 播放结束处理 ----------
    function handleEnded() {
        if (currentIndex >= 0 && currentIndex + 1 < files.length) {
            playByIndex(currentIndex + 1);
        }
    }

    // ---------- HLS（.m3u8）播放支持 ----------
    // MV3 禁止运行时加载远程脚本，故 hls.min.js 以本地资源打包（见 popup.html）。
    let hlsInstance = null;

    function destroyHls() {
        if (hlsInstance) {
            try { hlsInstance.destroy(); } catch (e) { /* ignore */ }
            hlsInstance = null;
        }
    }

    function isHlsSource(path) {
        return /\.m3u8(\?[^#]*)?$/i.test(path);
    }

    // 给媒体元素挂载源：HLS 走 hls.js，普通格式直连；autoplay 控制是否立即播放
    function attachSource(el, file, autoplay) {
        destroyHls();
        // 字幕（仅视频）：清空旧轨，按媒体项 tracks 追加 <track>
        if (el.tagName === 'VIDEO' && Array.isArray(file.tracks) && file.tracks.length) {
            while (el.firstChild) el.removeChild(el.firstChild);
            file.tracks.forEach(t => {
                const tr = document.createElement('track');
                tr.kind = 'subtitles';
                tr.src = t.src;
                tr.srclang = t.srclang || 'zh';
                tr.label = t.label || t.srclang || '字幕';
                if (t.default) tr.default = true;
                el.appendChild(tr);
            });
        }
        const doPlay = () => {
            if (autoplay) {
                el.play().catch(err => console.warn('播放失败（可能需用户交互）:', err));
            }
        };

        if (isHlsSource(file.path) && window.Hls && Hls.isSupported()) {
            hlsInstance = new Hls();
            hlsInstance.loadSource(file.path);
            hlsInstance.attachMedia(el);
            hlsInstance.on(Hls.Events.MANIFEST_PARSED, doPlay);
            hlsInstance.on(Hls.Events.ERROR, (evt, data) => {
                if (data && data.fatal) console.warn('HLS 致命错误:', data.type, data.details);
            });
        } else if (isHlsSource(file.path) && el.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari / iOS 原生支持 HLS
            el.src = file.path;
            el.load();
            doPlay();
        } else {
            el.src = file.path;
            el.load();
            doPlay();
        }
    }

    // ---------- 核心播放函数 ----------
    function playByIndex(index) {
        if (index < 0 || index >= files.length) return;
        currentIndex = index;
        const file = files[index];

        currentMediaNameEl.textContent = file.name;

        document.querySelectorAll('.playlist-item').forEach((el) => {
            el.classList.toggle('active', Number(el.dataset.index) === index);
        });

        // 音频：优先走 offscreen 后台续播；不可用时回退 popup 内播放
        if (file.type === 'audio') {
            currentFile = file;
            playAudioViaOffscreen(file).then((off) => {
                if (off) return; // 后台播放，UI 由状态面板驱动
                stopOffscreenAudio();
                usingOffscreenAudio = false;
                hideBackgroundAudioStatus();
                const audio = switchToAudioMode();
                attachSource(audio, file, true);
                player.pause();
                currentMediaEl = audio;
                updateMediaSession(file);
            });
            return;
        }

        // 视频
        stopOffscreenAudio();
        usingOffscreenAudio = false;
        hideBackgroundAudioStatus();
        switchToVideoMode();
        const el = player;
        attachSource(el, file, true);
        currentMediaEl = el;
        currentFile = file;
        updateMediaSession(file);
        // 元数据就绪后恢复上次播放进度
        el.addEventListener('loadedmetadata', () => restoreProgress(el, file), { once: true });
    }

    // ---------- 渲染播放列表 ----------
    function renderPlaylist() {
        playlistEl.innerHTML = '';
        const items = getDisplayFiles();

        if (files.length === 0) {
            playlistEl.innerHTML = '<div class="empty-msg">📭 暂无媒体文件<br><span style="font-size:0.8rem;">请运行 gen_media_manifest.py 生成清单，或启动 Flask 后端</span></div>';
            fileCountEl.textContent = '0 个文件';
            return;
        }

        fileCountEl.textContent = items.length + ' / ' + files.length + ' 个文件';

        if (items.length === 0) {
            playlistEl.innerHTML = '<div class="empty-msg">🔍 无匹配结果</div>';
            return;
        }

        items.forEach(({ file, index }) => {
            const item = document.createElement('div');
            item.className = 'playlist-item';
            item.dataset.index = index;
            if (index === currentIndex) item.classList.add('active');

            const icon = document.createElement('span');
            icon.className = 'icon';
            icon.textContent = getIconForType(file.type);

            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = file.name;

            const badge = document.createElement('span');
            badge.className = 'type-badge';
            badge.textContent = formatBadge(file.type);

            item.appendChild(icon);
            item.appendChild(name);
            item.appendChild(badge);

            item.addEventListener('click', () => {
                playByIndex(index);
            });

            playlistEl.appendChild(item);
        });
    }

    // ---------- 视频元素自带 ended 事件（用于视频模式自动下一曲） ----------
    player.addEventListener('ended', handleEnded);
    player.addEventListener('timeupdate', onTimeUpdate);
    player.addEventListener('play', () => setPlaybackState('playing'));
    player.addEventListener('pause', () => setPlaybackState('paused'));

    // ---------- 进度记忆（chrome.storage.local） ----------
    const progressCache = {};   // path -> 秒
    let progressSaveTimer = null;

    function loadProgress() {
        return new Promise(resolve => {
            chrome.storage.local.get('lp_progress', r => {
                if (r && r.lp_progress && typeof r.lp_progress === 'object') {
                    Object.assign(progressCache, r.lp_progress);
                }
                resolve();
            });
        });
    }

    function saveProgress(path, time) {
        if (!path || !isFinite(time) || time <= 0) return;
        progressCache[path] = time;
        if (progressSaveTimer) clearTimeout(progressSaveTimer);
        progressSaveTimer = setTimeout(() => {
            chrome.storage.local.set({ lp_progress: progressCache });
        }, 1000);
    }

    function onTimeUpdate(e) {
        if (currentFile) saveProgress(currentFile.path, e.target.currentTime);
    }

    function restoreProgress(el, file) {
        if (!file) return;
        const t = progressCache[file.path];
        if (typeof t === 'number' && t > 0 && isFinite(el.duration) && t < el.duration - 1) {
            try { el.currentTime = t; } catch (e) { /* ignore */ }
        }
    }

    // ---------- Media Session（锁屏元数据 + 硬件媒体键） ----------
    function setPlaybackState(s) {
        if ('mediaSession' in navigator) {
            try { navigator.mediaSession.playbackState = s; } catch (e) { /* ignore */ }
        }
    }

    function updateMediaSession(file) {
        if (!('mediaSession' in navigator)) return;
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: file.name,
                artist: file.remote ? '远端源' : (file.bundled ? '本地打包' : '轻量播放器'),
                album: '轻量播放器'
            });
        } catch (e) { /* ignore */ }
    }

    function setupMediaSession() {
        if (!('mediaSession' in navigator)) return;
        const ms = navigator.mediaSession;
        const safe = (fn) => (d) => { try { fn(d); } catch (e) { /* ignore */ } };
        ms.setActionHandler('play', safe(() => { if (currentMediaEl) currentMediaEl.play().catch(() => {}); }));
        ms.setActionHandler('pause', safe(() => { if (currentMediaEl) currentMediaEl.pause(); }));
        ms.setActionHandler('nexttrack', safe(() => playByIndex(currentIndex + 1)));
        ms.setActionHandler('previoustrack', safe(() => playByIndex(currentIndex - 1)));
        ms.setActionHandler('seekto', safe((d) => { if (currentMediaEl && d.seekTime != null) currentMediaEl.currentTime = d.seekTime; }));
        ms.setActionHandler('seekbackward', safe((d) => { if (currentMediaEl) currentMediaEl.currentTime = Math.max(0, currentMediaEl.currentTime - (d.seekOffset || 10)); }));
        ms.setActionHandler('seekforward', safe((d) => { if (currentMediaEl) currentMediaEl.currentTime = Math.min((currentMediaEl.duration || 1e9), currentMediaEl.currentTime + (d.seekOffset || 10)); }));
    }

    // ---------- 键盘快捷键 ----------
    function setupKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (!currentFile) return;
            const tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;

            // 后台音频：控制走 offscreen
            if (currentFile.type === 'audio' && usingOffscreenAudio) {
                switch (e.key) {
                    case ' ':
                    case 'k': e.preventDefault(); toggleBackgroundAudio(); break;
                    case 'ArrowRight': e.preventDefault(); seekBackgroundAudio(5); break;
                    case 'ArrowLeft': e.preventDefault(); seekBackgroundAudio(-5); break;
                    case 'n': playByIndex(currentIndex + 1); break;
                    case 'p': playByIndex(currentIndex - 1); break;
                }
                return;
            }

            if (!currentMediaEl) return;
            switch (e.key) {
                case ' ':
                case 'k':
                    e.preventDefault();
                    if (currentMediaEl.paused) currentMediaEl.play().catch(() => {});
                    else currentMediaEl.pause();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    currentMediaEl.currentTime = Math.min((currentMediaEl.duration || 1e9), currentMediaEl.currentTime + 5);
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    currentMediaEl.currentTime = Math.max(0, currentMediaEl.currentTime - 5);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    currentMediaEl.volume = Math.min(1, currentMediaEl.volume + 0.1);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    currentMediaEl.volume = Math.max(0, currentMediaEl.volume - 0.1);
                    break;
                case 'n':
                    playByIndex(currentIndex + 1);
                    break;
                case 'p':
                    playByIndex(currentIndex - 1);
                    break;
            }
        });
    }

    // ---------- 画中画（仅视频） ----------
    function updatePipVisibility() {
        if (pipBtn) pipBtn.hidden = isAudioMode;
    }

    if (pipBtn) {
        pipBtn.addEventListener('click', async () => {
            try {
                if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture();
                } else if (!isAudioMode && document.pictureInPictureEnabled && player) {
                    await player.requestPictureInPicture();
                }
            } catch (e) {
                console.warn('画中画操作失败:', e);
            }
            pipBtn.blur(); // 避免空格键误触发按钮
        });
    }

    // ---------- 播放列表过滤 / 排序 ----------
    function getDisplayFiles() {
        let arr = files.map((file, index) => ({ file, index }));
        const q = searchTerm.trim().toLowerCase();
        if (q) arr = arr.filter(o => o.file.name.toLowerCase().includes(q));
        if (sortMode === 'name') arr.sort((a, b) => a.file.name.localeCompare(b.file.name, 'zh'));
        else if (sortMode === 'type') arr.sort((a, b) => (a.file.type || '').localeCompare(b.file.type || ''));
        return arr;
    }

    // ---------- 后台音频（offscreen） ----------
    function hideLocalAudio() {
        const a = document.getElementById('audioPlayer');
        if (a) a.style.display = 'none';
    }

    function showBackgroundAudioStatus(file) {
        if (bgStatus) { bgStatus.hidden = false; bgTitle.textContent = file.name; }
    }
    function hideBackgroundAudioStatus() {
        if (bgStatus) bgStatus.hidden = true;
    }

    function updateBackgroundAudioStatus(state) {
        bgState = state || bgState;
        if (state && state.url && typeof state.currentTime === 'number') {
            progressCache[state.url] = state.currentTime; // 保持 popup 进度缓存与后台一致
        }
        if (!bgStatus) return;
        bgToggle.textContent = bgState.playing ? '⏸' : '▶';
        const pct = bgState.duration ? (bgState.currentTime / bgState.duration) * 100 : 0;
        bgSeek.value = String(Math.min(100, Math.max(0, pct)));
    }

    function toggleBackgroundAudio() {
        chrome.runtime.sendMessage({ action: bgState.playing ? 'audioPause' : 'audioPlay' });
    }
    function seekBackgroundAudio(delta) {
        const t = Math.min(bgState.duration || 0, Math.max(0, (bgState.currentTime || 0) + delta));
        chrome.runtime.sendMessage({ action: 'audioSeek', time: t });
    }

    function stopOffscreenAudio() {
        if (usingOffscreenAudio) {
            chrome.runtime.sendMessage({ action: 'audioPause' });
            usingOffscreenAudio = false;
        }
    }

    async function playAudioViaOffscreen(file) {
        let ok = false;
        try { ok = await chrome.runtime.sendMessage({ action: 'ensureOffscreen' }); } catch (e) { ok = false; }
        if (!ok) return false;
        switchToAudioMode();
        hideLocalAudio();
        usingOffscreenAudio = true;
        showBackgroundAudioStatus(file);
        chrome.runtime.sendMessage({
            action: 'audioLoad',
            url: file.path,
            startTime: progressCache[file.path] || 0,
            meta: {
                title: file.name,
                artist: file.remote ? '远端源' : (file.bundled ? '本地打包' : '轻量播放器'),
                album: '轻量播放器'
            }
        });
        return true;
    }

    function setupBgControls() {
        if (bgToggle) bgToggle.addEventListener('click', toggleBackgroundAudio);
        if (bgSeek) bgSeek.addEventListener('input', () => {
            if (bgState.duration) {
                const t = (Number(bgSeek.value) / 100) * bgState.duration;
                chrome.runtime.sendMessage({ action: 'audioSeek', time: t });
            }
        });
    }

    function serverReachable() {
        return new Promise((resolve) => {
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 1500);
                fetch('http://127.0.0.1:5000/api/list', { signal: ctrl.signal, cache: 'no-store' })
                    .then((r) => { clearTimeout(t); resolve(r.ok); })
                    .catch(() => { clearTimeout(t); resolve(false); });
            } catch (e) { resolve(false); }
        });
    }

    function updateCastAvailability() {
        serverReachable().then((ok) => {
            if (castOn) return; // 投送进行中保持可用（用于停止）
            if (ok) {
                castBtn.disabled = false;
                castBtn.title = '网页投送：把当前播放经 WebRTC 投到外部网页';
            } else {
                castBtn.disabled = true;
                castBtn.title = '网页投送需要后端 server.py：在项目目录执行 python server.py';
            }
        });
    }

    function updateCastStatusUI(s) {
        if (!castStatus) return;
        if (!s || !s.active) { castStatus.textContent = ''; return; }
        const n = s.viewers || 0;
        castStatus.textContent = n > 0
            ? ('📡 投送中 · ' + n + ' 个接收端')
            : '📡 投送中（等待接收端连接）';
    }

    function setupCast() {
        if (!castBtn) return;
        castBtn.addEventListener('click', async () => {
            // 开启前再次校验后端 server.py 是否在 127.0.0.1:5000 运行
            if (!castOn) {
                const ok = await serverReachable();
                if (!ok) {
                    alert('网页投送需要后端 server.py 运行在 http://127.0.0.1:5000。\n请先在项目目录执行：python server.py');
                    castBtn.disabled = true;
                    castBtn.title = '网页投送需要后端 server.py：在项目目录执行 python server.py';
                    return;
                }
            }
            castOn = !castOn;
            if (!castOn) updateCastAvailability();
            if (castOn) {
                if (currentFile) {
                    chrome.runtime.sendMessage({
                        action: 'castStart',
                        url: currentFile.path,
                        kind: currentFile.type,
                        startTime: currentMediaEl ? currentMediaEl.currentTime : 0,
                        meta: {
                            title: currentFile.name,
                            artist: currentFile.remote ? '远端源' : (currentFile.bundled ? '本地打包' : '轻量播放器'),
                            album: '轻量播放器'
                        }
                    });
                }
                if (currentMediaEl) currentMediaEl.muted = true;
                castBtn.textContent = '🔴 停止投送';
            } else {
                chrome.runtime.sendMessage({ action: 'castStop' });
                if (currentMediaEl) currentMediaEl.muted = false;
                castBtn.textContent = '🔊 网页投送';
                if (castStatus) castStatus.textContent = '';
            }
        });
        // 后端不可达时置灰投送按钮 + hover 提示；每 5s 复查
        updateCastAvailability();
        setInterval(updateCastAvailability, 5000);
    }

    function getOffscreenState() {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({ action: 'getOffscreenState' }, (st) => resolve(st || null));
            } catch (e) { resolve(null); }
        });
    }

    // 接收 offscreen 回报的状态 / 控制请求
    chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || !msg.action) return;
        if (msg.action === 'offscreenState') {
            updateBackgroundAudioStatus(msg);
        } else if (msg.action === 'offscreenEnded') {
            if (usingOffscreenAudio) playByIndex(currentIndex + 1);
        } else if (msg.action === 'offscreenNext') {
            playByIndex(currentIndex + 1);
        } else if (msg.action === 'offscreenPrev') {
            playByIndex(currentIndex - 1);
        } else if (msg.action === 'castStatus') {
            updateCastStatusUI(msg);
            // 信令意外断开（如后端关闭）导致投送退出：同步复位本地开关与按钮，避免滞后
            if (msg && !msg.active && castOn) {
                castOn = false;
                castStatus.textContent = '';
                castBtn.textContent = '🔊 网页投送';
                if (currentMediaEl) currentMediaEl.muted = false;
                updateCastAvailability();
            }
        }
    });

    // ---------- 初始化 ----------
    async function init() {
        await loadProgress();
        setupMediaSession();
        setupKeyboard();
        setupBgControls();
        setupCast();
        files = await loadMedia();
        currentIndex = 0;
        renderPlaylist();
        updatePipVisibility();

        if (searchInput) searchInput.addEventListener('input', () => { searchTerm = searchInput.value; renderPlaylist(); });
        if (sortSelect) sortSelect.addEventListener('change', () => { sortMode = sortSelect.value; renderPlaylist(); });

        // 若上一会话仍在后台播放音频，则接管其状态（不重复加载本地媒体）
        let resumedOffscreen = false;
        try {
            const st = await getOffscreenState();
            if (st && st.playing && st.url) {
                const idx = files.findIndex(f => f.path === st.url);
                if (idx >= 0) {
                    currentIndex = idx;
                    currentFile = files[idx];
                    usingOffscreenAudio = true;
                    bgState = st;
                    showBackgroundAudioStatus(files[idx]);
                    bgTitle.textContent = st.title || files[idx].name;
                    renderPlaylist();
                    updatePipVisibility();
                    resumedOffscreen = true;
                }
            }
        } catch (e) { /* ignore */ }

        if (resumedOffscreen) return;

        if (files.length > 0) {
            currentMediaNameEl.textContent = files[0].name;
            const firstFile = files[0];
            currentFile = firstFile;
            if (firstFile.type === 'video') {
                switchToVideoMode();
                attachSource(player, firstFile, false);
                currentMediaEl = player;
            } else {
                const audio = switchToAudioMode();
                attachSource(audio, firstFile, false);
                currentMediaEl = audio;
            }
            updateMediaSession(firstFile);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

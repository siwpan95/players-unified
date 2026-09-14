'use strict';

// offscreen 文档：在 MV3 中承载常驻播放（音频 + 视频），作为唯一主运行时；
// 并可将当前播放经 WebRTC 投送到外部网页（server.py 的 /remote）。
// 播放进度经 chrome.storage.local 落盘（与 popup 共用 lp_progress）。

const audio = document.getElementById('bg');
const videoEl = document.getElementById('bgVideo');

let currentPath = '';     // 当前媒体的 path（进度落盘键）
let currentTitle = '';    // 当前媒体标题（回报 UI）
let pendingStart = 0;     // 待恢复的起始进度（秒）
let mediaKind = 'audio';  // 当前主运行时类型：audio | video

// ---------- 进度落盘 ----------
let progressCache = {};
let progressSaveTimer = null;

function loadProgress() {
    return new Promise((resolve) => {
        chrome.storage.local.get('lp_progress', (r) => {
            if (r && r.lp_progress && typeof r.lp_progress === 'object') {
                Object.assign(progressCache, r.lp_progress);
            }
            resolve();
        });
    });
}

function activeEl() { return mediaKind === 'video' ? videoEl : audio; }

function saveProgress(time) {
    if (!currentPath || !isFinite(time) || time <= 0) return;
    progressCache[currentPath] = time;
    if (progressSaveTimer) clearTimeout(progressSaveTimer);
    progressSaveTimer = setTimeout(() => {
        chrome.storage.local.set({ lp_progress: progressCache });
    }, 1000);
}

function flushProgress() {
    if (progressSaveTimer) { clearTimeout(progressSaveTimer); progressSaveTimer = null; }
    const el = activeEl();
    if (currentPath && el && isFinite(el.currentTime) && el.currentTime > 0) {
        progressCache[currentPath] = el.currentTime;
        chrome.storage.local.set({ lp_progress: progressCache });
    }
}

function setPlaybackState(s) {
    if ('mediaSession' in navigator) {
        try { navigator.mediaSession.playbackState = s; } catch (e) { /* ignore */ }
    }
}

function postState() {
    const el = activeEl();
    chrome.runtime.sendMessage({
        action: 'offscreenState',
        playing: !el.paused,
        currentTime: el.currentTime,
        duration: isFinite(el.duration) ? el.duration : 0,
        url: currentPath,
        title: currentTitle,
        kind: mediaKind
    }).catch(() => {});
}

function wireMedia(el) {
    el.addEventListener('timeupdate', () => { saveProgress(el.currentTime); postState(); });
    el.addEventListener('play', () => { setPlaybackState('playing'); postState(); });
    el.addEventListener('pause', () => { setPlaybackState('paused'); flushProgress(); postState(); });
    el.addEventListener('ended', () => {
        flushProgress();
        chrome.runtime.sendMessage({ action: 'offscreenEnded' }).catch(() => {});
    });
    el.addEventListener('loadedmetadata', () => {
        if (pendingStart > 0 && isFinite(el.duration) && pendingStart < el.duration - 1) {
            try { el.currentTime = pendingStart; } catch (e) { /* ignore */ }
        }
        pendingStart = 0;
    });
}

wireMedia(audio);
wireMedia(videoEl);

function setMeta(meta) {
    if (!('mediaSession' in navigator) || !meta) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: meta.title || '媒体',
            artist: meta.artist || '',
            album: meta.album || '轻量播放器'
        });
        navigator.mediaSession.playbackState = 'playing';
    } catch (e) { /* ignore */ }
}

if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const safe = (fn) => (d) => { try { fn(d); } catch (e) { /* ignore */ } };
    ms.setActionHandler('play', safe(() => activeEl().play().catch(() => {})));
    ms.setActionHandler('pause', safe(() => activeEl().pause()));
    ms.setActionHandler('nexttrack', safe(() => chrome.runtime.sendMessage({ action: 'offscreenNext' }).catch(() => {})));
    ms.setActionHandler('previoustrack', safe(() => chrome.runtime.sendMessage({ action: 'offscreenPrev' }).catch(() => {})));
    ms.setActionHandler('seekto', safe((d) => { if (d.seekTime != null) activeEl().currentTime = d.seekTime; }));
    ms.setActionHandler('seekbackward', safe((d) => { const el = activeEl(); el.currentTime = Math.max(0, el.currentTime - (d.seekOffset || 10)); }));
    ms.setActionHandler('seekforward', safe((d) => { const el = activeEl(); el.currentTime = Math.min((el.duration || 1e9), el.currentTime + (d.seekOffset || 10)); }));
}

// ---------- WebRTC 投送 ----------
let pc = null, ws = null, castActive = false;
let useRelay = false, pendingSignaling = [];
const SIGNAL_URL = 'ws://127.0.0.1:5000/ws';
let castMeta = null;     // 当前投送的曲目元数据（回传给接收端显示）
let viewerCount = 0;     // 已连接的接收端数量（由 server 经 viewer-count 上报）

function sendCastMeta() {
    if (castMeta) signalingSend({ type: 'meta', title: castMeta.title, artist: castMeta.artist, album: castMeta.album });
}

function notifyCastStatus() {
    chrome.runtime.sendMessage({
        action: 'castStatus',
        active: castActive,
        viewers: viewerCount,
        meta: castMeta
    }).catch(() => {});
}

function getCastStream() {
    const tracks = [];
    if (videoEl.src && !videoEl.paused) {
        try { videoEl.captureStream(30).getTracks().forEach(t => tracks.push(t)); } catch (e) { /* ignore */ }
    }
    if (audio.src && !audio.paused) {
        try { audio.captureStream().getAudioTracks().forEach(t => tracks.push(t)); } catch (e) { /* ignore */ }
    }
    return new MediaStream(tracks);
}

function signalingSend(msg) {
    if (useRelay) {
        chrome.runtime.sendMessage({ target: 'castRelay', msg: msg }).catch(() => {});
    } else if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
    } else {
        pendingSignaling.push(msg);
    }
}

function flushPending() {
    pendingSignaling.splice(0).forEach(signalingSend);
}

function handleSignalingMessage(m) {
    if (!m) return;
    if (m.type === 'offer-request') {
        createAndSendOffer();
    } else if (m.type === 'answer') {
        if (pc) pc.setRemoteDescription(new RTCSessionDescription(m.sdp)).catch(() => {});
    } else if (m.type === 'candidate') {
        if (pc) pc.addIceCandidate(m.candidate).catch(() => {});
    } else if (m.type === 'viewer-count') {
        viewerCount = (typeof m.count === 'number') ? m.count : 0;
        notifyCastStatus();
    }
}

async function createAndSendOffer() {
    try {
        pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        const stream = getCastStream();
        stream.getTracks().forEach(t => pc.addTrack(t, stream));
        pc.onicecandidate = (e) => { if (e.candidate) signalingSend({ type: 'candidate', candidate: e.candidate }); };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signalingSend({ type: 'offer', sdp: pc.localDescription });
    } catch (e) {
        console.warn('[offscreen] 创建 offer 失败:', e);
    }
}

function startRelay() {
    useRelay = true;
    signalingSend({ type: 'role', role: 'sender' });
    sendCastMeta();
    flushPending();
}

function connectSignaling() {
    useRelay = false;
    try { ws = new WebSocket(SIGNAL_URL); }
    catch (e) { console.warn('[offscreen] 直连信令失败，回落 background 中转:', e); startRelay(); return; }
    let settled = false;
    const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch (_) {}
        startRelay();
    }, 2500);
    ws.onopen = () => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        signalingSend({ type: 'role', role: 'sender' });
        sendCastMeta();
        flushPending();
    };
    ws.onerror = () => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        startRelay();
    };
    ws.onmessage = async (e) => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        handleSignalingMessage(m);
    };
    ws.onclose = () => {
        // 信令断开（如后端 server.py 被关闭）：仅当仍在使用直连且投送进行中时视为意外断开
        if (castActive && !useRelay) onSignalingLost();
    };
}

function startCast() {
    if (castActive) return;
    castActive = true;
    notifyCastStatus();
    connectSignaling();
}

function stopCast() {
    castActive = false;
    useRelay = false;
    viewerCount = 0;
    pendingSignaling = [];
    notifyCastStatus();
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
}

// 信令链路意外断开（如后端服务停止）：清理并让 popup 退出「投送中」状态，避免滞后显示
function onSignalingLost() {
    if (!castActive) return;
    stopCast();
}

chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.target === 'castRelayIn') {
        handleSignalingMessage(msg.msg);
    }
});

chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'offscreen') return;
    switch (msg.cmd) {
        case 'load':
            mediaKind = 'audio';
            currentPath = msg.url || '';
            currentTitle = msg.meta ? (msg.meta.title || '') : '';
            pendingStart = (typeof msg.startTime === 'number' && msg.startTime > 0) ? msg.startTime : 0;
            audio.src = msg.url;
            audio.load();
            setMeta(msg.meta);
            audio.play().catch((e) => console.warn('后台播放失败:', e));
            break;
        case 'play':
            activeEl().play().catch(() => {});
            break;
        case 'pause':
            activeEl().pause();
            break;
        case 'seek':
            if (typeof msg.time === 'number') activeEl().currentTime = msg.time;
            break;
        case 'stop':
            flushProgress();
            audio.pause(); audio.removeAttribute('src'); audio.load();
            videoEl.pause(); videoEl.removeAttribute('src'); videoEl.hidden = true;
            currentPath = '';
            break;
        case 'castStart':
            mediaKind = msg.kind === 'video' ? 'video' : 'audio';
            currentPath = msg.url || '';
            currentTitle = msg.meta ? (msg.meta.title || '') : '';
            pendingStart = (typeof msg.startTime === 'number' && msg.startTime > 0) ? msg.startTime : 0;
            castMeta = msg.meta || null;
            setMeta(msg.meta);
            if (mediaKind === 'video') {
                videoEl.hidden = false;
                videoEl.src = msg.url;
                videoEl.load();
                videoEl.play().then(startCast).catch((e) => { console.warn('投送视频播放失败:', e); startCast(); });
            } else {
                audio.src = msg.url;
                audio.load();
                audio.play().then(startCast).catch((e) => { console.warn('投送音频播放失败:', e); startCast(); });
            }
            break;
        case 'castStop':
            stopCast();
            audio.pause(); audio.removeAttribute('src'); audio.load();
            videoEl.pause(); videoEl.removeAttribute('src'); videoEl.hidden = true;
            currentPath = '';
            break;
        case 'castRelayLost':
            onSignalingLost();
            break;
    }
});

loadProgress();

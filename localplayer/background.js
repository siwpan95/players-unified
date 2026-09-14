'use strict';

// MV3 service worker：负责从远端后端拉取媒体清单，
// 供 popup 通过 chrome.runtime.sendMessage 调用；
// 并管理 offscreen 文档用于后台音频续播。

const DEFAULT_BACKEND = 'http://127.0.0.1:5000';
const OFFSCREEN_URL = 'offscreen.html';

// 后端地址可经 chrome.storage.sync 覆盖（键：backendUrl）
function getBackendUrl() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage) {
      resolve(DEFAULT_BACKEND);
      return;
    }
    chrome.storage.sync.get({ backendUrl: DEFAULT_BACKEND }, (items) => {
      resolve(items.backendUrl || DEFAULT_BACKEND);
    });
  });
}

async function fetchMediaList() {
  const base = await getBackendUrl();
  try {
    const res = await fetch(base.replace(/\/$/, '') + '/api/list', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (Array.isArray(data.files) ? data.files : []);
    // 规范化：后端返回 MediaItem（schema/media-item.schema.json）。
    // 透传规范字段，并补齐 name/type/path 过渡别名以兼容 popup 既有逻辑。
    return {
      ok: true,
      files: list
        .filter((f) => f && (f.uri || f.path))
        .map((f) => {
          const uri = f.uri || f.path;
          const kind = f.kind || f.type
            || (/\.(mp3|ogg|wav|m4a|aac|flac)$/i.test(uri) ? 'audio' : 'video');
          return {
            id: f.id || undefined,
            uri: uri,
            title: f.title || f.name || uri.split('/').pop(),
            artist: f.artist ?? undefined,
            kind: kind,
            durationMs: f.durationMs ?? undefined,
            source: f.source || 'remote',
            subtitleTracks: Array.isArray(f.subtitleTracks)
              ? f.subtitleTracks
              : (Array.isArray(f.tracks) ? f.tracks : undefined),
            // 过渡别名
            name: f.name || uri.split('/').pop(),
            type: kind,
            path: uri,
            remote: true
          };
        })
    };
  } catch (err) {
    // 后端未启动/不可达：返回未可达标记，由 popup 静默回落本地源（不刷 warn）
    return { ok: false, unreachable: true };
  }
}

// ---------- offscreen 管理（后台音频） ----------
let lastOffscreenState = null;

async function ensureOffscreen() {
  if (typeof chrome === 'undefined' || !chrome.offscreen) return false;
  try {
    if (await chrome.offscreen.hasDocument?.().catch(() => false)) return true;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK'],
      justification: '后台播放音频，使 popup 关闭后音乐继续'
    });
    return true;
  } catch (e) {
    console.warn('[background] 创建 offscreen 失败:', e);
    return false;
  }
}

function sendToOffscreen(cmd, extra) {
  if (!chrome.offscreen) return;
  chrome.runtime.sendMessage(Object.assign({ target: 'offscreen', cmd }, extra)).catch(() => {});
}

// ---------- 网页投送信令中转（offscreen 直连失败时的退路） ----------
let castRelayWs = null;
const CAST_SIGNAL_URL = 'ws://127.0.0.1:5000/ws';

function ensureCastRelay() {
  if (castRelayWs && (castRelayWs.readyState === 0 || castRelayWs.readyState === 1)) return;
  try { castRelayWs = new WebSocket(CAST_SIGNAL_URL); }
  catch (e) { console.warn('[background] 投送信令中转连接失败:', e); return; }
  castRelayWs.onopen = () => castRelayWs.send(JSON.stringify({ type: 'role', role: 'sender' }));
  castRelayWs.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    // 转发给 offscreen（offscreen 以 castRelayIn 接收）
    chrome.runtime.sendMessage({ target: 'castRelayIn', msg: m }).catch(() => {});
  };
  castRelayWs.onclose = () => {
    castRelayWs = null;
    chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'castRelayLost' }).catch(() => {});
  };
  castRelayWs.onerror = () => { try { castRelayWs.close(); } catch (_) {} castRelayWs = null; };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return;
  switch (msg.action) {
    case 'getMediaList':
      fetchMediaList().then((result) => sendResponse(result));
      return true; // 保持消息通道，等待异步响应
    case 'ensureOffscreen':
      ensureOffscreen().then(sendResponse);
      return true;
    case 'audioLoad':
      ensureOffscreen().then((ok) => { if (ok) sendToOffscreen('load', { url: msg.url, meta: msg.meta, startTime: msg.startTime }); });
      return false; // 无需回复调用方，offscreen 会直接回报状态
    case 'audioPlay':
      sendToOffscreen('play');
      return false;
    case 'audioPause':
      sendToOffscreen('pause');
      return false;
    case 'audioSeek':
      sendToOffscreen('seek', { time: msg.time });
      return false;
    case 'castStart':
      ensureOffscreen().then((ok) => { if (ok) sendToOffscreen('castStart', { url: msg.url, meta: msg.meta, startTime: msg.startTime, kind: msg.kind }); });
      return false;
    case 'castStop':
      sendToOffscreen('castStop');
      return false;
    case 'castRelay':
      ensureCastRelay();
      if (castRelayWs) {
        if (castRelayWs.readyState === 1) {
          castRelayWs.send(JSON.stringify(msg.msg));
        } else {
          castRelayWs.addEventListener('open', () => castRelayWs.send(JSON.stringify(msg.msg)), { once: true });
        }
      }
      return false;
    case 'getOffscreenState':
      sendResponse(lastOffscreenState || { playing: false, currentTime: 0, duration: 0 });
      return true;
    case 'offscreenState':
      lastOffscreenState = msg; // 直接由 offscreen 广播给 popup，此处仅缓存
      return false;
    case 'offscreenEnded':
    case 'offscreenNext':
    case 'offscreenPrev':
      chrome.runtime.sendMessage(msg).catch(() => {}); // 转发给 popup（仅 popup 打开时有效）
      return false;
    default:
      return false;
  }
});

// ---------- 右键菜单：打开常驻界面（侧边栏 / 独立应用） ----------
function setupContextMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'open_player', title: '打开独立播放器页面', contexts: ['action'] });
  });
  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === 'open_player') {
      chrome.tabs.create({ url: chrome.runtime.getURL('player.html') }).catch(() => {});
    }
  });
}

if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(setupContextMenus);
}

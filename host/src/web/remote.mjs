/**
 * 投送面插件 —— 把 `localplayer/server.py` 的 `/ws`（WebRTC 信令中继）与 `/remote`
 * （外部观看页）吸收进宿主。与 `library-face.mjs` **共用同一个 HTTP 服务**（`ctx.web`），
 * 因此三者天然同源同端口 —— 这正是 `/remote` 页面里 `ws://location.host/ws` 成立的前提。
 *
 * 分工：
 *   · `signaling.mjs`（纯状态机）：谁在什么时刻收到什么，与 python 逐行对齐，可单测。
 *   · 本文件（宿主 wrapper）：把连接挂到 hub 上、把页面发出去、把坏消息断掉。
 *
 * 相对 python 侧的三处差异（都是为了在 Node 里活得更好，已在 A/B 测试里单列）：
 *   1) 信令用**自写 RFC6455**（`lib/ws.mjs`），不引 `ws` —— 零依赖约束。
 *      并且比 python/flask-sock 多守一条：升级请求要过 Host/Origin 白名单
 *      （python 完全不看 Origin，任意网页都能连上来当接收端）。
 *   2) 非法消息（非 JSON / 非对象）用 **1003** 明确关闭；python 是让
 *      `json.loads` / `msg.get` 抛异常把连接带崩（无关闭码）。
 *   3) `/remote` 页面带一份**专用 CSP**（`ctx.web` 的默认 CSP 是 `default-src 'none'`，
 *      会把页面的内联脚本一起挡掉 —— 这个坑在下面的 REMOTE_CSP 注释里有说明）。
 *
 * config: { maxPayload?: number }
 */

import { SignalingHub } from './signaling.mjs'
import { upgrade, rejectUpgrade, CLOSE_CODE } from '../../lib/ws.mjs'

const WS_PATH = '/ws'
const REMOTE_PATH = '/remote'

/**
 * 观看页的 CSP。
 *
 * 关键：`ctx.web` 的默认安全头里是 `default-src 'none'`（对 JSON/二进制面正合适），
 * 但 `script-src` 没被显式给出 → 内联 `<script>` 被 `default-src 'none'` 挡死，
 * 页面会「加载成功但什么都不发生」。所以观看页必须给出自己的 CSP，把
 * `script-src 'unsafe-inline'` 与 `connect-src`（同源 ws/http）显式放开。
 * 不给 `media-src` 加 `blob:` 会影响部分浏览器把 MediaStream 挂到 <video> 的行为。
 */
function remoteCsp(port) {
  const origins = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  const connect = origins.flatMap((o) => [`http://${o}`, `ws://${o}`]).join(' ')
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `connect-src ${connect}`,
    "media-src 'self' blob: mediastream:",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

/** 观看页 HTML —— 与 python 版同协议、同 DOM id，仅样式与状态文案微调 */
function remoteHtml(port) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>轻量播放器 · 网页投送</title>
<style>
  body{margin:0;background:#0f0f12;color:#eaeef2;font-family:system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px}
  h1{font-size:1.1rem;font-weight:500;color:#b9c4d0}
  video{width:min(90vw,960px);background:#000;border-radius:16px;box-shadow:0 20px 40px -12px rgba(0,0,0,.8)}
  #status{font-size:.85rem;color:#8a98a8}
  .hint{font-size:.75rem;color:#6b7684;max-width:90vw;text-align:center}
  button{background:#2e4b7c;color:#fff;border:none;border-radius:30px;padding:8px 18px;cursor:pointer;font-size:.85rem}
</style>
</head>
<body>
  <h1>🔊 网页投送（WebRTC）</h1>
  <div id="title" style="font-size:.95rem;color:#cdd6e0;max-width:90vw;text-align:center"></div>
  <video id="rv" autoplay playsinline controls></video>
  <div id="status">正在连接信令…</div>
  <button id="reconnect">重新连接</button>
  <div class="hint">信令由 players-unified 宿主提供（同源 http://127.0.0.1:${port}），
  取代 localplayer 的 Flask 后端。此页须从 <code>http://127.0.0.1:${port}/remote</code> 打开。</div>
<script>
const video = document.getElementById('rv');
const statusEl = document.getElementById('status');
let pc = null, ws = null;
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function connect() {
  statusEl.textContent = '正在连接信令…';
  ws = new WebSocket('ws://' + location.host + '/ws');
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'role', role: 'viewer' })); statusEl.textContent = '已就位，等待投送…'; };
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'offer') {
      pc = new RTCPeerConnection(rtcConfig);
      pc.ontrack = (ev) => { video.srcObject = ev.streams[0]; };
      pc.onicecandidate = (ev) => { if (ev.candidate) ws.send(JSON.stringify({ type: 'candidate', candidate: ev.candidate })); };
      await pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
      statusEl.textContent = '接收中…';
    } else if (m.type === 'candidate') {
      try { await pc.addIceCandidate(m.candidate); } catch (e) {}
    } else if (m.type === 'meta') {
      const titleEl = document.getElementById('title');
      const t = [m.title, m.artist].filter(Boolean).join(' — ');
      titleEl.textContent = t || '';
    } else if (m.type === 'sender-gone') {
      statusEl.textContent = '发送端已断开';
    }
  };
  ws.onclose = () => { statusEl.textContent = '信令断开'; };
  ws.onerror = () => { statusEl.textContent = '信令错误'; };
}
document.getElementById('reconnect').onclick = () => { if (pc) { pc.close(); pc = null; } connect(); };
connect();
</script>
</body>
</html>`
}

const apply = (ctx, config = {}) => {
  const hub = new SignalingHub()
  const connections = new Set()
  const maxPayload = config.maxPayload ?? 1 << 20

  /* ---------- /ws 升级 ---------- */
  ctx.effect(() => ctx.web.upgrade((req, socket, head) => {
    let url
    try {
      url = new URL(req.url, ctx.web.origin)
    } catch {
      return false
    }
    if (url.pathname !== WS_PATH) return false

    const result = upgrade(req, socket, head, {
      maxPayload,
      // 关键：监听器在 feed(head) 之前接好，否则「连上就发」的第一条会被丢掉
      onConnection(conn) {
        connections.add(conn)
        hub.join(conn)
        conn.on('error', (error) => ctx.logger.warn(`[ws] socket 错误: ${error.message}`))
        conn.on('frame-error', (event) => ctx.logger.warn(`[ws] 协议错误 ${event.code}: ${event.reason}`))
        conn.on('message', (text) => {
          const outcome = hub.message(conn, text)
          if (!outcome.ok) {
            ctx.logger.warn(`[ws] 收到非法信令（${outcome.reason}），以 1003 断开`)
            conn.close(CLOSE_CODE.UNSUPPORTED_DATA, `expected JSON object (${outcome.reason})`)
          }
        })
        conn.on('close', (info) => {
          connections.delete(conn)
          hub.leave(conn)
          ctx.logger.info(`[ws] 信令连接断开 code=${info.code} clean=${info.clean}，剩余 ${connections.size} 条`)
        })
      },
    })
    if (result.error) {
      rejectUpgrade(socket, result.error.status, result.error.message, result.error.extra)
      return true
    }
    ctx.logger.info(`[ws] 信令连接建立（共 ${connections.size} 条）`)
    return true
  }))

  /* ---------- /remote 观看页 + /ws 的非升级访问提示 ---------- */
  ctx.effect(() => ctx.web.route((req, res, url) => {
    if (url.pathname === REMOTE_PATH) {
      ctx.web.html(res, 200, remoteHtml(ctx.web.port), { 'Content-Security-Policy': remoteCsp(ctx.web.port) })
      return true
    }
    if (url.pathname === WS_PATH) {
      // 浏览器直接打开 /ws 时给个人话提示，而不是 404
      ctx.web.text(res, 400, '这是 WebSocket 信令端点，需要 Upgrade: websocket 握手')
      return true
    }
    return false
  }))

  /* ---------- 卸载时把连接收干净 ---------- */
  ctx.effect(() => () => {
    for (const conn of [...connections]) conn.close(CLOSE_CODE.GOING_AWAY, '宿主关闭')
    connections.clear()
  })

  ctx.logger.info(`[remote] 投送面已挂载 ${WS_PATH}（自写 RFC6455）与 ${REMOTE_PATH}`)
}

export default {
  name: 'remote-cast',
  inject: ['web'],
  apply,
}

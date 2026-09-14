"""
Flask 示例后端：为扩展的「模式 B」提供媒体文件与清单 API，并承载 WebRTC 信令与
「网页投送」的外部观看页。

运行：
    pip install -r requirements.txt
    python server.py
默认监听 http://127.0.0.1:5000

接口：
    GET  /api/list           媒体清单 JSON 数组，每项为一个 MediaItem（见 schema/media-item.schema.json）
    GET  /media/<filename>   返回 media/ 目录下的媒体文件
    WS   /ws                 WebRTC 信令中继（offscreen 发送端 <-> 外部网页观看端）
    GET  /remote             外部观看页（接收 offscreen 经 WebRTC 投送的音视频）

/api/list 的每项遵循 players-unified 跨端共享契约 MediaItem：
    { id, uri, title, artist, kind, durationMs, source, subtitleTracks, thumbnail }
为兼容尚未迁移的扩展前端，每项额外附带过渡别名 name / type / path（未来阶段移除）。
"""
import os
import json
from flask import Flask, send_from_directory, jsonify, request
from flask_sock import Sock
from media_lib import build_media_items

BASE = os.path.dirname(os.path.abspath(__file__))
MEDIA_DIR = os.path.join(BASE, 'media')

app = Flask(__name__)
sock = Sock(app)

# ---------- 信令中继：单一发送端 + 单一观看端 ----------
_peers = {'sender': None, 'viewer': None}
_last_meta = None  # 发送端最近一次投送的曲目元数据，供晚加入的观看端获取


def _relay_to_other(role, msg):
    other = _peers['viewer'] if role == 'sender' else _peers['sender']
    if other is not None:
        try:
            other.send(json.dumps(msg))
        except Exception:
            pass


def _notify_sender(msg):
    s = _peers.get('sender')
    if s is not None:
        try:
            s.send(json.dumps(msg))
        except Exception:
            pass


@sock.route('/ws')
def ws_signaling(ws):
    role = None
    try:
        while True:
            data = ws.receive()
            if data is None:
                break
            msg = json.loads(data)
            mtype = msg.get('type')
            if mtype == 'role':
                role = msg.get('role')
                _peers[role] = ws
                if role == 'viewer':
                    # 通知发送端：有 1 个接收端上线
                    _notify_sender({'type': 'viewer-count', 'count': 1})
                    # 把已缓存的曲目信息补发给晚加入的接收端
                    if _last_meta is not None:
                        try:
                            ws.send(json.dumps(_last_meta))
                        except Exception:
                            pass
                # 双方就位后，请发送端发起 offer
                if _peers['sender'] is not None and _peers['viewer'] is not None:
                    _notify_sender({'type': 'offer-request'})
            else:
                if mtype == 'meta':
                    _last_meta = msg
                _relay_to_other(role, msg)
    finally:
        if role is not None and _peers.get(role) is ws:
            _peers[role] = None
        if role == 'viewer':
            _notify_sender({'type': 'viewer-count', 'count': 0})
        elif role == 'sender':
            v = _peers.get('viewer')
            if v is not None:
                try:
                    v.send(json.dumps({'type': 'sender-gone'}))
                except Exception:
                    pass


@app.route('/api/list')
def media_list():
    """返回 media/ 目录下媒体的 MediaItem 清单（跨端共享契约，见 schema/media-item.schema.json）。

    列表构建逻辑抽到 media_lib.build_media_items（纯函数，可单测，不依赖 Flask 上下文）。
    """
    return jsonify(build_media_items(MEDIA_DIR, request.host_url.rstrip('/')))


@app.route('/media/<path:filename>')
def media_file(filename):
    return send_from_directory(MEDIA_DIR, filename)


@app.route('/remote')
def remote_viewer():
    return REMOTE_HTML


@app.route('/')
def index():
    return INDEX_HTML


@app.route('/favicon.ico')
def favicon():
    return '', 204


REMOTE_HTML = """<!DOCTYPE html>
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
  button{background:#2e4b7c;color:#fff;border:none;border-radius:30px;padding:8px 18px;cursor:pointer;font-size:.85rem}
</style>
</head>
<body>
  <h1>🔊 网页投送（WebRTC）</h1>
  <div id="title" style="font-size:.95rem;color:#cdd6e0;max-width:90vw;text-align:center"></div>
  <video id="rv" autoplay playsinline controls></video>
  <div id="status">正在连接信令…</div>
  <button id="reconnect">重新连接</button>
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
</html>"""


INDEX_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>轻量播放器 · 本地后端</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0f0f12;color:#eaeef2;margin:2rem;line-height:1.7}
h1{font-size:1.2rem;font-weight:500}a{color:#7aa2f7}code{background:#1c1c22;padding:2px 6px;border-radius:4px}</style>
</head>
<body>
<h1>轻量播放器 · 本地后端</h1>
<p>这是扩展「模式 B」的可选 Flask 后端，提供媒体清单与网页投送信令。</p>
<ul>
  <li><a href="/api/list">/api/list</a> — 媒体清单 JSON（供扩展「远端后端」源拉取）</li>
  <li><a href="/remote">/remote</a> — 网页投送观看页（接收端）</li>
  <li>WebSocket <code>/ws</code> — WebRTC 信令中继</li>
</ul>
</body></html>"""


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000)

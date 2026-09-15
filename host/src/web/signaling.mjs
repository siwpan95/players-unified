/**
 * WebRTC 信令中继的**纯状态机** —— `localplayer/server.py` 里 `ws_signaling()` 的逐行移植。
 *
 * 为什么单独抽成纯模块：协议的行为细节（谁在什么时刻收到什么）是这一版最值钱的东西，
 * 而线上最容易出的错也是它。抽成纯函数后可以不上网络直接单测，也可以被
 * `tests/remote-parity.mjs` 拿去做「同一份剧本 × python / 宿主」的 A/B 对拍。
 *
 * 与 python 的对应关系（server.py 行号以移植时版本为准）：
 *   _peers = {'sender': None, 'viewer': None}          → this.peers
 *   _last_meta                                        → this.lastMeta
 *   role = msg.get('role'); _peers[role] = ws         → message() 的 role 分支
 *   viewer 上线 → 通知发送端 viewer-count:1 + 补发 _last_meta
 *   双方就位 → 通知发送端 offer-request
 *   其余消息 → meta 记缓存，然后中继给「另一方」
 *   finally  → 槽位身份校验（is ws）后清空；viewer 掉线通知 sender count:0；
 *               sender 掉线给 viewer 发 sender-gone
 *
 * **刻意保留的行为**（看着像 bug，但它是 python 的语义，移植必须一致）：
 *   · 槽位是「最后一个赢」：第二个 viewer 连上来会覆盖 `peers.viewer`，第一个 viewer
 *     从此不在槽位里。它掉线时因为身份校验不过，不会把槽位清空，但仍会给发送端
 *     发一次 `viewer-count: 0` —— 也就是发送端可能连着收到两次 0。
 *   · 发送端**晚于** viewer 上线时，不会收到 `viewer-count: 1`（那条只在 viewer 上线时发）。
 *   · `role` 的取值不校验，`peers[role] = peer` 直接按字符串当键写。
 *   · 中继是「发给另一方」，与消息类型无关（`meta` 既缓存也照样转发）。
 *
 * 一处**有意的收紧**：python 用 `json.loads` 解析失败会抛异常、把连接带崩；
 * 这里返回 `{ ok:false, reason }` 让调用方以明确的关闭码断开（`remote.mjs` 用 1003）。
 * 差异只体现在「坏消息的关闭码」上，正常剧本逐条一致（A/B 测试里单列一项对比）。
 */

const MAX_HISTORY = 200

export class SignalingHub {
  constructor() {
    /** 与 python 完全一致：只有发送端槽与接收端槽，后来者覆盖前者 */
    this.peers = { sender: null, viewer: null }
    /** peer → 它自己声明过的 role（python 里是每个连接闭包里的局部变量） */
    this.roles = new Map()
    /** 发送端最近一次 meta，供晚加入的接收端补发 */
    this.lastMeta = null
    /** 诊断用：最近的信令流水（进出都记） */
    this.history = []
  }

  #record(direction, peer, payload) {
    this.history.push({ direction, peer, payload, at: Date.now() })
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY)
  }

  /** 发一条给某连接；失败静默（python 里是 try/except pass） */
  send(peer, message) {
    this.#record('out', peer, message)
    if (!peer) return false
    try {
      if (typeof peer.sendJson === 'function') peer.sendJson(message)
      else peer.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  /** python 的 _notify_sender */
  notifySender(message) {
    return this.send(this.peers.sender, message)
  }

  /** python 的 _relay_to_other：role 不是 'sender' 的一律发给 sender（含 role 为 null） */
  relayToOther(role, message) {
    return this.send(role === 'sender' ? this.peers.viewer : this.peers.sender, message)
  }

  roleOf(peer) {
    return this.roles.get(peer) ?? null
  }

  /** 新连接建立（python 里是进入 `def ws_signaling(ws)` 那一刻） */
  join(peer) {
    this.roles.set(peer, null)
    return peer
  }

  /**
   * 一条入站文本消息。
   * @returns {{ok:true} | {ok:false, reason:'not-json'|'not-object'}}
   */
  message(peer, text) {
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      this.#record('in', peer, { raw: String(text).slice(0, 80), invalid: 'not-json' })
      return { ok: false, reason: 'not-json' }
    }
    // python 用 msg.get(...)，对非 dict 会抛 AttributeError —— 这里显式判定
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      this.#record('in', peer, { raw: String(text).slice(0, 80), invalid: 'not-object' })
      return { ok: false, reason: 'not-object' }
    }
    this.#record('in', peer, msg)

    const type = msg.type
    if (type === 'role') {
      const role = msg.role ?? null
      this.roles.set(peer, role)
      this.peers[role] = peer // 不校验取值，与 python 一致
      if (role === 'viewer') {
        this.notifySender({ type: 'viewer-count', count: 1 })
        if (this.lastMeta !== null) this.send(peer, this.lastMeta)
      }
      if (this.peers.sender && this.peers.viewer) this.notifySender({ type: 'offer-request' })
    } else {
      if (type === 'meta') this.lastMeta = msg
      this.relayToOther(this.roleOf(peer), msg)
    }
    return { ok: true }
  }

  /** 连接断开（python 的 finally 分支） */
  leave(peer) {
    const role = this.roleOf(peer)
    this.roles.delete(peer)
    if (role !== null && this.peers[role] === peer) this.peers[role] = null
    if (role === 'viewer') {
      this.notifySender({ type: 'viewer-count', count: 0 })
    } else if (role === 'sender') {
      const viewer = this.peers.viewer
      if (viewer) this.send(viewer, { type: 'sender-gone' })
    }
  }

  /** 便于测试与 --trace 的快照 */
  snapshot() {
    return {
      sender: this.peers.sender ? 'connected' : null,
      viewer: this.peers.viewer ? 'connected' : null,
      lastMeta: this.lastMeta,
      roles: [...this.roles.values()],
    }
  }
}

export default SignalingHub

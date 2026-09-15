/**
 * `host/lib/ws.mjs` —— 手写的最小 RFC6455 WebSocket **服务端**实现（零依赖）。
 *
 * ============================ 为什么要自己写 ============================
 * S5-3 要吸收 `localplayer/server.py` 的 `/ws`（WebRTC 信令中继）。python 侧靠
 * `flask-sock`，Node 侧通常靠 `ws`。但本宿主的既定约束是**零第三方运行时依赖**
 * （S5-1 只装了 cordis + loader 这一对必须的），而 `/ws` 用到的协议面积很小：
 * 一次握手 + 两种帧 + ping/pong/close。为这点面积引入 `ws`（及其 `bufferutil`、
 * `utf-8-validate` 可选原生依赖）不划算，所以自己写。
 *
 * 只实现服务端方向所需的部分，**明确不做**（写在代码里，免得后来者以为是漏了）：
 *   · 不做 permessage-deflate 压缩协商 —— 客户端若在 `Sec-WebSocket-Extensions` 里
 *     请求，我们**不回应**该头，按 RFC 即是「未协商」，双方都不用压缩。
 *   · 不做子协议协商之外的扩展、不做 HTTP/2 的 CONNECT 方式升级。
 *   · 不做客户端连接的**发起**（本模块的 `encodeFrame` 支持掩码，测试里的 raw 客户端
 *     用它构造帧，但本模块不提供 `connect()`）。
 * =======================================================================
 *
 * ============================ 实测踩到的四个坑 ============================
 * 1) **`upgrade` 事件可能已经把帧读进内存了。** Node 在 `server.on('upgrade')` 的第
 *    三个参数 `head` 里给出「握手请求之后已经被读掉的那段字节」。若是客户端把握手和
 *    第一帧一口气写出来，第一帧就在这里。必须在写完 101 **之后**把它喂进解析器，
 *    且**监听器要先接好**（否则事件无人收，静默丢消息）—— 本模块用
 *    `upgrade(..., { onConnection })` 这个「喂 head 之前的钩子」把顺序钉死。
 * 2) **服务端必须拒绝未加掩码的客户端帧。** RFC6455 §5.3：客户端→服务端**必须**掩码，
 *    服务端→客户端**必须**不掩码；收到未掩码的客户端帧要按协议错误关闭（1002）。
 *    这条在真机上一旦漏掉，用真浏览器测也未必暴露（浏览器总是掩码），只有 raw 客户端
 *    才测得出来，所以本模块把它做成默认且写进测试。
 * 3) **UTF-8 校验必须在「整条消息重组完」之后做**，不能在分片阶段做 ——
 *    一个汉字的三字节可能正好被切在两个分片之间。同理长度上限也要按重组后的总长算。
 * 4) **close 帧写完要 `end()`，不能靠定时器。** 只用 `socket.write(closeFrame)` 而不
 *    end，对端可能一直不主动关，连接就悬着；用定时器 destroy 又会跟 `socket.end()` 抢
 *    时序。直接 `socket.end(frame)`（写+半关）既保证对端读得到关闭码，又不会留悬挂连接。
 * 5) **「数据不足」与「消费了但没事件」必须是两个不同的返回值。** 解析循环里
 *    `break` 只该用于前者；把非终帧分片也当成 break，会让「客户端一口气写出
 *    分片的两帧」永远交付不了（要等下一个字节到达才继续解析）。
 *    本模块用 `undefined` / `null` 三态区分，见 `FrameDecoder.push()`。
 * =======================================================================
 *
 * 导出：
 *   OPCODE / CLOSE_CODE        常量
 *   acceptKey(key)             握手密钥 → Sec-WebSocket-Accept
 *   encodeFrame(payload, opts) 编码一个帧（服务端 `mask:false`，测试客户端 `mask:true`）
 *   FrameDecoder               流式帧解析器（纯，无 I/O，可直接单测）
 *   WebSocketConnection        一个已建立的连接（EventEmitter）
 *   upgrade(req, socket, head, opts)  完成握手并返回连接；失败返回 { error }
 *   rejectUpgrade(socket, status, message, extra)  用裸 HTTP 响应拒绝升级
 */

import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
}

export const CLOSE_CODE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  NO_STATUS: 1005,
  ABNORMAL: 1006,
  INVALID_PAYLOAD: 1007,
  POLICY_VIOLATION: 1008,
  TOO_LARGE: 1009,
  INTERNAL_ERROR: 1011,
}

/** RFC6455 §1.3 的握手魔数 */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Sec-WebSocket-Accept = base64(sha1(key + GUID)) */
export function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64')
}

const STATUS_TEXT = {
  400: 'Bad Request',
  403: 'Forbidden',
  405: 'Method Not Allowed',
  426: 'Upgrade Required',
}

const DATA_OPCODES = new Set([OPCODE.CONTINUATION, OPCODE.TEXT, OPCODE.BINARY])
const CONTROL_OPCODES = new Set([OPCODE.CLOSE, OPCODE.PING, OPCODE.PONG])

/** 关闭码合法性：RFC6455 §7.4.1（1004/1005/1006/1015 等保留值不得出现在帧里） */
export function isValidCloseCode(code) {
  if (!Number.isInteger(code)) return false
  if (code >= 3000 && code <= 4999) return true
  return [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code)
}

/* ============================ 编解码 ============================ */

/**
 * 编码一个帧。
 * @param {Buffer|Uint8Array|string} payload
 * @param {{opcode?:number, fin?:boolean, mask?:boolean, maskKey?:Buffer, rsv?:number}} options
 */
export function encodeFrame(payload, options = {}) {
  const { opcode = OPCODE.TEXT, fin = true, mask = false, rsv = 0 } = options
  const data = Buffer.isBuffer(payload)
    ? payload
    : payload instanceof Uint8Array
      ? Buffer.from(payload)
      : Buffer.from(payload ?? '', 'utf8')
  if (rsv) throw new Error('本实现不支持 RSV 位（没有协商任何扩展）')

  const len = data.length
  let header
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)

  if (!mask) return Buffer.concat([header, data])

  const key = options.maskKey ? Buffer.from(options.maskKey) : crypto.randomBytes(4)
  if (key.length !== 4) throw new Error('maskKey 必须是 4 字节')
  header[1] |= 0x80
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ key[i & 3]
  return Buffer.concat([header, key, masked])
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })
/** 严格 UTF-8 校验；不合法返回 null（RFC 要求 1007） */
function decodeUtf8(buf) {
  try {
    return UTF8.decode(buf)
  } catch {
    return null
  }
}

/**
 * 流式帧解析器。**纯逻辑，无 I/O**：`push(chunk)` 返回一组事件。
 *
 * 事件形状：
 *   { op:'message', opcode, data:Buffer, text:string|null, binary:boolean }
 *   { op:'ping',  payload:Buffer }
 *   { op:'pong',  payload:Buffer }
 *   { op:'close', code:number|null, reason:string }
 *   { op:'error', code:number, reason:string }     // 协议错误，调用方应用该码关闭
 *
 * 出现 error 事件后解析器自我标记 dead，后续 push 一律返回空数组（不再解析半截数据）。
 */
export class FrameDecoder {
  constructor({ maxPayload = 1 << 20, requireMask = true } = {}) {
    this.maxPayload = maxPayload
    this.requireMask = requireMask
    this.buf = Buffer.alloc(0)
    this.fragmentOpcode = 0
    this.fragments = []
    this.fragmentLength = 0
    this.dead = false
  }

  push(chunk) {
    if (this.dead) return []
    if (chunk && chunk.length) this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const events = []
    while (!this.dead) {
      const event = this.#next()
      // 坑 5：`undefined` = 数据不足，等下一次 push；`null` = 消费了一帧但没产生事件
      // （非终帧分片），**必须继续解析同一批数据里的后续帧**。早先把两者混用同一个
      // 返回值，导致「客户端把分片的两帧一次性写出来」时消息永远交付不了
      // （要等下一个字节到达才继续）—— 是 ws-rfc6455 的 C11/C12/C13 抓出来的。
      if (event === undefined) break
      if (event === null) continue
      events.push(event)
      if (event.op === 'error') this.dead = true
    }
    return events
  }

  #fail(code, reason) {
    this.dead = true
    return { op: 'error', code, reason }
  }

  /**
   * 解析一个帧。
   * @returns {object|undefined|null} 事件 / `undefined`=数据不足 / `null`=消费了一帧
   *   但没有事件（非终帧分片）—— 三态必须区分，见 `push()` 里的坑 5。
   */
  #next() {
    const b = this.buf
    if (b.length < 2) return undefined

    const b0 = b[0]
    const b1 = b[1]
    const fin = (b0 & 0x80) !== 0
    const rsv = b0 & 0x70
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let off = 2

    if (rsv !== 0) return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, 'RSV 位非零（未协商任何扩展，保留位必须为 0）')
    if (this.requireMask && !masked) {
      return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, '客户端帧未加掩码（RFC6455 要求客户端必须掩码）')
    }
    if (!DATA_OPCODES.has(opcode) && !CONTROL_OPCODES.has(opcode)) {
      return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, `未知 opcode 0x${opcode.toString(16)}`)
    }

    if (len === 126) {
      if (b.length < off + 2) return undefined
      len = b.readUInt16BE(off)
      off += 2
    } else if (len === 127) {
      if (b.length < off + 8) return undefined
      const big = b.readBigUInt64BE(off)
      off += 8
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        return this.#fail(CLOSE_CODE.TOO_LARGE, '载荷长度超出可表示范围')
      }
      len = Number(big)
    }

    const isControl = CONTROL_OPCODES.has(opcode)
    if (isControl) {
      if (!fin) return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, '控制帧不允许分片（FIN 必须为 1）')
      if (len > 125) return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, '控制帧载荷不得超过 125 字节')
    }
    if (len > this.maxPayload) {
      return this.#fail(CLOSE_CODE.TOO_LARGE, `载荷 ${len} 超过上限 ${this.maxPayload}`)
    }

    const total = off + (masked ? 4 : 0) + len
    if (b.length < total) return undefined

    const key = masked ? b.subarray(off, off + 4) : null
    if (masked) off += 4
    let payload = b.subarray(off, off + len)
    if (masked) {
      const unmasked = Buffer.allocUnsafe(len)
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ key[i & 3]
      payload = unmasked
    } else {
      payload = Buffer.from(payload)
    }
    this.buf = b.subarray(total)

    if (opcode === OPCODE.PING) return { op: 'ping', payload }
    if (opcode === OPCODE.PONG) return { op: 'pong', payload }
    if (opcode === OPCODE.CLOSE) return this.#closeEvent(payload)

    /* ---- 数据帧 / 分片重组 ---- */
    if (opcode === OPCODE.CONTINUATION) {
      if (this.fragmentOpcode === 0) {
        return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, '没有开始分片却收到 CONTINUATION 帧')
      }
    } else {
      if (this.fragmentOpcode !== 0) {
        return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, '上一组消息还没结束就开始了新消息')
      }
      this.fragmentOpcode = opcode
    }
    this.fragmentLength += len
    if (this.fragmentLength > this.maxPayload) {
      return this.#fail(CLOSE_CODE.TOO_LARGE, `重组后长度 ${this.fragmentLength} 超过上限 ${this.maxPayload}`)
    }
    this.fragments.push(payload)
    if (!fin) return null // 消费了但没事件：等后续 CONTINUATION

    const data = this.fragments.length === 1
      ? this.fragments[0]
      : Buffer.concat(this.fragments, this.fragmentLength)
    const dataOpcode = this.fragmentOpcode
    this.fragmentOpcode = 0
    this.fragments = []
    this.fragmentLength = 0

    if (dataOpcode === OPCODE.TEXT) {
      // 坑 3：UTF-8 校验放在重组之后
      const text = decodeUtf8(data)
      if (text === null) return this.#fail(CLOSE_CODE.INVALID_PAYLOAD, '文本消息不是合法 UTF-8')
      return { op: 'message', opcode: dataOpcode, data, text, binary: false }
    }
    return { op: 'message', opcode: dataOpcode, data, text: null, binary: true }
  }

  #closeEvent(payload) {
    if (payload.length === 0) return { op: 'close', code: null, reason: '' } // 1005：无状态码
    if (payload.length === 1) return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, 'close 帧载荷只有 1 字节')
    const code = payload.readUInt16BE(0)
    const reason = decodeUtf8(payload.subarray(2))
    if (reason === null) return this.#fail(CLOSE_CODE.INVALID_PAYLOAD, 'close 帧的 reason 不是合法 UTF-8')
    if (!isValidCloseCode(code)) {
      return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, `close code ${code} 不合法`)
    }
    return { op: 'close', code, reason }
  }
}

/** 组装 close 帧的载荷：2 字节大端码 + UTF-8 reason（码为 null 时发空载荷） */
export function closePayload(code, reason = '') {
  if (code === null || code === undefined) return Buffer.alloc(0)
  const text = Buffer.from(String(reason ?? ''), 'utf8').subarray(0, 123)
  const buf = Buffer.allocUnsafe(2 + text.length)
  buf.writeUInt16BE(code, 0)
  text.copy(buf, 2)
  return buf
}

/* ============================ 连接 ============================ */

/**
 * 一个已建立的 WebSocket 连接。
 *
 * 事件：
 *   'message' (text:string)   文本消息
 *   'binary'  (data:Buffer)   二进制消息
 *   'ping' / 'pong' (payload:Buffer)
 *   'close'   ({code, reason, clean})
 *   'error'   (Error)         仅在有监听者时 emit —— 避免 EventEmitter 的
 *                             无监听 'error' 直接把宿主进程打崩（库场景下更安全的默认）
 */
export class WebSocketConnection extends EventEmitter {
  constructor(socket, { maxPayload = 1 << 20, isServer = true } = {}) {
    super()
    this.socket = socket
    this.isServer = isServer
    this.closed = false
    this.closeSent = false
    this.closeReceived = false
    this.closeCode = null
    this.closeReason = ''
    this.decoder = new FrameDecoder({ maxPayload, requireMask: isServer })
    this.maxPayload = maxPayload

    socket.setNoDelay?.(true)
    socket.setKeepAlive?.(true)
    socket.setTimeout?.(0) // 信令连接是长连接，禁掉空闲超时
    socket.on('data', (chunk) => this.feed(chunk))
    socket.on('error', (error) => {
      if (this.closed) return
      if (this.listenerCount('error') > 0) this.emit('error', error)
    })
    socket.on('close', () => this.#finish(false))
  }

  /** 喂入原始字节（`upgrade` 的 `head` 与 socket 的 data 都走这里） */
  feed(chunk) {
    if (this.closed) return
    for (const event of this.decoder.push(chunk)) {
      if (event.op === 'error') {
        // 协议错误：按 RFC 用该码关闭对端，并让上层知道原因
        if (this.listenerCount('frame-error') > 0) this.emit('frame-error', event)
        this.close(event.code, event.reason)
        return
      }
      if (event.op === 'close') {
        this.closeReceived = true
        this.closeCode = event.code ?? CLOSE_CODE.NORMAL
        this.closeReason = event.reason
        // 收到 close 要回一个 close（RFC6455 §5.5.1），然后半关
        this.close(this.closeCode, '', { echoOnly: true })
        return
      }
      if (event.op === 'ping') {
        this.pong(event.payload)
        if (this.listenerCount('ping') > 0) this.emit('ping', event.payload)
        continue
      }
      if (event.op === 'pong') {
        if (this.listenerCount('pong') > 0) this.emit('pong', event.payload)
        continue
      }
      if (event.op === 'message') {
        if (event.binary) this.emit('binary', event.data)
        else this.emit('message', event.text)
      }
    }
  }

  /** 发一个帧。字符串 → 文本帧，Buffer/Uint8Array → 二进制帧 */
  send(data) {
    if (this.closed || !this.socket.writable) return false
    const isBuffer = Buffer.isBuffer(data) || data instanceof Uint8Array
    const frame = encodeFrame(data, {
      opcode: isBuffer ? OPCODE.BINARY : OPCODE.TEXT,
      mask: !this.isServer,
    })
    return this.socket.write(frame)
  }

  sendText(text) {
    return this.send(String(text))
  }

  sendJson(value) {
    return this.sendText(JSON.stringify(value))
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.closed || !this.socket.writable) return false
    return this.socket.write(encodeFrame(payload, { opcode: OPCODE.PING, mask: !this.isServer }))
  }

  pong(payload = Buffer.alloc(0)) {
    if (this.closed || !this.socket.writable) return false
    return this.socket.write(encodeFrame(payload, { opcode: OPCODE.PONG, mask: !this.isServer }))
  }

  /**
   * 关闭。`echoOnly` 用于「对端先发 close」的情形：只回帧不再重复记账。
   * 坑 4：close 帧与 FIN 一起写（`socket.end`），不靠定时器。
   */
  close(code = CLOSE_CODE.NORMAL, reason = '', { echoOnly = false } = {}) {
    if (this.closed) return
    if (!this.closeSent) {
      this.closeSent = true
      try {
        this.socket.end(encodeFrame(closePayload(code, reason), {
          opcode: OPCODE.CLOSE,
          mask: !this.isServer,
        }))
      } catch {
        this.socket.destroy?.()
      }
    } else {
      try {
        this.socket.end()
      } catch {
        this.socket.destroy?.()
      }
    }
    this.decoder.dead = true
    this.#finish(true, code, reason, echoOnly)
  }

  /** 立刻断开，不走关闭握手 */
  destroy() {
    this.decoder.dead = true
    try {
      this.socket.destroy()
    } catch {
      /* ignore */
    }
    this.#finish(false)
  }

  #finish(clean, code, reason, echoOnly = false) {
    if (this.finished) return
    this.finished = true
    this.closed = true
    this.emit('close', {
      code: code ?? this.closeCode ?? CLOSE_CODE.ABNORMAL,
      reason: reason ?? this.closeReason ?? '',
      clean: !!clean,
      echoOnly,
    })
  }
}

/* ============================ 握手 ============================ */

/**
 * 完成握手。成功返回 `{ connection, accept, protocol }`；失败返回 `{ error }`，
 * 由调用方决定怎么拒绝（通常是 `rejectUpgrade`）。
 *
 * ⚠️ 坑 1 的正确用法：`head` 里的帧会在本函数内被喂进解析器，**因此 `onConnection`
 * 回调必须在喂 `head` 之前把监听器接好**，否则「客户端把握手与第一帧一口气写出来」
 * 时那条消息会无声丢失（喂进去时没有监听者，事件就没了）。所以本函数把
 * `onConnection(connection)` 作为喂 `head` 前的钩子，而不是让调用方在返回值上补挂。
 *
 * 注意：这里**只做协议层校验**（方法/头/版本/key）。Host 与 Origin 白名单属于
 * 宿主的安全策略，由 `ctx.web` 在调用本函数**之前**判定 —— 协议实现不该知道
 * 「允许哪些来源」这种业务规则。
 */
export function upgrade(req, socket, head, options = {}) {
  const { maxPayload = 1 << 20, protocols = null, onConnection = null } = options
  const fail = (status, message, extra) => ({ error: { status, message, extra: extra ?? null } })

  if (req.method !== 'GET') return fail(405, 'WebSocket 握手必须是 GET')
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    return fail(400, '缺少 Upgrade: websocket')
  }
  const connection = String(req.headers.connection || '').toLowerCase()
  if (!connection.split(',').map((s) => s.trim()).includes('upgrade')) {
    return fail(400, '缺少 Connection: Upgrade')
  }
  const version = String(req.headers['sec-websocket-version'] || '')
  if (version !== '13') {
    return fail(426, `不支持的 Sec-WebSocket-Version: ${version || '(缺失)'}`, { 'Sec-WebSocket-Version': '13' })
  }
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) {
    return fail(400, 'Sec-WebSocket-Key 缺失或不是 16 字节 base64')
  }

  let protocol = ''
  if (protocols?.length) {
    const offered = String(req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((s) => s.trim())
    protocol = protocols.find((p) => offered.includes(p)) ?? ''
  }

  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
  ]
  if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`)
  // 刻意不写 Sec-WebSocket-Extensions：未协商 = 不启用 permessage-deflate
  socket.write(lines.join('\r\n') + '\r\n\r\n')

  const conn = new WebSocketConnection(socket, { maxPayload, isServer: true })
  if (typeof onConnection === 'function') onConnection(conn) // 必须先接监听器
  if (head?.length) conn.feed(head) // 坑 1
  return { connection: conn, accept: acceptKey(key), protocol }
}

/** 用**裸 HTTP 响应**拒绝升级（WS 握手失败时对端拿到的是 HTTP 状态码） */
export function rejectUpgrade(socket, status, message, extra = null) {
  const body = Buffer.from(String(message) + '\n', 'utf8')
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${body.length}`,
    'Connection: close',
  ]
  if (extra) for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${v}`)
  try {
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    socket.end(body)
  } catch {
    socket.destroy?.()
  }
  // 对端若迟迟不读，1 秒后强拆，避免连接悬挂
  socket.setTimeout?.(1000, () => socket.destroy?.())
}

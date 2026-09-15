/**
 * 手写 raw WebSocket **客户端**（仅测试用）。
 *
 * 为什么要手写：undici 的 `WebSocket` 是「真客户端」，适合当互操作锚点，但它
 * **构造不出非法帧** —— 未掩码、RSV 位、未知 opcode、控制帧分片、非法 UTF-8、
 * 非法关闭码、跨分片切断的多字节字符…… 这些恰好是 RFC6455 里最值得测的部分。
 * 所以这些用例用一个自己拼字节的 raw 客户端来打。
 *
 * 注意这不是「用自己实现测自己实现」的循环论证：
 *   · 合法帧的**双向**互操作由 undici 的 WebSocket 断言（见 ws-rfc6455.mjs 的 B 组）；
 *   · raw 客户端只用 `encodeFrame`/`FrameDecoder` 这两个纯编解码函数来构造/读取，
 *     它断言的是**服务端对这些字节的反应**（关闭码/是否回 pong/重组结果）。
 * 若编解码的位布局本身错了，B 组会先红。
 */

import net from 'node:net'
import crypto from 'node:crypto'
import { encodeFrame, FrameDecoder, OPCODE } from '../../lib/ws.mjs'

export class RawClient {
  constructor(socket) {
    this.socket = socket
    this.events = []
    this.raw = Buffer.alloc(0)
    this.decoder = new FrameDecoder({ requireMask: false }) // 服务端发来的帧必须不掩码
    this.status = 0
    this.headers = {}
    this.head = ''
    this.acceptOk = null
    socket.on('data', (chunk) => {
      this.raw = Buffer.concat([this.raw, chunk])
      this.events.push(...this.decoder.push(chunk))
    })
    socket.on('error', () => {})
  }

  /** 发一个手工构造的帧 */
  frame(payload, options = {}) {
    this.socket.write(encodeFrame(payload, { mask: true, ...options }))
    return this
  }

  text(value, options = {}) {
    return this.frame(value, { opcode: OPCODE.TEXT, ...options })
  }

  /** 原样写字节（用于构造畸形帧） */
  write(buffer) {
    this.socket.write(buffer)
    return this
  }

  /** 等到 predicate(events) 为真，或超时；返回事件数组快照 */
  async waitFor(predicate, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate(this.events)) return this.events
      await sleep(10)
    }
    return this.events
  }

  of(op) {
    return this.events.filter((e) => e.op === op)
  }

  close() {
    try {
      this.socket.destroy()
    } catch {
      /* ignore */
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 建立一条 raw 连接。**不做 101 校验** —— 由调用方按状态码自行断言，
 * 这样同一个函数既能测「升级被拒」，也能测「升级成功」。
 *
 * @returns {Promise<RawClient>} status/headers/head 已填好；socket 保持打开
 */
export function rawConnect({ port, host = '127.0.0.1', urlPath = '/ws', headers = {}, key = null } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const wsKey = key ?? crypto.randomBytes(16).toString('base64')
    let buffer = Buffer.alloc(0)
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        socket.destroy()
        reject(new Error('raw 握手超时'))
      }
    }, 3000)

    socket.on('error', (error) => {
      if (!done) {
        done = true
        clearTimeout(timer)
        reject(error)
      }
    })
    socket.on('connect', () => {
      // 大小写不敏感地合并头：这样测试可以用 { Upgrade: '' } / { 'Sec-WebSocket-Version': '8' }
      // 直接**替换**默认头，而不是变成两个同名头被解析器拼成 "websocket, "
      const merged = new Map([
        ['Host', `${host}:${port}`],
        ['Upgrade', 'websocket'],
        ['Connection', 'Upgrade'],
        ['Sec-WebSocket-Key', wsKey],
        ['Sec-WebSocket-Version', '13'],
      ])
      for (const [k, v] of Object.entries(headers)) {
        for (const existing of [...merged.keys()]) {
          if (existing.toLowerCase() === k.toLowerCase()) merged.delete(existing)
        }
        merged.set(k, v)
      }
      const lines = [`GET ${urlPath} HTTP/1.1`, ...[...merged].map(([k, v]) => `${k}: ${v}`), '', '']
      socket.write(lines.join('\r\n'))
    })
    const onFirst = (chunk) => {
      if (done) return
      buffer = Buffer.concat([buffer, chunk])
      const at = buffer.indexOf('\r\n\r\n')
      if (at < 0) return
      done = true
      clearTimeout(timer)
      socket.off('data', onFirst)

      const client = new RawClient(socket)
      client.key = wsKey
      const head = buffer.subarray(0, at).toString('utf8')
      client.head = head
      client.status = Number((/^HTTP\/1\.1 (\d+)/.exec(head) ?? [])[1] ?? 0)
      for (const line of head.split('\r\n').slice(1)) {
        const at2 = line.indexOf(':')
        if (at2 > 0) client.headers[line.slice(0, at2).trim().toLowerCase()] = line.slice(at2 + 1).trim()
      }
      const rest = buffer.subarray(at + 4)
      if (rest.length) client.events.push(...client.decoder.push(rest))
      resolve(client)
    }
    socket.on('data', onFirst)
  })
}

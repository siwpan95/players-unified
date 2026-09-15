/**
 * 测试替身：一个最小的 WebSocket echo 面。
 *
 * 为什么要它：`lib/ws.mjs` 的帧级行为（长度段、掩码、分片、控制帧、协议错误）
 * 必须能在一个**受控的**端点上被测。用真实的 `/ws` 信令面测会把「帧对不对」
 * 和「信令状态机对不对」搅在一起，出问题时分不清是哪一层的。
 *
 * 它也是 `ctx.web.upgrade` 的第一个使用者 —— 顺带证明「升级处理器可注册、可撤销」
 * 这条接口在宿主之外也能用。
 *
 * config: { path?: string, maxPayload?: number }
 */

import { upgrade, rejectUpgrade } from '../../lib/ws.mjs'

const apply = (ctx, config = {}) => {
  const path = config.path ?? '/ws-echo'
  const maxPayload = config.maxPayload ?? 1 << 20

  ctx.effect(() => ctx.web.upgrade((req, socket, head) => {
    let url
    try {
      url = new URL(req.url, ctx.web.origin)
    } catch {
      return false
    }
    if (url.pathname !== path) return false

    const result = upgrade(req, socket, head, {
      maxPayload,
      onConnection(conn) {
        conn.on('error', () => {})
        conn.on('message', (text) => conn.send(text))
        conn.on('binary', (data) => conn.send(data))
        conn.on('ping', (payload) => conn.pong(payload))
      },
    })
    if (result.error) {
      rejectUpgrade(socket, result.error.status, result.error.message, result.error.extra)
      return true
    }
    return true
  }))
}

export default {
  name: 'ws-echo-fixture',
  inject: ['web'],
  apply,
}

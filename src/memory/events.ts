/** Server -> Client 的轻量 SSE 事件总线。 */
import type { ServerResponse } from 'node:http'
import type { MemoryRecord } from './store.js'

export type MemoryEvent =
  | { type: 'memory:added'; item: MemoryRecord }
  | { type: 'memory:updated'; item: MemoryRecord }
  | { type: 'memory:removed'; id: string }
  /** 心跳帧：只用于证明链路还活着，前端不得当成业务事件处理。 */
  | { type: 'ping'; at: string }

/** 心跳间隔：维持连接，并让前端有帧可判活（代理静默掐断时能及时发现）。 */
export const SSE_HEARTBEAT_MS = 15_000

function pingFrame(): string {
  return `data: ${JSON.stringify({ type: 'ping', at: new Date().toISOString() })}\n\n`
}

/** 保持打开的 SSE 客户端集合；由 API 注册的 ctx.effect 统一关闭。 */
export class MemoryEventHub {
  private readonly clients = new Set<ServerResponse>()
  private readonly heartbeat: ReturnType<typeof setInterval>

  constructor(heartbeatMs: number = SSE_HEARTBEAT_MS) {
    this.heartbeat = setInterval(() => { this.ping() }, heartbeatMs)
    // 定时器不能把进程留住（测试与热重载会反复 new hub）。
    this.heartbeat.unref()
  }

  subscribe(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    this.clients.add(res)
    // 客户端可能在握手瞬间就断开：首帧写失败立刻摘掉，不能让异常冒到 HTTP handler。
    if (!this.writeTo(res, ': connected\n\n')) {
      this.clients.delete(res)
      try {
        res.end()
      } catch {
        // 已经断开时忽略。
      }
      return
    }
    // 订阅成功立即发一次心跳：前端不必等一个周期才知道链路是活的。
    this.writeTo(res, pingFrame())
    res.on('close', () => {
      this.clients.delete(res)
    })
  }

  publish(event: MemoryEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const res of this.clients) this.writeTo(res, frame)
  }

  private ping(): void {
    const frame = pingFrame()
    for (const res of this.clients) this.writeTo(res, frame)
  }

  private writeTo(res: ServerResponse, frame: string): boolean {
    try {
      res.write(frame)
      return true
    } catch {
      this.clients.delete(res)
      return false
    }
  }

  close(): void {
    clearInterval(this.heartbeat)
    for (const res of this.clients) {
      try {
        res.end()
      } catch {
        // 连接已断开时忽略。
      }
    }
    this.clients.clear()
  }
}

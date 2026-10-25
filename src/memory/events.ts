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
  /** close() 之后拒绝新订阅：否则会得到一个永不心跳、也不会被关闭的连接。 */
  private closed = false

  constructor(heartbeatMs: number = SSE_HEARTBEAT_MS) {
    this.heartbeat = setInterval(() => { this.ping() }, heartbeatMs)
    // 定时器不能把进程留住（测试与热重载会反复 new hub）。
    this.heartbeat.unref()
  }

  subscribe(res: ServerResponse): void {
    if (this.closed) {
      try {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      } catch {
        // 已经断开时忽略。
      }
      try {
        res.end()
      } catch {
        // 同上。
      }
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    // 先挂 close 监听再写首帧：将来若在这两步之间插入异步逻辑也不会漏掉断开。
    res.on('close', () => {
      this.clients.delete(res)
    })
    // 首帧立即出门，避免被 Nagle 攒包。
    res.socket?.setNoDelay(true)
    this.clients.add(res)
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
  }

  publish(event: MemoryEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const res of this.clients) this.writeTo(res, frame)
  }

  private ping(): void {
    const frame = pingFrame()
    for (const res of this.clients) this.writeTo(res, frame)
  }

  /**
   * 写一帧；失败即摘除。
   *
   * 注意真实 Node 的行为：向已经销毁的 socket `write` 通常**返回 false 而不抛错**，
   * 所以先看 `destroyed / writableEnded`，再用 try/catch 兜底同步异常（如 write after end）。
   */
  private writeTo(res: ServerResponse, frame: string): boolean {
    if (res.destroyed === true || res.writableEnded === true) {
      this.clients.delete(res)
      return false
    }
    try {
      res.write(frame)
      // 返回 false 表示内核缓冲已满（慢客户端），不代表连接已死：这里只发不收，
      // 也不做应用层缓冲，交给 Node 与浏览器反压，避免误杀正常但慢的连接。
      return true
    } catch {
      this.clients.delete(res)
      return false
    }
  }

  close(): void {
    this.closed = true
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

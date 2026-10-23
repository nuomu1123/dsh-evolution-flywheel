/** Server -> Client 的轻量 SSE 事件总线。 */
import type { ServerResponse } from 'node:http'
import type { MemoryRecord } from './store.js'

export type MemoryEvent =
  | { type: 'memory:added'; item: MemoryRecord }
  | { type: 'memory:updated'; item: MemoryRecord }
  | { type: 'memory:removed'; id: string }

/** 保持打开的 SSE 客户端集合；由 API 注册的 ctx.effect 统一关闭。 */
export class MemoryEventHub {
  private readonly clients = new Set<ServerResponse>()

  subscribe(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    this.clients.add(res)
    res.on('close', () => {
      this.clients.delete(res)
    })
  }

  publish(event: MemoryEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const res of this.clients) {
      try {
        res.write(frame)
      } catch {
        this.clients.delete(res)
      }
    }
  }

  close(): void {
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

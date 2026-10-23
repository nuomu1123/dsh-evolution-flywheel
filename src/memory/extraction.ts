/** 监听 Host 的 session/event，把命中规则的用户消息写成 suggested 草稿并广播。 */
import type { MemoryContextBase } from './context.js'
import type { MemoryEventHub } from './events.js'
import { extractMemoryCandidate } from './extract.js'
import type { MemoryStore } from './store.js'

interface SessionEventLike {
  type?: string
  data?: {
    source?: { kind?: string }
    content?: Array<{ type?: string; text?: string }>
  }
}

export interface MemoryExtractionContext extends MemoryContextBase {}

function userText(event: SessionEventLike): string | undefined {
  if (event.type !== 'user/message') return undefined
  if (event.data?.source?.kind !== 'user') return undefined
  const text = (event.data.content ?? [])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
    .trim()
  return text === '' ? undefined : text
}

/** 注册 session/event 监听；所有副作用都由 ctx.effect 清理。 */
export function registerMemoryExtraction(
  ctx: MemoryExtractionContext,
  store: MemoryStore,
  events: MemoryEventHub,
): void {
  if (typeof ctx.on !== 'function') return
  try {
    ctx.effect(() => ctx.on('session/event', (_session, event) => {
      try {
        const text = userText(event)
        if (text === undefined) return
        const candidate = extractMemoryCandidate(text)
        if (candidate === undefined) return
        void store.appendSuggested(candidate.content, candidate.type)
          .then(item => {
            if (item !== undefined) events.publish({ type: 'memory:added', item })
          })
          .catch(error => {
            console.error('[dsh-memory-minimal] memory extraction failed:', error)
          })
      } catch (error) {
        console.error('[dsh-memory-minimal] session/event handler failed:', error)
      }
    }))
  } catch (error) {
    console.error('[dsh-memory-minimal] memory extraction registration failed:', error)
  }
}

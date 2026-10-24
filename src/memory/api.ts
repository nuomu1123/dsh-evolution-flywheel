/**
 * 记忆浏览器的 Host HTTP API + SSE。
 *
 * 路由挂在 webServer 的 `/memory-explorer` 前缀下：
 *   GET  /memory-explorer/api/list
 *   GET  /memory-explorer/api/events   (SSE)
 *   POST /memory-explorer/api/approve  { id }
 *   POST /memory-explorer/api/resolution { id, resolution }
 *   POST /memory-explorer/api/human-decision { id, decision }
 *   POST /memory-explorer/api/delete   { id }
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { appendAudit, readAudit } from '../audit.js'
import { dailyBudget } from './budget.js'
import { memoryConfig } from './config.js'
import type { DmaRunner } from './dma.js'
import type { MemoryEventHub } from './events.js'
import { listSecurityIntercepts } from './sanitize.js'
import { summarizeUsage } from './usage.js'
import type { SkillReviewEngine } from './state-machine.js'
import { createStrategyHooks } from './strategy.js'
import type { MemoryContextBase } from './context.js'
import type { MemoryStore } from './store.js'
import { distillModel } from './model-distill.js'

const PREFIX = '/memory-explorer'
const MAX_BODY_BYTES = 16 * 1024

export interface MemoryApiWebServer {
  register(options: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface MemoryApiContext {
  effect(callback: () => () => void): unknown
  inject?(services: readonly string[], callback: (ctx: { webServer: MemoryApiWebServer }) => void): unknown
  get?(name: string): unknown
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

/** 写操作同源闸：浏览器带 Origin 时必须与 Host 一致；非浏览器客户端无 Origin 放行。 */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function requireJsonContentType(req: IncomingMessage): boolean {
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return contentType === 'application/json'
}

/** 处理一次 API/SSE 请求；导出以便测试或诊断。 */
export async function handleMemoryApi(
  req: IncomingMessage,
  res: ServerResponse,
  store: MemoryStore,
  events: MemoryEventHub,
  reviewEngine?: SkillReviewEngine,
  dmaRunner?: DmaRunner,
  modelContext?: { get?(name: string): unknown },
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'POST' && !isSameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-origin write rejected' })
      return
    }

    if (req.method === 'GET' && url.pathname === `${PREFIX}/api/list`) {
      const items = await store.list()
      sendJson(res, 200, {
        ok: true,
        items,
        health: { writeQueue: store.writeQueueBusy ? 'busy' : 'idle' },
      })
      return
    }

    if (req.method === 'GET' && url.pathname === `${PREFIX}/api/health`) {
      sendJson(res, 200, {
        ok: true,
        health: { writeQueue: store.writeQueueBusy ? 'busy' : 'idle' },
      })
      return
    }

    if (req.method === 'GET' && url.pathname === `${PREFIX}/api/security-log`) {
      sendJson(res, 200, { ok: true, limit: 50, entries: listSecurityIntercepts() })
      return
    }

    if (req.method === 'GET' && url.pathname === `${PREFIX}/api/audit`) {
      const limit = Number(url.searchParams.get('limit') ?? '50')
      sendJson(res, 200, { ok: true, entries: readAudit(Number.isFinite(limit) ? limit : 50) })
      return
    }

    if (req.method === 'GET' && url.pathname === `${PREFIX}/api/billing`) {
      const items = await store.list()
      const usage = summarizeUsage(items)
      const stats = typeof dmaRunner?.stats === 'function' ? dmaRunner.stats() : undefined
      const budgetLimit = dailyBudget()
      const budgetRemaining = budgetLimit > 0 ? Math.max(0, budgetLimit - usage.todayTokens) : -1
      const budgetExceeded = budgetLimit > 0 && usage.todayTokens >= budgetLimit
      sendJson(res, 200, {
        ok: true,
        billing: {
          todayTokens: usage.todayTokens,
          totalTokens: usage.totalTokens,
          dmaTodayTokens: usage.dmaTodayTokens,
          dmaTotalTokens: usage.dmaTotalTokens,
          reviewTodayTokens: usage.reviewTodayTokens,
          reviewTotalTokens: usage.reviewTotalTokens,
          debateTodayTokens: usage.debateTodayTokens,
          debateTotalTokens: usage.debateTotalTokens,
          todayRuns: usage.todayRuns,
          totalRuns: usage.totalRuns,
          lastRunTokens: usage.lastRunTokens,
          tokenLimit: memoryConfig.dmaTokenLimit,
          maxTokensPerCall: memoryConfig.dmaMaxTokens,
          disciplineBreakdown: usage.disciplineBreakdown,
          dailyBudget: budgetLimit,
          budgetRemaining,
          budgetExceeded,
          fuseCount: stats?.fuseCount ?? 0,
          ...(stats?.lastFuse !== undefined ? { lastFuse: stats.lastFuse } : {}),
          lastError: stats?.lastError ?? '',
        },
      })
      return
    }

    if (req.method === 'GET' && url.pathname === `${PREFIX}/api/events`) {
      events.subscribe(res)
      return
    }

    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/model/distill`) {
      const strategyHooks = modelContext === undefined
        ? undefined
        : createStrategyHooks(modelContext as MemoryContextBase, store)
      const result = await distillModel(modelContext ?? {}, store, undefined, strategyHooks)
      if (result === undefined) {
        sendJson(res, 200, { ok: false, error: '暂时不足以提炼模型，或提炼失败' })
        return
      }
      const { item, strategy, rule } = result
      events.publish({ type: 'memory:added', item })
      if (strategy !== undefined) events.publish({ type: 'memory:added', item: strategy })
      if (rule !== undefined) events.publish({ type: 'memory:added', item: rule })
      appendAudit('memory.model.distill', {
        id: item.id,
        ...(strategy === undefined ? {} : { strategy: strategy.id }),
        ...(rule === undefined ? {} : { rule: rule.id }),
      })
      sendJson(res, 200, {
        ok: true,
        item,
        ...(strategy === undefined ? {} : { strategy }),
        ...(rule === undefined ? {} : { rule }),
      })
      return
    }

    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/approve`) {
      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id === '') {
        sendJson(res, 400, { ok: false, error: 'id is required' })
        return
      }
      const item = await store.approve(id)
      if (item === undefined) {
        sendJson(res, 404, { ok: false, error: 'memory not found' })
        return
      }
      events.publish({ type: 'memory:updated', item })
      appendAudit('memory.approve', { id })
      sendJson(res, 200, { ok: true, id, item })
      return
    }

    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/resolution`) {
      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id === '' || typeof body.resolution !== 'string') {
        sendJson(res, 400, { ok: false, error: 'id and resolution are required' })
        return
      }
      const item = await store.setResolution(id, body.resolution)
      if (item === undefined) {
        sendJson(res, 404, { ok: false, error: 'memory not found' })
        return
      }
      events.publish({ type: 'memory:updated', item })
      appendAudit('memory.resolution', { id })
      sendJson(res, 200, { ok: true, id, item })
      return
    }

    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/human-decision`) {
      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      if (reviewEngine === undefined) {
        sendJson(res, 503, { ok: false, error: 'review engine unavailable' })
        return
      }
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const decision = body.decision === 'adopt' || body.decision === 'discard' ? body.decision : undefined
      if (id === '' || decision === undefined) {
        sendJson(res, 400, { ok: false, error: 'id and decision (adopt|discard) are required' })
        return
      }
      const item = await reviewEngine.humanDecide(id, decision)
      if (item === undefined) {
        sendJson(res, 404, { ok: false, error: 'memory not found or not awaiting human intervention' })
        return
      }
      appendAudit('memory.human-decision', { id, decision })
      sendJson(res, 200, { ok: true, id, decision, item })
      return
    }

    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/arbitrate`) {
      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      if (reviewEngine === undefined) {
        sendJson(res, 503, { ok: false, error: 'review engine unavailable' })
        return
      }
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id === '') {
        sendJson(res, 400, { ok: false, error: 'id is required' })
        return
      }
      const item = await reviewEngine.arbitrateWithEvidence(id)
      if (item === undefined) {
        sendJson(res, 404, { ok: false, error: 'memory not found' })
        return
      }
      appendAudit('memory.arbitrate', { id })
      sendJson(res, 200, { ok: true, id, item })
      return
    }

    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/dma-run`) {
      if (dmaRunner === undefined) {
        sendJson(res, 503, { ok: false, error: 'DMA runner unavailable' })
        return
      }
      const discipline = url.searchParams.get('discipline') ?? undefined
      const items = await dmaRunner.runNow(discipline)
      if (items.length === 0) {
        sendJson(res, 409, {
          ok: false,
          error: dmaRunner.lastError || 'DMA run in progress or produced no speculative memory',
        })
        return
      }
      appendAudit('dma.run', {
        discipline: discipline ?? 'auto',
        insights: items.length,
      })
      sendJson(res, 200, { ok: true, items, item: items[0] })
      return
    }

    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/delete`) {
      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id === '') {
        sendJson(res, 400, { ok: false, error: 'id is required' })
        return
      }
      const deleted = await store.delete(id)
      if (deleted) events.publish({ type: 'memory:removed', id })
      appendAudit('memory.delete', { id, deleted })
      sendJson(res, 200, { ok: true, id, deleted })
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    sendJson(res, 500, { ok: false, error: message })
  }
}

/** 在 webServer 可用时注册路由；不可用时静默跳过。 */
export function registerMemoryApi(
  ctx: MemoryApiContext,
  store: MemoryStore,
  events: MemoryEventHub,
  reviewEngine?: SkillReviewEngine,
  dmaRunner?: DmaRunner,
): void {
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['webServer'], webCtx => {
      try {
        ctx.effect(() => {
          const disposeRoute = webCtx.webServer.register({
            kind: 'prefix',
            path: PREFIX,
            handler: (req, res) => handleMemoryApi(req, res, store, events, reviewEngine, dmaRunner, ctx),
          })
          return () => {
            disposeRoute()
            events.close()
          }
        })
      } catch (error) {
        console.error('[dsh-evolution-flywheel] memory API registration failed:', error)
      }
    })
  } catch (error) {
    console.error('[dsh-evolution-flywheel] memory API injection failed:', error)
  }
}

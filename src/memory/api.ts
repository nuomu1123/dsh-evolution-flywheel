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
import { dailyBudget, readBudget } from './budget.js'
import { memoryConfig } from './config.js'
import type { DmaRunner } from './dma.js'
import type { MemoryEventHub } from './events.js'
import { listSecurityIntercepts } from './sanitize.js'
import { summarizeUsage } from './usage.js'
import type { SkillReviewEngine } from './state-machine.js'
import { createStrategyHooks } from './strategy.js'
import type { MemoryContextBase } from './context.js'
import { archiveIdsOf, buildProbeEvidence, contentSimilarity, parseCurationPayload, similarErrorGroups, summarizeCurationQuality, summarizeCurationWithLlm } from './curator.js'
import { buildSelfDiagnosis, isStuckReview } from './diagnosis.js'
import { extractJson } from './dma.js'
import { runCurationCluster } from './curation-cluster.js'
import { complete } from './review-driver.js'
import { answerProbe, createProbe, ignoreProbe, markProbeSearching } from './probes.js'
import type { MemoryStore } from './store.js'
import { distillModel } from './model-distill.js'

const PREFIX = '/memory-explorer'
const MAX_BODY_BYTES = 16 * 1024

/**
 * 「机械失败」判定：这些 human_intervention 不是需要人判断，而是模型容量/瞬时故障。
 * 批量重试只碰这些；正常的人工裁决记录不会被动。
 * 2026-10-25 实测来源：思考型模型把 maxTokens 全花在 reasoning 上、流式连接中断。
 */
// 诊断口径统一放在 diagnosis.ts；这里 re-export 保持既有导入路径不变。
export { STUCK_REVIEW_REASON, isStuckReview } from './diagnosis.js'



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

    if (req.method === 'GET' && url.pathname === `${PREFIX}/api/curation/latest`) {
      const items = await store.list()
      const report = items
        .filter(item => item.type === 'curation_report')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      if (report === undefined) {
        sendJson(res, 200, { ok: false, error: '还没有整理报告，先运行一次整理' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        report,
        payload: parseCurationPayload(report.reportJson),
        quality: summarizeCurationQuality(items),
      })
      return
    }

    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/curation/run`) {
      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      const items = await store.list()
      const payload = await runCurationCluster(items, Date.now(), 'manual')
      const llm = modelContext === undefined
        ? undefined
        : await summarizeCurationWithLlm(modelContext as MemoryContextBase, store, payload)
      if (llm !== undefined) payload.llmSummary = llm.text
      // 整理时刻顺手提一个真问题：主动探针的零额外唤醒入口。
      const probe = llm?.probe === undefined
        ? undefined
        : await createProbe(store, {
          question: llm.probe.question,
          reason: llm.probe.reason,
          source: 'curation',
          context: buildProbeEvidence(payload, items),
        })
      const created = await store.appendSuggested(`整理报告：${payload.summary}`, 'curation_report')
      if (created === undefined) {
        sendJson(res, 409, { ok: false, error: '报告创建失败或同名报告已存在' })
        return
      }
      const updated = await store.update(created.id, {
        reportJson: JSON.stringify(payload),
        ...(llm === undefined ? {} : { reviewTokens: llm.tokensUsed }),
        origin: 'curation',
        originDetail: '规则整理（待人类裁决）',
        trace: [
          payload.summary,
          ...(llm === undefined ? [] : ['AI 审查摘要已生成']),
          ...payload.risks,
        ].slice(0, 10),
      })
      const report = updated ?? created
      events.publish({ type: 'memory:added', item: report })
      appendAudit('memory.curation.run', { id: report.id, trigger: 'manual' })
      sendJson(res, 200, {
        ok: true,
        report,
        payload,
        ...(probe === undefined ? {} : { probeId: probe.id }),
        ...(llm?.error === undefined ? {} : { llmError: llm.error }),
      })
      return
    }

    // 探针追问：让「一句话提问」变成「可持续对话」。
    // 人类追问才触发一次模型调用——不追问就不花钱，追问说明他在意。
    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/probe/followup`) {
      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const question = typeof body.question === 'string' ? body.question.trim().slice(0, 1000) : ''
      if (id === '' || question === '') {
        sendJson(res, 400, { ok: false, error: 'id and question are required' })
        return
      }
      if (modelContext === undefined) {
        sendJson(res, 503, { ok: false, error: 'LLM 上下文不可用，无法回答追问' })
        return
      }
      const items = await store.list()
      const probe = items.find(item => item.id === id && item.type === 'cognitive_probe')
      if (probe === undefined) {
        sendJson(res, 404, { ok: false, error: 'probe not found' })
        return
      }
      let thread: Array<{ role: string; text: string; at: string }> = []
      try {
        const parsed: unknown = JSON.parse(probe.probeThread ?? '[]')
        if (Array.isArray(parsed)) {
          thread = parsed.filter(entry => typeof entry === 'object' && entry !== null) as Array<{ role: string; text: string; at: string }>
        }
      } catch {
        thread = []
      }
      let answer = ''
      try {
        const completion = await complete(
          modelContext as MemoryContextBase,
          '你在和人类就一条记忆整理探针对话。只依据给出的证据回答；证据不足就直说不知道，不要编造。中文，200 字以内。',
          [
            `原始问题：${probe.content}`,
            `提问原因：${probe.probeReason ?? '（未提供）'}`,
            `证据包：${(probe.probeContext ?? '（无证据）').slice(0, 3000)}`,
            '',
            ...(thread.length === 0
              ? []
              : ['已有对话：', ...thread.slice(-10).map(item => `${item.role === 'user' ? '人类' : '我'}：${item.text}`), '']),
            `人类追问：${question}`,
          ].join('\n'),
          900,
        )
        answer = completion.text.trim() === '' ? '（模型没有返回内容）' : completion.text.trim()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendJson(res, 502, { ok: false, error: `追问失败：${message}` })
        return
      }
      const at = new Date().toISOString()
      const nextThread = [
        ...thread,
        { role: 'user', text: question, at },
        { role: 'assistant', text: answer, at },
      ].slice(-20)
      const updated = await store.update(probe.id, { probeThread: JSON.stringify(nextThread) })
      if (updated !== undefined) events.publish({ type: 'memory:updated', item: updated })
      appendAudit('memory.probe.followup', { id: probe.id, questionChars: question.length })
      sendJson(res, 200, { ok: true, answer, thread: nextThread })
      return
    }

    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/curation/decision`) {
      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const decision = body.decision === 'approve' || body.decision === 'reject' ? body.decision : undefined
      const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
      if (id === '' || decision === undefined) {
        sendJson(res, 400, { ok: false, error: 'id and decision (approve|reject) are required' })
        return
      }
      // 否决必须给出理由：强制思考，避免拍脑袋丢弃。
      if (decision === 'reject' && [...reason].length < 10) {
        sendJson(res, 400, { ok: false, error: '否决整理报告必须给出至少 10 个字的理由' })
        return
      }
      const items = await store.list()
      const report = items.find(item => item.id === id && item.type === 'curation_report')
      if (report === undefined) {
        sendJson(res, 404, { ok: false, error: 'curation report not found' })
        return
      }
      const payload = parseCurationPayload(report.reportJson)
      const updated = await store.update(id, {
        status: decision === 'approve' ? 'approved' : 'rejected',
        humanDecision: decision === 'approve' ? 'adopt' : 'discard',
        trace: [
          ...(report.trace ?? []),
          `人类裁决：${decision === 'approve' ? '批准' : '否决'}${reason === '' ? '' : `；理由：${reason}`}`,
        ].slice(-10),
      })
      if (updated !== undefined) events.publish({ type: 'memory:updated', item: updated })
      let archived = 0
      if (decision === 'approve' && payload !== undefined) {
        for (const archiveId of archiveIdsOf(payload)) {
          const archivedItem = await store.update(archiveId, { archived: true })
          if (archivedItem !== undefined) {
            archived += 1
            events.publish({ type: 'memory:updated', item: archivedItem })
          }
        }
      }
      if (decision === 'reject') {
        const negative = await store.appendSuggested(`[整理否决] ${reason}`, 'fact')
        if (negative !== undefined) {
          await store.update(negative.id, {
            status: 'approved',
            origin: 'curation',
            originDetail: '整理否决理由（负样本）',
          })
        }
      }
      appendAudit('memory.curation.decision', { id, decision, reason, archived })
      sendJson(res, 200, { ok: true, report: updated ?? report, archived })
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

    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/reject`) {
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
      const item = await store.update(id, { status: 'rejected' })
      if (item === undefined) {
        sendJson(res, 404, { ok: false, error: 'memory not found' })
        return
      }
      events.publish({ type: 'memory:updated', item })
      appendAudit('memory.reject', { id })
      sendJson(res, 200, { ok: true, id, item })
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

    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/probe/answer`) {
      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const answer = typeof body.answer === 'string' ? body.answer : ''
      if (id === '' || answer.trim() === '') {
        sendJson(res, 400, { ok: false, error: 'id and a non-empty answer are required' })
        return
      }
      const item = await answerProbe(store, id, answer)
      if (item === undefined) {
        sendJson(res, 404, { ok: false, error: 'probe not found' })
        return
      }
      events.publish({ type: 'memory:updated', item })
      appendAudit('memory.probe.answer', { id })
      sendJson(res, 200, { ok: true, item })
      return
    }

    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/probe/ignore`) {
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
      const item = await ignoreProbe(store, id)
      if (item === undefined) {
        sendJson(res, 404, { ok: false, error: 'probe not found' })
        return
      }
      events.publish({ type: 'memory:updated', item })
      appendAudit('memory.probe.ignore', { id })
      sendJson(res, 200, { ok: true, item })
      return
    }

    // 「去查吧」：真正去回答这个问题，而不是跑一次无关的学科漫游。
    // 验收铁律：结论必须带来源 id；证据不足必须说没找到；结果写回对话线程供人复核。
    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/probe/dma`) {
      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      if (modelContext === undefined) {
        sendJson(res, 503, { ok: false, error: 'LLM 上下文不可用，无法检索' })
        return
      }
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id === '') {
        sendJson(res, 400, { ok: false, error: 'id is required' })
        return
      }
      const all = await store.list()
      const probe = all.find(item => item.id === id && item.type === 'cognitive_probe')
      if (probe === undefined) {
        sendJson(res, 404, { ok: false, error: 'probe not found' })
        return
      }

      // 1. 定向检索：用探针问题去记忆库里找相关条目（不是随机学科漫游）。
      const query = `${probe.content} ${probe.probeReason ?? ''}`
      const related = all
        .filter(item => item.id !== probe.id && item.archived !== true && item.content.trim() !== '')
        .map(item => ({
          item,
          score: contentSimilarity(query, `${item.content} ${item.errorSignature ?? ''} ${item.context ?? ''}`),
        }))
        .filter(entry => entry.score > 0.02)
        .sort((left, right) => right.score - left.score)
        .slice(0, 8)
        .map(entry => entry.item)
      const corpus = related.length === 0
        ? '（记忆库里没有相关条目）'
        : related
          .map(item => `- ${item.id} [${item.type}] ${(item.errorSignature ?? item.content).replace(/\s+/gu, ' ').slice(0, 160)}`)
          .join('\n')

      let verdict = 'not-found'
      let conclusion = ''
      let sources: string[] = []
      let confidence = 'low'
      let gaps: string[] = []
      try {
        const completion = await complete(
          modelContext as MemoryContextBase,
          '你是记忆检索助手，用记忆库回答一个探针问题。铁律：每条结论必须带来源 id；证据不足就说没找到，绝不编造。',
          [
            `探针问题：${probe.content}`,
            `提问原因：${probe.probeReason ?? '（未提供）'}`,
            `探针证据包：${(probe.probeContext ?? '（无）').slice(0, 2000)}`,
            '',
            '记忆库中检索到的相关条目：',
            corpus,
            '',
            '只输出 JSON，不要代码块：',
            '{"verdict":"answered|partial|not-found","conclusion":"200字内结论","sources":["mem-xxx"],"confidence":"high|medium|low","gaps":["还缺什么"]}',
          ].join('\n'),
          8000,
        )
        const parsed = extractJson(completion.text)
        if (typeof parsed.verdict === 'string') verdict = parsed.verdict
        if (typeof parsed.conclusion === 'string') conclusion = parsed.conclusion
        if (Array.isArray(parsed.sources)) sources = parsed.sources.filter((s): s is string => typeof s === 'string')
        if (typeof parsed.confidence === 'string') confidence = parsed.confidence
        if (Array.isArray(parsed.gaps)) gaps = parsed.gaps.filter((g): g is string => typeof g === 'string')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendJson(res, 502, { ok: false, error: `检索失败：${message}` })
        return
      }

      // 2. 验收结果写回对话线程：人能直接看到「查到了什么、依据哪几条、还缺什么」。
      const at = new Date().toISOString()
      let thread: Array<{ role: string; text: string; at: string }> = []
      try {
        const parsedThread: unknown = JSON.parse(probe.probeThread ?? '[]')
        if (Array.isArray(parsedThread)) thread = parsedThread as Array<{ role: string; text: string; at: string }>
      } catch {
        thread = []
      }
      const verdictLabel = verdict === 'answered' ? '已找到答案' : verdict === 'partial' ? '部分回答' : '未找到'
      const summary = [
        `【自主检索】${verdictLabel} · 置信度 ${confidence}`,
        conclusion,
        sources.length === 0 ? '来源：无（未引用任何记忆）' : `来源：${sources.join('、')}`,
        gaps.length === 0 ? '' : `仍缺：${gaps.join('；')}`,
      ].filter(line => line !== '').join('\n')
      const nextThread = [...thread, { role: 'assistant', text: summary, at }].slice(-20)
      const updated = await store.update(probe.id, {
        probeState: 'open',
        probeThread: JSON.stringify(nextThread),
        trace: [...(probe.trace ?? []), `自主检索：${verdict}（${sources.length} 个来源）`].slice(-10),
      })
      if (updated !== undefined) events.publish({ type: 'memory:updated', item: updated })
      appendAudit('memory.probe.search', { id: probe.id, verdict, sources: sources.length })
      sendJson(res, 200, { ok: true, verdict, conclusion, sources, confidence, gaps, thread: nextThread, probe: updated })
      return
    }

    // 批量重试：把「因模型容量/瞬时错误卡在 human_intervention」的记录重置并重跑初审。
    // 2026-10-25 真实使用反馈：24/119 条是这样堆积出来的（review/debate 的 maxTokens 太小，
    // 思考型模型把额度全花在 reasoning 上）。这些不是"需要人判断"的问题，是机械失败。
    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/review/retry`) {
      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      if (reviewEngine === undefined) {
        sendJson(res, 503, { ok: false, error: '审阅引擎不可用，无法批量重试' })
        return
      }
      const body = await readJsonBody(req)
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
        : []
      const requestedLimit = typeof body.limit === 'number' && Number.isFinite(body.limit)
        ? Math.trunc(body.limit)
        : 20
      const limit = Math.max(1, Math.min(50, requestedLimit))
      const items = await store.list()
      const candidates = items
        .filter(isStuckReview)
        .filter(item => ids.length === 0 || ids.includes(item.id))
        .slice(0, limit)

      const details: Array<{ id: string; result: string }> = []
      let succeeded = 0
      let halted = ''
      for (const item of candidates) {
        const budget = await readBudget(store)
        if (budget.exceeded) {
          halted = '每日 token 预算已用完，批量重试中断'
          break
        }
        // review() 对终态直接返回，所以必须先重置为 staged 才会真正重跑。
        await store.update(item.id, { status: 'staged', debateSummary: '批量重试：已重置为待审' })
        try {
          const reviewed = await reviewEngine.review(item.id)
          const status = reviewed?.status ?? 'undefined'
          if (status === 'approved' || status === 'rejected') succeeded += 1
          details.push({ id: item.id, result: status })
        } catch (error) {
          details.push({ id: item.id, result: `error: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
      appendAudit('memory.review.retry', { candidates: candidates.length, succeeded, halted })
      sendJson(res, 200, {
        ok: true,
        candidates: candidates.length,
        succeeded,
        ...(halted === '' ? {} : { halted }),
        details,
      })
      return
    }

    // 自诊断：把「哪里疼」聚合成一份可直接读的报告（不读文件、不调模型）。
    if (req.method === 'GET' && url.pathname === `${PREFIX}/api/self-diagnosis`) {
      const items = await store.list()
      sendJson(res, 200, { ok: true, diagnosis: buildSelfDiagnosis(items) })
      return
    }

    // 相似错误聚类（只读）：把「同一种错误、不同文件」聚成一组供人决定是否合并。
    // 2026-10-25 反馈 P1-1：ReplaceFileW EIO 因路径不同被拆成 3 条，用户视角是同一个问题。
    if (req.method === 'GET' && url.pathname === `${PREFIX}/api/similar-errors`) {
      const items = await store.list()
      sendJson(res, 200, { ok: true, groups: similarErrorGroups(items) })
      return
    }

    // 合并：把 mergeIds 标为已归档并在 trace 里指向保留项；不物理删除，可恢复。
    if (req.method === 'POST' && url.pathname === `${PREFIX}/api/merge-errors`) {
      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      const body = await readJsonBody(req)
      const keepId = typeof body.keepId === 'string' ? body.keepId.trim() : ''
      const mergeIds = Array.isArray(body.mergeIds)
        ? body.mergeIds.filter((value): value is string => typeof value === 'string' && value.trim() !== '' && value !== keepId)
        : []
      if (keepId === '' || mergeIds.length === 0) {
        sendJson(res, 400, { ok: false, error: 'keepId and mergeIds are required' })
        return
      }
      const items = await store.list()
      if (!items.some(item => item.id === keepId)) {
        sendJson(res, 404, { ok: false, error: 'keepId not found' })
        return
      }
      const merged: string[] = []
      for (const id of mergeIds) {
        const target = items.find(item => item.id === id)
        if (target === undefined || target.archived === true) continue
        const updated = await store.update(id, {
          archived: true,
          trace: [...(target.trace ?? []), `已合并到 ${keepId}（相似错误归并）`].slice(-10),
        })
        if (updated !== undefined) {
          merged.push(id)
          events.publish({ type: 'memory:updated', item: updated })
        }
      }
      appendAudit('memory.merge.similar', { keepId, merged: merged.length })
      sendJson(res, 200, { ok: true, keepId, merged })
      return
    }

    if (req.method === 'GET' && url.pathname === `${PREFIX}/api/probe/brief/latest`) {
      const items = await store.list()
      const brief = items
        .filter(item => item.type === 'cognitive_brief')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      sendJson(res, 200, {
        ok: brief !== undefined,
        brief: brief ?? null,
        probes: items.filter(item => item.type === 'cognitive_probe'),
      })
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

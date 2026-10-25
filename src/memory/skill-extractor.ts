/**
 * 错误感知与经验沉淀：
 * - 监听 tool/result 失败与 agent/error；
 * - 结构化提取 error_signature / context / resolution；
 * - 5 分钟同 fingerprint 防抖；
 * - 写入 MemoryStore，广播 memory:added / memory:updated。
 */
import { createHash } from 'node:crypto'
import type { MemoryContextBase } from './context.js'
import type { MemoryEventHub } from './events.js'
import { sanitizeText } from './sanitize.js'
import { redactArgs, redactText } from './redact.js'

const sanitize = (value: unknown, maxLength = 1000): string =>
  sanitizeText(value, maxLength, '错误捕获')
import type { MemoryRecord, MemoryStore, SkillErrorInput } from './store.js'

const FIVE_MINUTES = 5 * 60 * 1000

export interface SkillCandidate extends SkillErrorInput {}

export interface SkillDebouncer {
  allow(fingerprint: string, now?: number): boolean
}

/** 进程内防抖；跨重启的持久防抖由 MemoryStore.lastSeenAt 兜底。 */
export class FixedWindowSkillDebouncer implements SkillDebouncer {
  private readonly last = new Map<string, number>()

  constructor(private readonly windowMs: number = FIVE_MINUTES) {}

  allow(fingerprint: string, now: number = Date.now()): boolean {
    const previous = this.last.get(fingerprint)
    if (previous !== undefined && now - previous < this.windowMs) return false
    this.last.set(fingerprint, now)
    if (this.last.size > 1000) {
      const oldest = this.last.keys().next().value
      if (oldest !== undefined) this.last.delete(oldest)
    }
    return true
  }
}

function errorParts(error: unknown): { name: string; message: string; stack: string } {
  if (error instanceof Error) {
    return { name: error.name || 'Error', message: error.message || String(error), stack: error.stack ?? '' }
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    return {
      name: typeof record.name === 'string' ? record.name : 'Error',
      message: typeof record.message === 'string' ? record.message : JSON.stringify(record),
      stack: typeof record.stack === 'string' ? record.stack : '',
    }
  }
  return { name: 'Error', message: String(error), stack: '' }
}

function keyStackLines(stack: string): string[] {
  return stack
    .split('\n')
    .filter(line => line.trim().startsWith('at '))
    .slice(0, 3)
    .map(line => line.replace(/\\/g, '/').replace(/([A-Za-z]:)?\/[^/\s]+(?=\/)/g, '/'))
}

/**
 * 从任意错误构造结构化候选记忆。
 * @param input 原始错误、任务上下文，以及已知的解决办法。
 * @returns 可直接写入 MemoryStore 的候选。
 */
export function buildSkillCandidate(input: {
  error: unknown
  context: string
  resolution?: string
}): SkillCandidate {
  const parts = errorParts(input.error)
  const stackKey = keyStackLines(parts.stack)
  // 错误消息与上下文都可能夹带 URL token / API Key / 邮箱，落盘前统一脱敏。
  const signature = redactText(
    `${parts.name}: ${parts.message.split('\n')[0]?.trim() ?? parts.message}`,
    300,
  )
  const fingerprint = createHash('sha256')
    .update([parts.name, parts.message, ...stackKey].join('\n'))
    .digest('hex')
  return {
    errorSignature: signature,
    fingerprint,
    context: redactText(input.context.trim(), 500) || '未记录任务上下文',
    ...(input.resolution !== undefined && input.resolution.trim() !== ''
      ? { resolution: input.resolution.trim().slice(0, 1000) }
      : {}),
  }
}

interface SessionEventLike {
  type?: string
  data?: {
    callId?: string
    name?: string
    arguments?: string
    turn?: number
    step?: number
    message?: {
      toolCallId?: string
      isError?: boolean
      content?: Array<{ type?: string; text?: string }>
    }
    error?: { name?: string; code?: string; reason?: string }
  }
}

interface AgentErrorLike {
  agent?: { id?: string }
  turn?: number
  step?: number
  error?: unknown
}

interface PendingSkill {
  fingerprint: string
  at: number
}

export interface SkillExtractionContext extends MemoryContextBase {}

function contentText(message: { content?: Array<{ type?: string; text?: string }> } | undefined): string {
  return (message?.content ?? [])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
    .trim()
}

/** 从工具输出中挑一条最有诊断价值的行，避免把 [stderr] 当成错误标题。 */
function diagnosticLine(text: string): string {
  const lines = text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '' && !/^\[(stderr|stdout)\]$/u.test(line))
  const preferred = lines.find(line =>
    /(Cannot find|not found|No module named|ModuleNotFoundError|Traceback|Exception|TypeError|ReferenceError|failed|Failed|PathNotFound|exit code)/u.test(line))
  return (preferred ?? lines[0] ?? 'tool failed').slice(0, 300)
}

function sessionId(session: unknown): string {
  if (typeof session === 'object' && session !== null && typeof (session as { id?: unknown }).id === 'string') {
    return (session as { id: string }).id
  }
  return 'unknown'
}

interface LlmLike {
  listProviders(): Array<{ id?: string }>
  listModels(provider: string): Promise<Array<{ id?: string }>>
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
}

function llmOf(ctx: SkillExtractionContext): LlmLike | undefined {
  try {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (typeof llm !== 'object' || llm === null) return undefined
    const candidate = llm as Partial<LlmLike>
    if (typeof candidate.listProviders !== 'function'
      || typeof candidate.listModels !== 'function'
      || typeof candidate.stream !== 'function') return undefined
    return candidate as LlmLike
  } catch {
    return undefined
  }
}

/**
 * 用 DSH 内部 LLM 生成一条简短解决办法草稿。
 * 失败、无 provider 或无输出时返回 undefined，错误捕获继续落库。
 */
async function generateResolution(ctx: SkillExtractionContext, candidate: SkillCandidate): Promise<string | undefined> {
  const llm = llmOf(ctx)
  if (llm === undefined) return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const providers = await llm.listProviders()
    const provider = providers.find(item => typeof item.id === 'string' && item.id !== '')?.id
    if (provider === undefined) return undefined
    const models = await llm.listModels(provider)
    const model = models.find(item => typeof item.id === 'string' && item.id !== '')?.id
    if (model === undefined) return undefined

    const prompt = [
      `错误：${candidate.errorSignature}`,
      `任务上下文：${candidate.context}`,
      '请给出最可能、可执行的解决办法。只输出中文步骤，最多 3 句，不要复述错误，不要编造未验证的路径或命令。',
    ].join('\n')
    let text = ''
    for await (const chunk of llm.stream({
      provider,
      model,
      system: '你是软件故障排查助手。只输出简短、可执行的修复建议。',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 180,
      temperature: 0.2,
      signal: controller.signal,
    })) {
      if (typeof chunk === 'object' && chunk !== null) {
        const record = chunk as { type?: string; text?: string }
        if (record.type === 'text-delta' && typeof record.text === 'string') text += record.text
      }
      if (text.length > 1000) break
    }
    return text.trim().slice(0, 1000) || undefined
  } catch (error) {
    if ((error as { name?: string })?.name !== 'AbortError') {
      console.error('[dsh-evolution-flywheel] resolution generation failed:', error)
    }
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 注册错误监听。防抖分两层：
 * 1. FixedWindowSkillDebouncer 在进程内拦截 5 分钟内的重复 fingerprint；
 * 2. MemoryStore.captureSkillError 再按持久化 lastSeenAt 做一次 5 分钟检查，
 *    保证重启后同一个错误不会立刻重复刷屏。
 */
export function registerSkillExtraction(
  ctx: SkillExtractionContext,
  store: MemoryStore,
  events: MemoryEventHub,
  onCaptured?: (record: MemoryRecord) => void | Promise<void>,
): void {
  const debouncer = new FixedWindowSkillDebouncer(FIVE_MINUTES)
  const calls = new Map<string, Map<string, { name: string; args: string }>>()
  const pending = new Map<string, PendingSkill[]>()
  const FIX_HINT = /(修复|解决|改用|原因是|请安装|需要安装|替代|workaround|fix|resolved)/iu

  const capture = async (candidate: SkillCandidate, scopeId: string): Promise<void> => {
    if (!debouncer.allow(candidate.fingerprint)) return
    const safeCandidate: SkillCandidate = {
      ...candidate,
      errorSignature: sanitize(candidate.errorSignature, 300),
      context: sanitize(candidate.context, 500),
      ...(candidate.resolution !== undefined
        ? { resolution: sanitize(candidate.resolution, 1000) }
        : {}),
    }
    const resolution = await generateResolution(ctx, safeCandidate)
    const result = await store.captureSkillError(
      resolution === undefined ? safeCandidate : { ...safeCandidate, resolution },
    )
    if (result === undefined) return
    events.publish({ type: result.created ? 'memory:added' : 'memory:updated', item: result.item })
    if (result.item.resolution === undefined) {
      const queue = pending.get(scopeId) ?? []
      queue.push({ fingerprint: candidate.fingerprint, at: Date.now() })
      pending.set(scopeId, queue.slice(-20))
    }
    if (result.created && onCaptured !== undefined) {
      void Promise.resolve(onCaptured(result.item)).catch(error => {
        console.error('[dsh-evolution-flywheel] captured skill review failed:', error)
      })
    }
  }

  const onSessionEvent = (session: unknown, event: SessionEventLike): void => {
    try {
      const id = sessionId(session)
      const data = event.data
      if (event.type === 'tool/call' && data?.callId !== undefined && data.name !== undefined) {
        const bySession = calls.get(id) ?? new Map()
        bySession.set(data.callId, { name: data.name, args: data.arguments ?? '' })
        while (bySession.size > 200) {
          const oldest = bySession.keys().next().value
          if (oldest === undefined) break
          bySession.delete(oldest)
        }
        calls.set(id, bySession)
        return
      }

      if (event.type === 'tool/result') {
        const message = data?.message
        const messageText = contentText(message)
        // 跨插件兼容：compaction-tool-result-pruner 在上下文压缩时会 append 一个新的
        // tool/result（内容被 head/tail 截断，中间替换为 PRUNE_MARKER）。
        // 它不是一次新的失败，而是一次已记录失败的"剪枝版"；
        // 若不当成重复处理，同一错误会被记成截断版第二条（fingerprint 不同，去重挡不住）。
        if (messageText.includes('[... tool result middle pruned ...]')) return
        const failedByContent = /\[exit code:\s*[1-9]\d*\]|(?:^|\n)\s*(?:Error|error|Cannot find|Exception|Traceback|ModuleNotFoundError|TypeError|ReferenceError)\b/u.test(messageText)
        if (message?.isError !== true && data?.error === undefined && !failedByContent) return
        const callId = message?.toolCallId ?? data?.callId
        const bySession = calls.get(id)
        const call = callId === undefined ? undefined : bySession?.get(callId)
        if (callId !== undefined) bySession?.delete(callId)
        const errorName = data?.error?.name ?? 'ToolError'
        const errorText = data?.error?.reason?.trim() || diagnosticLine(messageText)
        const candidate = buildSkillCandidate({
          error: { name: errorName, message: errorText, stack: messageText },
          context: call === undefined ? '工具调用失败' : `工具 ${call.name} 执行失败；参数摘要：${redactArgs(call.args, 200)}`,
        })
        void capture(candidate, id).catch(error => {
          console.error('[dsh-evolution-flywheel] skill capture failed:', error)
        })
        return
      }

      if (event.type === 'assistant/message') {
        const text = contentText(data?.message)
        if (text === '' || !FIX_HINT.test(text)) return
        // resolution 只该是「怎么解决的」一句话，不是整篇汇报。
        // 2026-10-24 实测：一条长的交付汇报只因为含「修复」二字，就把 1500 字全文写进了
        // 最近一次失败记忆的 resolution，面板直接变成汇报正文。这里加两道闸：
        //   1) 长度上限；2) 多个 Markdown 标题视为报告而非排错说明。
        if (text.length > 600) return
        const headingCount = (text.match(/^#{1,3} /gmu) ?? []).length
        if (headingCount >= 2) return
        const queue = pending.get(id)
        if (queue === undefined || queue.length === 0) return
        const latest = queue.at(-1)
        if (latest === undefined || Date.now() - latest.at > FIVE_MINUTES) return
        const remaining = queue.slice(0, -1)
        if (remaining.length === 0) pending.delete(id)
        else pending.set(id, remaining)
        void store.attachResolution(latest.fingerprint, text)
          .then(item => {
            if (item !== undefined) events.publish({ type: 'memory:updated', item })
          })
          .catch(error => {
            console.error('[dsh-evolution-flywheel] attach resolution failed:', error)
          })
      }
    } catch (error) {
      console.error('[dsh-evolution-flywheel] skill extraction handler failed:', error)
    }
  }

  const onAgentError = (payload: AgentErrorLike): void => {
    try {
      const candidate = buildSkillCandidate({
        error: payload.error,
        context: `Agent 执行失败（turn ${payload.turn ?? '?'}, step ${payload.step ?? '?'}）`,
      })
      void capture(candidate, payload.agent?.id ?? 'agent').catch(error => {
        console.error('[dsh-evolution-flywheel] agent error capture failed:', error)
      })
    } catch (error) {
      console.error('[dsh-evolution-flywheel] agent error handler failed:', error)
    }
  }

  try {
    ctx.effect(() => ctx.on('session/event', onSessionEvent))
    ctx.effect(() => ctx.on('agent/error', onAgentError))
  } catch (error) {
    console.error('[dsh-evolution-flywheel] skill extraction registration failed:', error)
  }
}

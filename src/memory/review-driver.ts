/**
 * 生产环境的子母审阅驱动：调用 DSH 内部 ctx.llm。
 *
 * 初审与辩论共用同一个 provider/model，但每次调用 maxTokens 固定为 300。
 */
import type { MemoryContextBase } from './context.js'
import { memoryConfig } from './config.js'
import { clampMetaInsight, sanitizeText } from './sanitize.js'

const sanitize = (value: unknown, maxLength = 1000): string =>
  sanitizeText(value, maxLength, '审阅/辩论')
import type {
  DebateVerdict,
  EvidenceItem,
  ReviewVerdict,
  SkillReviewDriver,
} from './state-machine.js'
import type { DebateRound, MemoryRecord } from './store.js'

interface LlmLike {
  listProviders(): Array<{ id?: string }>
  listModels(provider: string): Promise<Array<{ id?: string }>>
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
}

function llmOf(ctx: MemoryContextBase): LlmLike {
  const value = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (typeof value !== 'object' || value === null) throw new Error('ctx.llm 不可用')
  const llm = value as Partial<LlmLike>
  if (typeof llm.listProviders !== 'function'
    || typeof llm.listModels !== 'function'
    || typeof llm.stream !== 'function') {
    throw new Error('ctx.llm 缺少审阅所需接口')
  }
  return llm as LlmLike
}

async function complete(
  ctx: MemoryContextBase,
  system: string,
  prompt: string,
  maxTokens = memoryConfig.reviewMaxTokens,
): Promise<{ text: string; tokensUsed: number }> {
  const llm = llmOf(ctx)
  const providers = await llm.listProviders()
  const provider = providers.find(item => typeof item.id === 'string' && item.id !== '')?.id
  if (provider === undefined) throw new Error('没有可用 LLM provider')
  const models = await llm.listModels(provider)
  const model = models.find(item => typeof item.id === 'string' && item.id !== '')?.id
  if (model === undefined) throw new Error('没有可用 LLM model')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    let text = ''
    let tokensUsed = 0
    for await (const chunk of llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      temperature: 0.1,
      signal: controller.signal,
    })) {
      if (typeof chunk === 'object' && chunk !== null) {
        const record = chunk as {
          type?: string
          text?: string
          usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number }
        }
        if (record.type === 'text-delta' && typeof record.text === 'string') text += record.text
        if (record.type === 'usage' && record.usage !== undefined) {
          tokensUsed = record.usage.totalTokens
            ?? (record.usage.inputTokens ?? 0) + (record.usage.outputTokens ?? 0)
        }
      }
      if (text.length > 4000) break
    }
    return { text: text.trim(), tokensUsed: Math.max(0, Math.trunc(tokensUsed)) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[dsh-memory-minimal] review LLM stream failed:', error)
    throw new Error(`审阅模型连接中断，已安全停止：${message}`)
  } finally {
    clearTimeout(timer)
  }
}

function parseJson(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```json/giu, '').replace(/```/gu, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('LLM 未返回 JSON')
  const value: unknown = JSON.parse(cleaned.slice(start, end + 1))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('LLM JSON 不是对象')
  return value as Record<string, unknown>
}

function textField(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? sanitize(value, maxLength) : ''
}

function debateRoundsOf(value: unknown): DebateRound[] {
  if (!Array.isArray(value)) return []
  const rounds: DebateRound[] = []
  for (const entry of value.slice(0, 6)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { role?: unknown; content?: unknown }
    const role = record.role === 'child' || record.role === 'mother' ? record.role : undefined
    if (role === undefined || typeof record.content !== 'string') continue
    const content = sanitize(record.content, 300)
    if (content !== '') rounds.push({ role, content })
  }
  return rounds
}

/** 创建调用 ctx.llm 的审阅驱动。 */
export function createLlmReviewDriver(ctx: MemoryContextBase): SkillReviewDriver {
  return {
    async review(record: MemoryRecord): Promise<ReviewVerdict> {
      const prompt = [
        '你是母 Agent，负责初审子 Agent 提交的排错经验。',
        `错误特征：${sanitize(record.errorSignature ?? '', 300)}`,
        `任务上下文：${sanitize(record.context ?? '', 500)}`,
        `候选解决办法：${sanitize(record.resolution ?? '', 1000) || '（空）'}`,
        '判断该经验是否安全、可执行、无虚构。只输出 JSON：',
        '{"decision":"approve"|"reject","reason":"不超过120字","resolution":"你建议的解决办法，不超过200字","meta_insight":"不超过100字"}',
      ].join('\n')
      const completion = await complete(
        ctx,
        '你是严格的技术审阅者。只输出 JSON，不要输出 Markdown。',
        prompt,
        memoryConfig.reviewMaxTokens,
      )
      const result = parseJson(completion.text)
      const decision = result.decision === 'approve' ? 'approve' : 'reject'
      const reason = textField(result.reason, 500) || '母 Agent 未给出理由'
      const meta = textField(result.meta_insight, 100)
      const resolution = textField(result.resolution, 1000)
      return {
        decision,
        reason,
        ...(resolution !== '' ? { resolution } : {}),
        ...(meta !== '' ? { metaInsight: clampMetaInsight(meta) } : {}),
        tokensUsed: completion.tokensUsed,
      }
    },

    async debate(record: MemoryRecord, review: ReviewVerdict): Promise<DebateVerdict> {
      const prompt = [
        '现在进行子母 Agent 的一轮对抗辩论。',
        `子 Agent 的错误特征：${sanitize(record.errorSignature ?? '', 300)}`,
        `子 Agent 的解决办法：${sanitize(record.resolution ?? '', 1000) || '（空）'}`,
        `母 Agent 的驳回理由：${sanitize(review.reason, 500)}`,
        `母 Agent 建议的解决办法：${sanitize(review.resolution ?? '', 1000) || '（空）'}`,
        '你同时扮演两个角色：子 Agent 只能依据自己的错误经验与已给证据反驳，不得编造新事实；母 Agent 负责安全与可复现性，必须针对子 Agent 的具体反驳回应，不得重复初审理由。',
        '请模拟一轮反驳与修正，并把双方发言写成 rounds。只输出 JSON：',
        '{"converged":true|false,"decision":"approve"|"reject"|"human_intervention","rounds":[{"role":"child","content":"子 Agent 的反驳，不超过100字"},{"role":"mother","content":"母 Agent 的回应，不超过100字"}],"challenge":"子 Agent 的反驳要点,不超过80字","meta_insight":"不超过80字","resolution":"最终解决办法，可留空","summary":"最终结论，不超过80字"}',
        'rounds 必须为 2-4 条，role 只能是 child 或 mother；无法形成确定结论时必须使用 human_intervention。',
      ].join('\n')
      const completion = await complete(
        ctx,
        '你是对抗辩论的主持者。只输出 JSON，不要输出 Markdown。',
        prompt,
        memoryConfig.debateMaxTokens,
      )
      const result = parseJson(completion.text)
      const decision = result.decision === 'approve' || result.decision === 'reject'
        ? result.decision
        : 'human_intervention'
      const converged = result.converged === true
      const meta = textField(result.meta_insight, 100)
      const resolution = textField(result.resolution, 1000)
      const challenge = textField(result.challenge, 300)
      const rounds = debateRoundsOf(result.rounds)
      return {
        converged,
        decision,
        ...(meta !== '' ? { metaInsight: clampMetaInsight(meta) } : {}),
        ...(resolution !== '' ? { resolution } : {}),
        ...(challenge !== '' ? { challenge } : {}),
        ...(rounds.length > 0 ? { rounds } : {}),
        summary: textField(result.summary, 400),
        tokensUsed: completion.tokensUsed,
      }
    },

    async appeal(
      record: MemoryRecord,
      review: ReviewVerdict,
      evidence: readonly EvidenceItem[],
    ): Promise<DebateVerdict> {
      const evidenceLines = evidence.slice(0, 3).map((item, index) =>
        `${index + 1}. ${sanitize(item.title, 120) || sanitize(item.url, 200)}\n${sanitize(item.snippet, 500)}`)
      const prompt = [
        '子 Agent 在辩论失败后进行了场外检索，现提交最多 3 条证据，向母 Agent 二次申诉。',
        `错误特征：${sanitize(record.errorSignature ?? '', 300)}`,
        `子 Agent 解决办法：${sanitize(record.resolution ?? '', 1000) || '（空）'}`,
        `母 Agent 原驳回理由：${sanitize(review.reason, 500)}`,
        '外部证据（已过滤注入指令）：',
        evidenceLines.join('\n') || '（无）',
        '请只根据证据判断是否认可子 Agent。只输出 JSON：',
        '{"converged":true|false,"decision":"approve"|"reject"|"human_intervention","meta_insight":"不超过100字","resolution":"最终解决办法，可留空","summary":"不超过200字"}',
        '如果证据不足以推翻驳回理由，必须使用 human_intervention，不要勉强认可。',
      ].join('\n')
      const completion = await complete(
        ctx,
        '你是严格的开卷辩论裁决者。只输出 JSON，不要输出 Markdown。',
        prompt,
        memoryConfig.reviewMaxTokens,
      )
      const result = parseJson(completion.text)
      const decision = result.decision === 'approve' || result.decision === 'reject'
        ? result.decision
        : 'human_intervention'
      const meta = textField(result.meta_insight, 100)
      const resolution = textField(result.resolution, 1000)
      return {
        converged: result.converged === true,
        decision,
        ...(meta !== '' ? { metaInsight: clampMetaInsight(meta) } : {}),
        ...(resolution !== '' ? { resolution } : {}),
        summary: textField(result.summary, 800),
        tokensUsed: completion.tokensUsed,
      }
    },
  }
}

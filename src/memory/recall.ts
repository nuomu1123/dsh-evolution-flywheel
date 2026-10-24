/**
 * 记忆召回：在 Agent 进入一步之前，检查用户消息是否命中已确认的
 * skill_error_fix；命中则把历史解决办法作为高权重上下文追加到本轮消息。
 *
 * 只读取 approved + 非空 resolution 的记忆；不修改任何其他插件。
 */
import { randomUUID } from 'node:crypto'
import type { MemoryContextBase } from './context.js'
import { isFaded, memorySalience, perceptionLabel } from './decay.js'
import { approvedRules, rankStrategies } from './strategy.js'
import type { MemoryRecord, MemoryStore } from './store.js'

interface MessageLike {
  id: string
  role: 'user'
  source: { kind: 'user' }
  content: Array<{ type: 'text'; text: string }>
}

interface PreStepDecisionLike {
  kind: 'reject' | 'enter'
  messages?: MessageLike[]
}

interface AgentPreStepPayload {
  agent?: object
  messages?: MessageLike[]
  turn?: number
  step?: number
}

export interface MemoryRecallContext extends MemoryContextBase {
  systemPrompt?: {
    context(definition: {
      name: string
      order: number
      interpolate?: boolean
      text: (context: { agent?: object }) => string
    }): () => void
  }
}

function textOf(messages: readonly MessageLike[] | undefined): string {
  return (messages ?? [])
    .flatMap(message => message.content ?? [])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function signatureMatches(skill: MemoryRecord, text: string): boolean {
  const signature = skill.errorSignature?.trim().toLowerCase() ?? ''
  if (signature === '') return false
  const haystack = text.toLowerCase()
  if (haystack.includes(signature)) return true
  const tokens = signature.split(/[^a-z0-9_\u4e00-\u9fff]+/iu).filter(token => token.length >= 4)
  return tokens.some(token => haystack.includes(token))
}

/** 已确认记忆摘要：提炼法则/方法论 + preference/fact + 排错经验，按遗忘曲线褪色。 */
export function buildDigest(items: readonly MemoryRecord[]): string {
  const now = Date.now()
  // 已褪色的记忆不再进入系统提示：留在库里，但不再污染当前世界模型。
  const active = items.filter(item => !isFaded(item, now))
  const approved = active.filter(item => item.status === 'approved')
  const rules = approvedRules(active)
  const strategies = rankStrategies(active, 3)
  const basics = approved
    .filter(item => item.type === 'preference' || item.type === 'fact')
    .slice(0, 12)
  const models = approved
    .filter(item => item.type === 'mental_model')
    .slice(0, 2)
  const skills = approved
    .filter(item => item.type === 'skill_error_fix'
      && typeof item.resolution === 'string'
      && item.resolution.trim() !== '')
    .slice(0, 5)
  if (basics.length === 0 && models.length === 0 && skills.length === 0
    && rules.length === 0 && strategies.length === 0) return ''
  const lines = ['[dsh-evolution-flywheel] 已确认的长期记忆（自动注入，供参考）：']
  // 最高优先级：人类已裁决的“跨域映射法则”，放在摘要最前面。
  if (rules.length > 0) {
    lines.push('【跨域映射法则（人类已裁决，最高优先级）】')
    for (const item of rules) {
      const reason = item.analogyReason === undefined ? '' : `（依据：${item.analogyReason.slice(0, 80)}）`
      lines.push(`- ${item.content.slice(0, 120)}${reason}（${perceptionLabel(item, now)}）`)
    }
  }
  if (strategies.length > 0) {
    lines.push('【提炼方法论（最近最成功，供当前任务参考）】')
    for (const item of strategies) {
      const status = item.status === 'approved' ? '已裁决' : '候选'
      const model = item.thinkingModel === undefined ? '' : `｜思维模型：${item.thinkingModel}`
      const applies = item.effectiveFor === undefined ? '' : `｜适用：${item.effectiveFor.slice(0, 50)}`
      lines.push(`- [${status}] ${item.content.slice(0, 60)}${model}${applies}（${perceptionLabel(item, now)}）`)
    }
  }
  for (const item of basics) {
    lines.push(`- ${item.type === 'preference' ? '偏好' : '事实'}：${item.content.slice(0, 160)}（${perceptionLabel(item, now)}）`)
  }
  for (const item of models) {
    const pattern = (item.metaInsight ?? '').slice(0, 80)
    const applies = (item.resolution ?? '').slice(0, 80)
    const counter = (item.counterexample ?? '').slice(0, 60)
    lines.push(`- 思维模型：${item.content.slice(0, 40)} → ${pattern}；适用：${applies}${counter === '' ? '' : `；反例：${counter}`}（${perceptionLabel(item, now)}）`)
  }
  for (const item of skills) {
    const salience = memorySalience(item)
    const prefix = salience >= 0.8 ? '⚠️ 致命红线 · ' : salience >= 0.55 ? '高显著 · ' : ''
    lines.push(`- 排错经验：${prefix}${(item.errorSignature ?? item.content).slice(0, 80)} → ${(item.resolution ?? '').slice(0, 120)}（${perceptionLabel(item, now)}）`)
  }
  lines.push('【时间感】记忆会随时间褪色；保留率低或标有“建议重新验证”时，先跑最小验证，再用 memory_probe 记录结论，不要直接沿用旧经验。')
  const digest = lines.join('\n')
  return digest.length > 2000 ? `${digest.slice(0, 2000)}\n[记忆摘要已截断]` : digest
}

/** 注册 agent/pre-step 召回；命中结果写入 systemPrompt 的动态 context。 */
export function registerMemoryRecall(ctx: MemoryRecallContext, store: MemoryStore): void {
  const lastTurn = new WeakMap<object, number>()
  const notices = new WeakMap<object, { turn: number; text: string }>()
  const noticesById = new Map<string, { turn: number; text: string }>()
  const agentIdOf = (agent: unknown): string | undefined =>
    typeof agent === 'object' && agent !== null && typeof (agent as { id?: unknown }).id === 'string'
      ? (agent as { id: string }).id
      : undefined
  const readNotice = (agent: unknown): { turn: number; text: string } | undefined => {
    const id = agentIdOf(agent)
    if (id !== undefined) return noticesById.get(id)
    return typeof agent === 'object' && agent !== null ? notices.get(agent) : undefined
  }
  const writeNotice = (agent: object, value: { turn: number; text: string }): void => {
    notices.set(agent, value)
    const id = agentIdOf(agent)
    if (id !== undefined) noticesById.set(id, value)
  }
  const clearNotice = (agent: object): void => {
    notices.delete(agent)
    const id = agentIdOf(agent)
    if (id !== undefined) noticesById.delete(id)
  }
  const digests = new WeakMap<object, string>()
  const digestsById = new Map<string, string>()
  const readDigest = (agent: unknown): string => {
    const id = agentIdOf(agent)
    if (id !== undefined) return digestsById.get(id) ?? ''
    return typeof agent === 'object' && agent !== null ? digests.get(agent) ?? '' : ''
  }
  let digestCache: { at: number; text: string } | undefined
  let lastRecallTouch = 0
  const refreshDigest = async (agent: object): Promise<void> => {
    try {
      const now = Date.now()
      if (digestCache === undefined || now - digestCache.at > 3_000) {
        const items = await store.list()
        digestCache = { at: now, text: buildDigest(items) }
        // 每 5 分钟最多记录一次“被召回”，作为遗忘曲线的基准，避免写放大。
        if (now - lastRecallTouch > 300_000) {
          lastRecallTouch = now
          const recalled = items
            .filter(item => item.status === 'approved' && !isFaded(item, now))
            .slice(0, 20)
            .map(item => item.id)
          void store.touchRecalled(recalled).catch(error => {
            console.error('[dsh-evolution-flywheel] recall touch failed:', error)
          })
        }
      }
      digests.set(agent, digestCache.text)
      const id = agentIdOf(agent)
      if (id !== undefined) digestsById.set(id, digestCache.text)
    } catch (error) {
      console.error('[dsh-evolution-flywheel] memory digest refresh failed:', error)
    }
  }
  const systemPrompt = (() => {
    if (ctx.systemPrompt !== undefined) return ctx.systemPrompt
    try {
      const value = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
      return typeof value === 'object' && value !== null
        ? value as NonNullable<MemoryRecallContext['systemPrompt']>
        : undefined
    } catch {
      return undefined
    }
  })()

  const listener = async (
    payload: AgentPreStepPayload,
    next: () => Promise<PreStepDecisionLike>,
  ): Promise<PreStepDecisionLike> => {
    let decision: PreStepDecisionLike
    try {
      decision = await next()
    } catch (error) {
      console.error('[dsh-evolution-flywheel] agent/pre-step continuation failed:', error)
      return { kind: 'reject' }
    }
    if (typeof payload.agent === 'object' && payload.agent !== null) {
      await refreshDigest(payload.agent)
    }
    if (decision.kind !== 'enter' || payload.messages === undefined || payload.messages.length === 0) return decision
    const text = textOf(payload.messages)
    if (text === '') return decision
    if (typeof payload.agent === 'object' && payload.agent !== null && payload.turn !== undefined) {
      if (lastTurn.get(payload.agent) === payload.turn) return decision
    }

    try {
      const items = await store.list()
      const matches = items
        .filter(item => item.type === 'skill_error_fix'
          && item.status === 'approved'
          && typeof item.resolution === 'string'
          && item.resolution.trim() !== ''
          && signatureMatches(item, text))
        .slice(0, 2)
      if (matches.length === 0) {
        if (typeof payload.agent === 'object' && payload.agent !== null) clearNotice(payload.agent)
        return decision
      }

      const lines = matches.map(item => `- 错误：${item.errorSignature ?? '未命名错误'}\n  历史解决方案：${item.resolution}`)
      const notice = [
        '系统检测到相似错误，历史解决方案如下，请优先参考。',
        lines.join('\n'),
        '如果当前错误不同，请以当前环境为准。',
      ].join('\n')

      if (typeof payload.agent === 'object' && payload.agent !== null && payload.turn !== undefined) {
        lastTurn.set(payload.agent, payload.turn)
        writeNotice(payload.agent, { turn: payload.turn, text: notice })
      }

      // 有 systemPrompt 时只写动态 system context，不再伪造一条 user 消息。
      if (systemPrompt !== undefined && typeof systemPrompt.context === 'function') {
        return decision
      }

      const injected: MessageLike = {
        id: `mem-recall-${randomUUID()}`,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: notice }],
      }
      return { ...decision, messages: [...(decision.messages ?? []), injected] }
    } catch (error) {
      console.error('[dsh-evolution-flywheel] memory recall failed:', error)
      return decision
    }
  }

  try {
    if (systemPrompt !== undefined && typeof systemPrompt.context === 'function') {
      ctx.effect(() => systemPrompt.context({
        name: 'memory:skill-recall',
        order: 90,
        interpolate: false,
        text: (context) => {
          const agent = context.agent
          if (typeof agent !== 'object' || agent === null) return ''
          const notice = readNotice(agent)?.text ?? ''
          if (notice !== '') {
            console.error('[dsh-evolution-flywheel] injecting approved skill resolution into system prompt')
          }
          return notice
        },
      }))
    }
    if (systemPrompt !== undefined && typeof systemPrompt.context === 'function') {
      ctx.effect(() => systemPrompt.context({
        name: 'memory:digest',
        order: 80,
        interpolate: false,
        text: (context) => {
          const agent = context.agent
          if (typeof agent !== 'object' || agent === null) return ''
          return readDigest(agent)
        },
      }))
    }
    ctx.effect(() => ctx.on('agent/pre-step', listener))
  } catch (error) {
    console.error('[dsh-evolution-flywheel] memory recall registration failed:', error)
  }
}

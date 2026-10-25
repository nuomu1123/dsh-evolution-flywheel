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

/** 机器探测类「事实/偏好」不进入注入：浏览器审计记录、整段用户原始需求都不是可复用经验。 */
function isNoiseBasic(item: MemoryRecord): boolean {
  const content = item.content ?? ''
  if (content.includes('[浏览器审计]')) return true
  if (item.type !== 'preference') return false
  // 用户整段原始需求（长且带任务词）当偏好长期注入，会把排错经验挤出预算。
  if (content.length > 200 && /(请|任务|步骤|实现|修复|写入|不要)/u.test(content)) return true
  return false
}

/**
 * 已确认记忆摘要。
 *
 * 顺序按「可复用性」排：跨域法则 → 提炼策略 → **排错经验** → 偏好/事实 → 思维模型。
 * 2026-10-25 实测修正：旧顺序把偏好/事实放前面，76 条带解法的排错经验被 2000 字预算饿死（注入里 0 条）。
 */
export function buildDigest(items: readonly MemoryRecord[]): string {
  const now = Date.now()
  // 已褪色或已归档的记忆不再进入系统提示：留在库里，但不再污染当前世界模型。
  const active = items.filter(item => item.archived !== true && !isFaded(item, now))
  const approved = active.filter(item => item.status === 'approved')
  // 压缩链（遗忘与提炼互为补充）：已生效的规律/模型记下它覆盖了哪些原始记忆；
  // 被覆盖的原始细节不再单独注入——规律已保留结构，重复注入只会挤占 2000 字预算。
  // 注意只认 approved 的「压缩者」：候选规律没被人类裁决前，原始记忆不能因此退场。
  const compressed = new Set<string>()
  for (const item of approved) {
    if (item.compressedFrom === undefined) continue
    for (const id of item.compressedFrom) compressed.add(id)
  }
  const rules = approvedRules(active).slice(0, 3)
  const strategies = rankStrategies(active, 3)
  // 排错经验优先：已解决问题可直接复用，最该先占预算。
  const skills = approved
    .filter(item => !compressed.has(item.id))
    .filter(item => item.type === 'skill_error_fix'
      && typeof item.resolution === 'string'
      && item.resolution.trim() !== '')
    .sort((left, right) => memorySalience(right) - memorySalience(left))
    .slice(0, 4)
  // 偏好/事实：过滤探测噪音、跳过已被压缩的、按显著性排序、限条（避免闲聊把预算吃满）。
  const basics = approved
    .filter(item => !compressed.has(item.id))
    .filter(item => item.type === 'preference' || item.type === 'fact')
    .filter(item => !isNoiseBasic(item))
    .sort((left, right) => memorySalience(right) - memorySalience(left))
    .slice(0, 5)
  const models = approved
    .filter(item => item.type === 'mental_model')
    .slice(0, 2)
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
      const model = item.thinkingModel === undefined ? '' : `｜思维模型：${item.thinkingModel.slice(0, 60)}`
      const applies = item.effectiveFor === undefined ? '' : `｜适用：${item.effectiveFor.slice(0, 50)}`
      lines.push(`- [${status}] ${item.content.slice(0, 60)}${model}${applies}（${perceptionLabel(item, now)}）`)
    }
  }
  // 排错经验前置：这是「记住并复用」的主战场，不能再被偏好挤掉。
  if (skills.length > 0) {
    lines.push('【排错经验（已解决，可直接复用）】')
    for (const item of skills) {
      // 显著性标记（⚠️ 致命红线 / 高显著）由 perceptionLabel 统一给出，这里不再重复前缀。
      lines.push(
        `- ${(item.errorSignature ?? item.content).slice(0, 60)} → ${(item.resolution ?? '').slice(0, 90)}（${perceptionLabel(item, now)}）`,
      )
    }
  }
  for (const item of basics) {
    const label = item.type === 'preference' ? '偏好' : '事实'
    // 偏好多为用户原话，可复用性低，截短；事实保留更多上下文。
    const limit = item.type === 'preference' ? 70 : 120
    lines.push(`- ${label}：${(item.content ?? '').slice(0, limit)}（${perceptionLabel(item, now)}）`)
  }
  for (const item of models) {
    const pattern = (item.metaInsight ?? '').slice(0, 80)
    const applies = (item.resolution ?? '').slice(0, 80)
    const counter = (item.counterexample ?? '').slice(0, 60)
    lines.push(`- 思维模型：${item.content.slice(0, 40)} → ${pattern}；适用：${applies}${counter === '' ? '' : `；反例：${counter}`}（${perceptionLabel(item, now)}）`)
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
            .filter(item => item.status === 'approved' && item.archived !== true && !isFaded(item, now))
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

      // 区分「已验证」与「模型推测」：把猜测标成「请优先参考」会误导判断。
      const verified = matches.filter(item => item.resolutionSource === 'verified')
      const inferred = matches.filter(item => item.resolutionSource !== 'verified')
      const lines = [
        ...verified.map(item => `- 错误：${item.errorSignature ?? '未命名错误'}\n  已验证解法：${item.resolution}`),
        ...inferred.map(item => `- 错误：${item.errorSignature ?? '未命名错误'}\n  未验证推测：${item.resolution}`),
      ]
      const notice = [
        ...(verified.length === 0 ? [] : ['系统检测到相似错误，以下解法已被人类或探针验证，请优先参考。']),
        ...(inferred.length === 0 ? [] : ['以下为模型推测的解法，尚未验证，仅供参考。']),
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

/**
 * 提炼方法论的自记录与自进化（元-元认知）。
 *
 * 数据流：
 *   提炼前 -> rankStrategies 选出“最近最成功”的 2-3 条策略，拼进提示词；
 *   提炼后 -> reflectAndStore 强迫反思：用了什么思维模型、为什么类比、对什么材料有效；
 *   大提炼 -> mergeStrategyLibrary 把多条策略融合为“跨域映射法则”候选（仍需人类裁决）。
 *
 * 原则：
 * - 策略也是记忆，写入 extraction_strategy，默认 suggested，人类裁决后才 approved；
 * - 未经裁决的候选策略可以“试用注入”，但提示词里必须明确标注，避免污染；
 * - 所有写入都复用 MemoryStore 的串行队列，不新增文件。
 */
import type { MemoryContextBase } from './context.js'
import { complete } from './review-driver.js'
import { sanitizeText } from './sanitize.js'
import type { MemoryRecord, MemoryStore } from './store.js'

const sanitize = (value: unknown, maxLength = 1000): string =>
  sanitizeText(value, maxLength, '提炼策略')

export type StrategyStage = 'small' | 'large' | 'merge'

function stageLabel(stage: StrategyStage): string {
  if (stage === 'small') return '小提炼（四段式审阅/辩论）'
  if (stage === 'large') return '大提炼（睡眠巩固）'
  return '策略融合（元-元认知）'
}

export interface StrategyReflection {
  /** 策略名/一句话方法论，不超过 20 字。 */
  name: string
  /** 本次提炼使用的思维模型或跨域类比。 */
  thinkingModel: string
  /** 为什么这样类比成立。 */
  analogyReason: string
  /** 这种提炼方法对什么原始材料最有效。 */
  effectiveFor: string
  /** 模型自评置信度 0-1。 */
  confidence: number
  /** 本次反思消耗的 token，计入 Token 账单。 */
  tokensUsed?: number
}

export interface StrategyContext {
  stage: StrategyStage
  /** 本次提炼任务摘要（错误特征 / 跨学科洞察主题等）。 */
  task: string
  /** 本次提炼结果摘要（裁决结论 / 生成的模型名等）。 */
  outcome: string
}

export interface StrategyMerge {
  rule: string
  rationale: string
  appliesTo: string
  sourceIds: string[]
  /** 本次融合消耗的 token，计入 Token 账单。 */
  tokensUsed?: number
}

export interface StrategyReflector {
  reflect(input: StrategyContext): Promise<StrategyReflection | undefined>
  merge(strategies: readonly MemoryRecord[]): Promise<StrategyMerge | undefined>
}

export interface StrategyInjection {
  ids: string[]
  names: string[]
  text: string
}

export interface StrategyHooks {
  injection(limit?: number): Promise<StrategyInjection>
  reflect(input: StrategyContext): Promise<MemoryRecord | undefined>
  /** 大提炼专用：把多条策略融合成“跨域映射法则”候选。 */
  merge?(): Promise<MemoryRecord | undefined>
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/** 纯函数：策略排序分。已裁决 + 成功 + 被使用 - 失败。 */
export function strategySortKey(item: MemoryRecord): number {
  const approved = item.status === 'approved' ? 1000 : 0
  const success = (item.successCount ?? 0) * 10
  const applied = Math.min(item.appliedCount ?? 0, 20)
  const confidence = (item.confidence ?? 0) * 5
  const failure = (item.failureCount ?? 0) * 10
  return approved + success + applied + confidence - failure
}

/**
 * 选出“最近最成功”的策略：approved 优先，其余按成功率/使用次数/置信度排序。
 * 融合法则（rule=true）不参与普通注入，由 recall 以最高优先级单独注入。
 */
export function rankStrategies(items: readonly MemoryRecord[], limit = 3): MemoryRecord[] {
  if (limit <= 0) return []
  return items
    .filter(item => item.type === 'extraction_strategy'
      && item.status !== 'rejected'
      && item.rule !== true)
    .sort((left, right) =>
      strategySortKey(right) - strategySortKey(left)
      || right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit)
}

/** 生成注入到提示词的方法论段落；空库返回空串。人工裁决的法则优先。 */
export function buildStrategyPrompt(
  strategies: readonly MemoryRecord[],
  rules: readonly MemoryRecord[] = [],
): string {
  if (strategies.length === 0 && rules.length === 0) return ''
  const lines: string[] = []
  if (rules.length > 0) {
    lines.push('【跨域映射法则（人类已裁决，最高优先级）】')
    for (const item of rules) {
      const basis = item.analogyReason === undefined ? '' : `（依据：${item.analogyReason.slice(0, 100)}）`
      lines.push(`- ${item.content.slice(0, 120)}${basis}`)
    }
    lines.push('')
  }
  if (strategies.length > 0) {
    lines.push('【提炼方法论自注入】下面是你过去执行提炼任务后沉淀的策略，按成功度排序，请优先沿用：')
    for (const item of strategies) {
      const status = item.status === 'approved' ? '已裁决' : '候选（未经人类裁决，仅供试用）'
      const details = [
        item.thinkingModel === undefined ? '' : `思维模型：${item.thinkingModel}`,
        item.analogyReason === undefined ? '' : `类比理由：${item.analogyReason}`,
        item.effectiveFor === undefined ? '' : `最适用于：${item.effectiveFor}`,
      ].filter(detail => detail !== '')
      lines.push([
        `- 策略：${item.content.slice(0, 80)}（${status}；成功 ${item.successCount ?? 0} 次 · 已用 ${item.appliedCount ?? 0} 次）`,
        ...details.map(detail => `  ${detail}`),
      ].join('\n'))
    }
    lines.push('如果本次材料与上述方法论不匹配，请明确说明并换用更合适的方法，不要硬套。')
  }
  return lines.join('\n').slice(0, 1800)
}

/** 读取策略、拼接提示词，并把“被注入”写回策略记录（appliedCount/lastAppliedAt）。 */
export async function prepareStrategyInjection(
  store: MemoryStore,
  limit = 3,
): Promise<StrategyInjection> {
  const items = await store.list()
  const ranked = rankStrategies(items, limit)
  const rules = approvedRules(items)
  if (ranked.length === 0 && rules.length === 0) return { ids: [], names: [], text: '' }
  const ids = ranked.map(item => item.id)
  const names = [
    ...rules.map(item => `法则：${item.content.slice(0, 60)}`),
    ...ranked.map(item => item.content),
  ]
  try {
    if (ids.length > 0) await store.touchStrategies(ids)
  } catch (error) {
    console.error('[dsh-evolution-flywheel] strategy touch failed:', error)
  }
  console.error(
    `[dsh-evolution-flywheel] 提炼前注入 ${rules.length} 条法则、${ranked.length} 条策略：${names.join(' / ')}`,
  )
  return { ids, names, text: buildStrategyPrompt(ranked, rules) }
}

/** 已裁决的融合法则（最高优先级），按成功次数与时间排序。 */
export function approvedRules(items: readonly MemoryRecord[]): MemoryRecord[] {
  return items
    .filter(item => item.type === 'extraction_strategy'
      && item.rule === true
      && item.status === 'approved')
    .sort((left, right) =>
      (right.successCount ?? 0) - (left.successCount ?? 0)
      || right.createdAt.localeCompare(left.createdAt))
    .slice(0, 2)
}

/** 从 LLM 输出中取出第一个 JSON 对象。 */
function parseObject(text: string): Record<string, unknown> | undefined {
  const cleaned = text.replace(/```json/giu, '').replace(/```/gu, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const value: unknown = JSON.parse(cleaned.slice(start, end + 1))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

function textField(value: Record<string, unknown>, key: string, max: number): string {
  return typeof value[key] === 'string' ? sanitize(value[key], max) : ''
}

export function parseStrategyReflection(text: string): StrategyReflection | undefined {
  const value = parseObject(text)
  if (value === undefined) return undefined
  const name = textField(value, 'name', 60) || textField(value, 'strategy', 60)
  if (name === '') return undefined
  const rawConfidence = typeof value.confidence === 'number' ? value.confidence : Number(value.confidence)
  return {
    name,
    thinkingModel: textField(value, 'thinkingModel', 120),
    analogyReason: textField(value, 'analogyReason', 500),
    effectiveFor: textField(value, 'effectiveFor', 300),
    confidence: clamp01(rawConfidence),
  }
}

export function parseStrategyMerge(
  text: string,
  strategies: readonly MemoryRecord[],
): StrategyMerge | undefined {
  const value = parseObject(text)
  if (value === undefined) return undefined
  const rule = textField(value, 'rule', 120)
  if (rule === '') return undefined
  const indexed = Array.isArray(value.sourceIds) ? value.sourceIds : []
  const sourceIds = [...new Set(indexed
    .map(entry => typeof entry === 'number' ? entry : typeof entry === 'string' ? Number(entry) : Number.NaN)
    .filter(entry => Number.isInteger(entry) && entry >= 1 && entry <= strategies.length)
    .map(entry => strategies[entry - 1]?.id)
    .filter((id): id is string => typeof id === 'string'))].slice(0, 8)
  return {
    rule,
    rationale: textField(value, 'rationale', 400),
    appliesTo: textField(value, 'appliesTo', 300),
    sourceIds,
  }
}

/** 生产环境：用 DSH 内部 LLM 做后置反思与策略融合。 */
export function createLlmStrategyReflector(ctx: MemoryContextBase): StrategyReflector {
  return {
    async reflect(input: StrategyContext): Promise<StrategyReflection | undefined> {
      const prompt = [
        `你刚完成了一次${stageLabel(input.stage)}。`,
        `任务摘要：${sanitize(input.task, 400)}`,
        `结果摘要：${sanitize(input.outcome, 400)}`,
        '现在进行后置反思，只反思“提炼方法”，不要复述知识结论。回答三个问题：',
        '1. 本次用了什么思维模型或跨域类比？',
        '2. 为什么这个类比成立？边界在哪？',
        '3. 这种提炼方法对什么样的原始材料最有效？',
        '只输出 JSON：',
        '{"name":"策略名，不超过20字","thinkingModel":"不超过40字","analogyReason":"不超过120字","effectiveFor":"不超过80字","confidence":0.8}',
        '如果本次提炼没有可迁移的方法论，输出 {}。',
      ].join('\n')
      const completion = await complete(
        ctx,
        '你是元认知提炼方法反思器。只输出 JSON，不要输出 Markdown。',
        prompt,
        400,
      )
      const reflection = parseStrategyReflection(completion.text)
      if (reflection === undefined) return undefined
      return { ...reflection, tokensUsed: completion.tokensUsed }
    },

    async merge(strategies: readonly MemoryRecord[]): Promise<StrategyMerge | undefined> {
      const lines = strategies.map((item, index) => {
        const details = [
          item.thinkingModel === undefined ? '' : `模型=${item.thinkingModel}`,
          item.analogyReason === undefined ? '' : `理由=${item.analogyReason.slice(0, 80)}`,
          item.effectiveFor === undefined ? '' : `适用=${item.effectiveFor.slice(0, 60)}`,
        ].filter(detail => detail !== '')
        return `${index + 1}. [${item.strategyStage ?? 'unknown'}] ${item.content.slice(0, 60)}${details.length > 0 ? `（${details.join('；')}）` : ''}`
      })
      const prompt = [
        '你是“跨域映射法则”融合器。下面是系统多次提炼后沉淀的策略。',
        '请把它们融合成一条更通用、更高效的跨域映射法则，不得简单堆砌，不得编造未出现过的经验。',
        '策略列表：',
        lines.join('\n'),
        '只输出 JSON：',
        '{"rule":"法则，不超过60字","rationale":"为什么成立，不超过150字","appliesTo":"适用范围，不超过120字","sourceIds":[1,2,3]}',
        'sourceIds 使用上面的序号；如果这些策略之间没有共同规律，输出 {}。',
      ].join('\n')
      const completion = await complete(
        ctx,
        '你是严谨的跨域映射法则融合器。只输出 JSON，不要输出 Markdown。',
        prompt,
        500,
      )
      const merged = parseStrategyMerge(completion.text, strategies)
      if (merged === undefined) return undefined
      return { ...merged, tokensUsed: completion.tokensUsed }
    },
  }
}

/**
 * 后置反思入库：写一条 extraction_strategy（suggested，等待人类裁决）。
 * 同名策略不重复写入。
 */
export async function reflectAndStore(
  store: MemoryStore,
  reflector: StrategyReflector,
  input: StrategyContext,
): Promise<MemoryRecord | undefined> {
  try {
    const reflection = await reflector.reflect(input)
    if (reflection === undefined) return undefined
    const name = reflection.name.trim()
    if (name === '') return undefined
    const existing = (await store.list()).find(item =>
      item.type === 'extraction_strategy'
      && item.content.trim() === name
      && item.status !== 'rejected')
    if (existing !== undefined) return existing
    const created = await store.appendSuggested(name, 'extraction_strategy')
    if (created === undefined) return undefined
    const updated = await store.update(created.id, {
      thinkingModel: reflection.thinkingModel,
      analogyReason: reflection.analogyReason,
      effectiveFor: reflection.effectiveFor,
      strategyStage: input.stage,
      confidence: reflection.confidence,
      origin: 'strategy-reflection',
      originDetail: stageLabel(input.stage),
      ...(reflection.tokensUsed !== undefined ? { reviewTokens: reflection.tokensUsed } : {}),
      trace: [
        `阶段：${stageLabel(input.stage)}`,
        `任务：${input.task.slice(0, 120)}`,
        `结果：${input.outcome.slice(0, 120)}`,
        `思维模型：${reflection.thinkingModel || '未标注'}`,
        `类比理由：${reflection.analogyReason.slice(0, 160) || '未标注'}`,
      ],
    })
    console.error(`[dsh-evolution-flywheel] 提炼后沉淀策略：${name}（${stageLabel(input.stage)}）`)
    return updated
  } catch (error) {
    console.error('[dsh-evolution-flywheel] strategy reflection failed:', error)
    return undefined
  }
}

/**
 * 大提炼中的策略进化：把多条策略融合成“跨域映射法则”候选。
 * 少于 3 条策略时返回 undefined；新旧法则同名时复用旧记录。
 */
export async function mergeStrategyLibrary(
  store: MemoryStore,
  reflector: StrategyReflector,
  limit = 8,
): Promise<MemoryRecord | undefined> {
  try {
    const items = await store.list()
    const strategies = items
      .filter(item => item.type === 'extraction_strategy'
        && item.status !== 'rejected'
        && item.rule !== true)
      .slice(0, limit)
    if (strategies.length < 3) return undefined
    const merged = await reflector.merge(strategies)
    if (merged === undefined || merged.rule.trim() === '') return undefined
    const existing = items.find(item =>
      item.type === 'extraction_strategy'
      && item.rule === true
      && item.content.trim() === merged.rule.trim()
      && item.status !== 'rejected')
    if (existing !== undefined) return existing
    const created = await store.appendSuggested(merged.rule, 'extraction_strategy')
    if (created === undefined) return undefined
    const updated = await store.update(created.id, {
      rule: true,
      strategyStage: 'merge',
      thinkingModel: '跨域映射法则',
      analogyReason: merged.rationale,
      effectiveFor: merged.appliesTo,
      mergedFrom: merged.sourceIds,
      confidence: 0.7,
      origin: 'strategy-merge',
      originDetail: `融合 ${merged.sourceIds.length} 条策略`,
      ...(merged.tokensUsed !== undefined ? { reviewTokens: merged.tokensUsed } : {}),
      trace: [
        `融合来源 ${strategies.length} 条策略：${strategies.map(item => item.content.slice(0, 40)).join(' / ')}`,
        `法则：${merged.rule}`,
        `依据：${merged.rationale.slice(0, 160)}`,
        '等待人类裁决后，才会以最高优先级注入 System Prompt。',
      ],
    })
    console.error(`[dsh-evolution-flywheel] 策略融合出跨域映射法则候选：${merged.rule}`)
    return updated
  } catch (error) {
    console.error('[dsh-evolution-flywheel] strategy merge failed:', error)
    return undefined
  }
}

/** 把反射器与存储装配成 state-machine / model-distill 可用的钩子。 */
export function createStrategyHooks(ctx: MemoryContextBase, store: MemoryStore): StrategyHooks {
  const reflector = createLlmStrategyReflector(ctx)
  return {
    injection: limit => prepareStrategyInjection(store, limit),
    reflect: input => reflectAndStore(store, reflector, input),
    merge: () => mergeStrategyLibrary(store, reflector),
  }
}

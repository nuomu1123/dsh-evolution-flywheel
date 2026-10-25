/**
 * 大提炼（睡眠巩固）：从跨学科 meta_insight 中提炼可迁移的思维模型。
 *
 * 除了生成 mental_model，还承担“元-元认知”：
 * 1. 提炼前：注入最近最成功的提炼方法论；
 * 2. 提炼后：后置反思本次方法论（extraction_strategy，仍需人类裁决）；
 * 3. 策略融合：把多条策略融合为“跨域映射法则”候选。
 *
 * 只生成 suggested 记录；是否采纳仍由人类裁决。
 */
import type { MemoryContextBase } from './context.js'
import { readBudget } from './budget.js'
import { isFaded, memoryFreshness } from './decay.js'
import { complete } from './review-driver.js'
import { sanitizeText } from './sanitize.js'
import { createProbe } from './probes.js'
import type { StrategyHooks } from './strategy.js'
import type { MemoryRecord, MemoryStore } from './store.js'

/**
 * 选出本次大提炼的输入（遗忘与提炼互补的「遗忘→提炼」方向）。
 *
 * 旧逻辑只取最近的 meta_insight，导致「快被忘掉的洞察」永远轮不到压缩，
 * 一褪色就直接从注入里消失、细节再也抽不出来。
 * 现在的顺序：**将褪色且尚未被覆盖的洞察优先**，再用最近的补满。
 */
export function pickDistillSeeds(items: readonly MemoryRecord[], limit = 8, now = Date.now()): MemoryRecord[] {
  const insights = items.filter(item => item.type === 'meta_insight'
    && item.archived !== true
    && (item.status === 'approved' || item.status === 'speculative'))
  // 只有已生效的规律才算「已被覆盖」：候选规律不能阻止原始洞察被再次提炼。
  const compressed = new Set<string>()
  for (const item of items) {
    if (item.status !== 'approved' || item.compressedFrom === undefined) continue
    for (const id of item.compressedFrom) compressed.add(id)
  }
  const stale = insights
    .filter(item => !compressed.has(item.id) && isFaded(item, now))
    .sort((left, right) => memoryFreshness(left, now) - memoryFreshness(right, now))
    .slice(0, Math.max(0, Math.min(4, limit)))
  const staleIds = new Set(stale.map(item => item.id))
  const rest = insights
    .filter(item => !staleIds.has(item.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return [...stale, ...rest].slice(0, Math.max(0, limit))
}

export interface DistilledModel {
  name: string
  pattern: string
  appliesTo: string
  counterexample: string
  sourceDisciplines: string
}

/** 一次大提炼的完整产出：思维模型 + 方法论反思 + 融合法则候选。 */
export interface DistillOutcome {
  item: MemoryRecord
  strategy?: MemoryRecord
  rule?: MemoryRecord
}

function field(value: Record<string, unknown>, key: string, max: number): string {
  return typeof value[key] === 'string' ? sanitizeText(value[key], max, '模型提炼') : ''
}

function parseModel(text: string): DistilledModel | undefined {
  const match = text.match(/\{[\s\S]*\}/u)
  if (match === null) return undefined
  try {
    const value = JSON.parse(match[0]) as Record<string, unknown>
    const name = field(value, 'name', 40)
    const pattern = field(value, 'pattern', 300)
    if (name === '' || pattern === '') return undefined
    return {
      name,
      pattern,
      appliesTo: field(value, 'appliesTo', 300),
      counterexample: field(value, 'counterexample', 300),
      sourceDisciplines: field(value, 'sourceDisciplines', 120),
    }
  } catch {
    return undefined
  }
}

/** 从最近 8 条跨学科洞察中提炼 1 个模型；不足 2 条或失败时返回 undefined。 */
export async function distillModel(
  ctx: Pick<MemoryContextBase, 'get'>,
  store: MemoryStore,
  maxTokens = 500,
  hooks?: StrategyHooks,
): Promise<DistillOutcome | undefined> {
  const items = await store.list()
  // 遗忘信号优先：将褪色且尚未被覆盖的洞察先压缩，避免「褪色即失去细节」。
  const seeds = pickDistillSeeds(items, 8)
  if (seeds.length < 2) return undefined

  let strategyText = ''
  let strategyNames: string[] = []
  try {
    const injection = hooks === undefined ? undefined : await hooks.injection(3)
    strategyText = injection?.text ?? ''
    strategyNames = injection?.names ?? []
  } catch (error) {
    console.error('[dsh-evolution-flywheel] strategy injection failed:', error)
  }

  const prompt = [
    '你是架构思维模型提炼器。下面是多次跨学科漫游产生的元认知洞察。',
    '请提炼 1 个可迁移的思维模型，必须能指导软件架构决策，不要复述单条洞察。',
    ...(strategyText === '' ? [] : ['', strategyText, '']),
    ...seeds.map((item, index) => {
      const insight = item.metaInsight === undefined ? '' : ` / ${item.metaInsight.slice(0, 120)}`
      return `${index + 1}. [${item.discipline ?? '未知学科'}] ${item.content.slice(0, 160)}${insight}`
    }),
    '只输出 JSON：',
    '{"name":"模型名，不超过20字","pattern":"模型机制，不超过100字","appliesTo":"适用场景，不超过120字","counterexample":"反例/边界，不超过100字","sourceDisciplines":"来源学科，不超过60字"}',
    '如果这些洞察之间没有共同模式，输出 {}。',
  ].join('\n')
  const completion = await complete(
    ctx as MemoryContextBase,
    '你是严格的架构思维模型提炼器。若提供了提炼方法论，优先沿用适用者。只输出 JSON，不要输出 Markdown。',
    prompt,
    maxTokens,
  )
  const model = parseModel(completion.text)
  if (model === undefined) return undefined
  const existing = items.find(item => item.type === 'mental_model' && item.content.trim() === model.name)
  if (existing !== undefined) return { item: existing }
  const created = await store.appendSuggested(model.name, 'mental_model')
  if (created === undefined) return undefined
  const saved = await store.update(created.id, {
    metaInsight: model.pattern,
    resolution: model.appliesTo,
    context: model.counterexample,
    counterexample: model.counterexample,
    discipline: model.sourceDisciplines,
    sources: ['model-distill'],
    tokensUsed: completion.tokensUsed,
    origin: 'model-distill',
    originDetail: `基于 ${seeds.length} 条 meta_insight`,
    // 压缩链：记录这条规律覆盖了哪些原始洞察。遗忘与提炼互补——
    // 被覆盖的原始细节不必再单独注入，只有被覆盖过的记忆才允许优先褪色。
    compressedFrom: seeds.map(item => item.id),
    trace: [
      `读取 ${seeds.length} 条 meta_insight`,
      `压缩覆盖：${seeds.length} 条原始洞察（compressedFrom）`,
      `来源学科：${[...new Set(seeds.map(item => item.discipline).filter((value): value is string => value !== undefined))].join(' / ') || '未记录'}`,
      `模型：${model.name}`,
      `机制：${model.pattern}`,
      ...(strategyText === '' ? [] : [`注入策略：${strategyNames.join(' / ').slice(0, 160)}`]),
      `LLM 输出：${completion.text.slice(0, 200)}`,
    ],
  })
  if (saved === undefined) return undefined

  // 大提炼发现“缺少关键前提/边界”时，向人类提一个高价值问题。
  if (model.appliesTo === '' || model.counterexample === '') {
    await createProbe(store, {
      question: `「${model.name}」在哪些场景下会失效？边界条件是什么？`,
      reason: model.counterexample === ''
        ? '新提炼的思维模型缺少反例/边界，可能被过度泛化'
        : '新提炼的思维模型缺少适用场景，无法判断何时该用',
      source: 'model-distill',
      sourceId: saved.id,
    })
  }

  const outcome: DistillOutcome = { item: saved }
  if (hooks !== undefined) {
    // 策略反思与融合也消耗 LLM；预算耗尽时只保留模型结果。
    let budgetExceeded = false
    try {
      budgetExceeded = (await readBudget(store)).exceeded
    } catch (error) {
      // fail-closed：预算读不出来时按"已超预算"处理。宁可少做一次策略反思，
      // 也不在成本护栏失效的窗口里继续调用 LLM。
      budgetExceeded = true
      console.error('[dsh-evolution-flywheel] 预算读取失败，本次跳过策略反思（fail-closed）：', error)
    }
    if (!budgetExceeded) {
      const disciplines = [...new Set(seeds.map(item => item.discipline).filter((value): value is string => value !== undefined))]
      const strategy = await hooks.reflect({
        stage: 'large',
        task: `大提炼：合并 ${seeds.length} 条跨学科洞察（学科：${disciplines.join(' / ') || '未记录'}）`,
        outcome: `生成思维模型：${model.name}｜机制：${model.pattern}｜适用：${model.appliesTo}`,
      })
      if (strategy !== undefined) outcome.strategy = strategy
      if (hooks.merge !== undefined) {
        const rule = await hooks.merge()
        if (rule !== undefined) outcome.rule = rule
      }
    }
  }
  return outcome
}

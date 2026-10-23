/**
 * 从跨学科 meta_insight 中提炼可迁移的思维模型候选。
 *
 * 只生成 suggested 记录；是否采纳仍由人类裁决。
 */
import type { MemoryContextBase } from './context.js'
import { complete } from './review-driver.js'
import { sanitizeText } from './sanitize.js'
import type { MemoryRecord, MemoryStore } from './store.js'

export interface DistilledModel {
  name: string
  pattern: string
  appliesTo: string
  counterexample: string
  sourceDisciplines: string
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
): Promise<MemoryRecord | undefined> {
  const items = await store.list()
  const seeds = items
    .filter(item => item.type === 'meta_insight'
      && (item.status === 'approved' || item.status === 'speculative'))
    .slice(0, 8)
  if (seeds.length < 2) return undefined
  const prompt = [
    '你是架构思维模型提炼器。下面是多次跨学科漫游产生的元认知洞察。',
    '请提炼 1 个可迁移的思维模型，必须能指导软件架构决策，不要复述单条洞察。',
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
    '你是严格的架构思维模型提炼器。只输出 JSON，不要输出 Markdown。',
    prompt,
    maxTokens,
  )
  const model = parseModel(completion.text)
  if (model === undefined) return undefined
  const existing = items.find(item => item.type === 'mental_model' && item.content.trim() === model.name)
  if (existing !== undefined) return existing
  const created = await store.appendSuggested(model.name, 'mental_model')
  if (created === undefined) return undefined
  return store.update(created.id, {
    metaInsight: model.pattern,
    resolution: model.appliesTo,
    context: model.counterexample,
    counterexample: model.counterexample,
    discipline: model.sourceDisciplines,
    sources: ['model-distill'],
    tokensUsed: completion.tokensUsed,
  })
}

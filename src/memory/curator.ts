/**
 * 整理 Agent（Curator）：把记忆池整理成一份给人类看的报告。
 *
 * 原则（按创世档案）：
 * - 只提议、不自动执行：归档/合并/遗忘都要人类批准；
 * - 否决必须给理由（API 层强制），理由写成负样本供下轮整理引用；
 * - 第一版是规则引擎 + 可选 LLM 摘要，不依赖模型也能给出报告；
 * - 单飞 + 预算门，后台运行不阻塞主会话。
 */
import { isFaded, memoryAgeDays, memoryFreshness, memorySalience } from './decay.js'
import { readBudget } from './budget.js'
import { complete } from './review-driver.js'
import type { MemoryContextBase } from './context.js'
import type { MemoryEventHub } from './events.js'
import type { MemoryRecord, MemoryStore } from './store.js'

import type { CurationItem, CurationQuality, CurationReportPayload, CurationTrigger } from './curation-shared.js'

export type { CurationItem, CurationQuality, CurationReportPayload, CurationTrigger } from './curation-shared.js'
export { parseCurationPayload } from './curation-shared.js'

const DAY_MS = 24 * 60 * 60 * 1000
const REJECTED_ARCHIVE_AFTER_DAYS = 30
const SIMILARITY_THRESHOLD = 0.72
const SIMILARITY_SCAN_LIMIT = 200

function excerpt(record: MemoryRecord): string {
  const text = record.errorSignature ?? record.content
  return text.replace(/\s+/gu, ' ').slice(0, 80)
}

function bigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const result = new Set<string>()
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2))
  }
  return result
}

/** 字符 bigram Jaccard 相似度：只用于“提议合并”，不作自动合并依据。 */
export function contentSimilarity(left: string, right: string): number {
  const leftSet = bigrams(left)
  const rightSet = bigrams(right)
  if (leftSet.size === 0 || rightSet.size === 0) return 0
  let intersection = 0
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1
  }
  return intersection / (leftSet.size + rightSet.size - intersection)
}

function similarGroups(active: readonly MemoryRecord[]): Array<{ ids: string[]; reason: string }> {
  const groups: Array<{ ids: string[]; reason: string }> = []
  const used = new Set<string>()
  const candidates = active
    .filter(item => item.status === 'approved' && item.content.trim() !== '')
    .slice(0, SIMILARITY_SCAN_LIMIT)
  for (let i = 0; i < candidates.length; i += 1) {
    const left = candidates[i]
    if (left === undefined || used.has(left.id)) continue
    for (let j = i + 1; j < candidates.length; j += 1) {
      const right = candidates[j]
      if (right === undefined || used.has(right.id)) continue
      if (left.type !== right.type) continue
      if (left.content.trim() === right.content.trim()) continue
      const score = contentSimilarity(left.content, right.content)
      if (score < SIMILARITY_THRESHOLD) continue
      used.add(left.id)
      used.add(right.id)
      groups.push({
        ids: [left.id, right.id],
        reason: `内容高度相似（${Math.round(score * 100)}%），需人工确认是否合并`,
      })
      break
    }
    if (groups.length >= 10) break
  }
  return groups
}

/** 已裁决报告的采纳率与最近否决理由：报告质量的唯一验收尺子。 */
export function summarizeCurationQuality(items: readonly MemoryRecord[]): CurationQuality {
  const reports = items.filter(item => item.type === 'curation_report')
  const approved = reports.filter(item => item.status === 'approved').length
  const rejected = reports.filter(item => item.status === 'rejected').length
  const pending = reports.length - approved - rejected
  const rejectionReasons = reports
    .filter(item => item.status === 'rejected')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(item => (item.trace ?? [])
      .filter(step => step.includes('理由：'))
      .at(-1) ?? '')
    .filter(reason => reason !== '')
    .slice(0, 5)
  const decided = approved + rejected
  return {
    approved,
    rejected,
    pending,
    total: reports.length,
    approvalRate: decided === 0 ? 0 : approved / decided,
    rejectionReasons,
  }
}

/** 纯规则生成报告；不调用 LLM，保证离线可用、零成本。 */
export function buildCurationReport(
  items: readonly MemoryRecord[],
  now = Date.now(),
  trigger: CurationTrigger = 'manual',
): CurationReportPayload {
  const active = items.filter(item => item.archived !== true)
  const keep: CurationItem[] = []
  const archive: CurationItem[] = []
  const highValue: CurationItem[] = []
  const duplicateGroups = new Map<string, string[]>()
  let fresh = 0
  let faded = 0
  let highSalience = 0

  for (const item of active) {
    const key = item.content.trim()
    if (key !== '') {
      const ids = duplicateGroups.get(key) ?? []
      ids.push(item.id)
      duplicateGroups.set(key, ids)
    }
    const salience = memorySalience(item)
    const isOld = isFaded(item, now)
    const retention = Math.round(memoryFreshness(item, now) * 100)
    if (isOld) faded += 1
    else fresh += 1
    if (salience >= 0.8) highSalience += 1

    // 分类互斥：高价值 > 归档候选 > 保留。
    if (salience >= 0.8 || (item.successCount ?? 0) >= 2 || (item.count ?? 0) >= 3) {
      highValue.push({
        id: item.id,
        content: excerpt(item),
        reason: `显著性 ${salience.toFixed(2)}（干预 ${item.humanInterventions ?? 0} 次 / 重复 ${item.count ?? 1} 次）`,
      })
      continue
    }
    if (isOld || (item.status === 'rejected' && memoryAgeDays(item, now) >= REJECTED_ARCHIVE_AFTER_DAYS)) {
      archive.push({
        id: item.id,
        content: excerpt(item),
        reason: isOld ? `保留率 ${retention}%，已褪色` : '已驳回且超过 30 天',
      })
      continue
    }
    keep.push({
      id: item.id,
      content: excerpt(item),
      reason: `保留率 ${retention}%，仍有效`,
    })
  }

  const exactMerge = [...duplicateGroups.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([content, ids]) => ({
      ids,
      reason: `内容完全重复：${content.slice(0, 60)}`,
    }))
  const merge = [...exactMerge, ...similarGroups(active)]

  const undecided = active.filter(item =>
    item.status === 'suggested' || item.status === 'staged' || item.status === 'under_review').length
  const risks: string[] = []
  if (faded > 0) risks.push(`${faded} 条记忆已褪色，建议确认后归档`)
  if (undecided > 0) risks.push(`${undecided} 条记忆尚未裁决，长期停留会稀释注意力`)
  if (active.length > 800) risks.push('记忆条数接近 1 MiB 文件上限，建议归档或导出')
  if (merge.length > 0) risks.push(`${merge.length} 组内容完全重复，建议合并`)

  const summary = `共 ${active.length} 条：保留 ${keep.length}，归档候选 ${archive.length}，高价值 ${highValue.length}，重复组 ${merge.length}，待裁决 ${undecided}。`
  return {
    trigger,
    generatedAt: new Date(now).toISOString(),
    total: active.length,
    keep,
    archive,
    highValue,
    merge,
    risks,
    stats: { fresh, faded, duplicates: merge.length, highSalience, undecided },
    quality: summarizeCurationQuality(items),
    summary,
  }
}

/** 阈值触发：距上次整理满 24h，且新增记忆 >= minNew 条。 */
export function shouldRunCuration(
  items: readonly MemoryRecord[],
  lastRunAt: number | undefined,
  now = Date.now(),
  minNew = 20,
  minIntervalMs = DAY_MS,
): boolean {
  if (lastRunAt !== undefined && now - lastRunAt < minIntervalMs) return false
  if (lastRunAt === undefined) return items.filter(item => item.archived !== true).length >= minNew
  const since = items.filter(item => {
    const created = Date.parse(item.createdAt)
    return Number.isFinite(created) && created > lastRunAt
  }).length
  return since >= minNew
}

/** 从报告 payload 中提取要归档的记忆 id。 */
export function archiveIdsOf(payload: CurationReportPayload): string[] {
  return [...new Set(payload.archive.map(item => item.id))]
}

/**
 * 可选的 LLM 审查摘要：只基于规则报告作判断，不编造记忆。
 * 预算耗尽、无 LLM 或失败时返回 undefined，调用方回退规则摘要。
 */
export async function summarizeCurationWithLlm(
  ctx: MemoryContextBase,
  store: MemoryStore,
  payload: CurationReportPayload,
  maxTokens = 400,
): Promise<{ text: string; tokensUsed: number } | undefined> {
  try {
    const budget = await readBudget(store)
    if (budget.exceeded) return undefined
    const lines = [
      `总数 ${payload.total}；保留 ${payload.keep.length}；归档候选 ${payload.archive.length}；高价值 ${payload.highValue.length}；重复组 ${payload.merge.length}；待裁决 ${payload.stats.undecided}。`,
      payload.archive.length === 0 ? '' : `归档候选：${payload.archive.slice(0, 5).map(item => item.content).join('；')}`,
      payload.highValue.length === 0 ? '' : `高价值：${payload.highValue.slice(0, 5).map(item => item.content).join('；')}`,
      payload.risks.length === 0 ? '' : `风险：${payload.risks.join('；')}`,
    ].filter(line => line !== '')
    const completion = await complete(
      ctx,
      '你是记忆整理器的审查者。只根据给定报告作判断，不编造新记忆；输出中文，120-200 字。',
      [
        '请审查这份记忆整理报告，给出：',
        '1. 最值得保留的 1-2 条及理由；',
        '2. 最该归档的 1-2 条及风险；',
        '3. 人类裁决时最该检查什么。',
        '',
        ...lines,
      ].join('\n'),
      maxTokens,
    )
    const text = completion.text.trim()
    if (text === '') return undefined
    return { text: text.slice(0, 800), tokensUsed: completion.tokensUsed }
  } catch (error) {
    console.error('[dsh-evolution-flywheel] curation LLM summary failed:', error)
    return undefined
  }
}



/**
 * 后台整理调度：每 30 分钟检查一次，满足阈值才生成报告。
 * 只生成待裁决报告，不自动归档；单飞保护，失败只写日志。
 */
export function registerCurationSchedule(
  ctx: MemoryContextBase,
  store: MemoryStore,
  events: MemoryEventHub,
  intervalMs = 30 * 60_000,
): void {
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    try {
      const items = await store.list()
      const last = items
        .filter(item => item.type === 'curation_report')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      const parsed = last === undefined ? Number.NaN : Date.parse(last.createdAt)
      if (!shouldRunCuration(items, Number.isFinite(parsed) ? parsed : undefined)) return
      running = true
      const payload = buildCurationReport(items, Date.now(), 'threshold')
      const llm = typeof ctx.get === 'function' && ctx.get('llm') !== undefined
        ? await summarizeCurationWithLlm(ctx, store, payload)
        : undefined
      if (llm !== undefined) payload.llmSummary = llm.text
      const created = await store.appendSuggested(`整理报告：${payload.summary}`, 'curation_report')
      if (created === undefined) return
      const updated = await store.update(created.id, {
        reportJson: JSON.stringify(payload),
        ...(llm === undefined ? {} : { reviewTokens: llm.tokensUsed }),
        origin: 'curation',
        originDetail: '后台自动整理（待人类裁决）',
        trace: [
          payload.summary,
          ...(llm === undefined ? [] : ['AI 审查摘要已生成']),
          ...payload.risks,
        ].slice(0, 10),
      })
      events.publish({ type: 'memory:added', item: updated ?? created })
    } catch (error) {
      console.error('[dsh-evolution-flywheel] curation schedule failed:', error)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => { void tick() }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    ctx.effect(() => () => clearInterval(timer))
  } catch {
    clearInterval(timer)
  }
}

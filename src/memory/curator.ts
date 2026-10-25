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

/**
 * 从错误上下文里提取定位指纹（文件路径或命令）。
 * 错误捕获类记忆的 content 会被归一成同一句话（「错误：FsError: ...」），
 * 真正区分场景的信息（哪个文件、哪条命令）只存在于 context 里。
 * 不提取它，「同一错误、不同场景」就会被误判成重复。
 */
export function errorLocator(context: string | undefined): string {
  if (context === undefined || context === '') return ''
  const match = /\{"(?:command|file_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(context)
  if (match === null) return ''
  const raw = match[1] ?? ''
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw.replace(/\\\\/gu, '\\')
  }
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
      // 同一错误落在不同文件/命令上 → 不同场景。合并会抹掉唯一的定位信息。
      const leftLocator = errorLocator(left.context)
      const rightLocator = errorLocator(right.context)
      if (leftLocator !== '' && rightLocator !== '' && leftLocator !== rightLocator) continue
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
  // key 带上定位指纹：content 相同但文件/命令不同，是不同场景，不能算重复。
  const duplicateGroups = new Map<string, { content: string; locator: string; ids: string[] }>()
  let fresh = 0
  let faded = 0
  let highSalience = 0

  for (const item of active) {
    const key = item.content.trim()
    if (key !== '') {
      const locator = errorLocator(item.context)
      const mapKey = `${key}@@${locator}`
      const group = duplicateGroups.get(mapKey) ?? { content: key, locator, ids: [] }
      group.ids.push(item.id)
      duplicateGroups.set(mapKey, group)
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

  const exactMerge = [...duplicateGroups.values()]
    .filter(group => group.ids.length >= 2)
    .map(group => ({
      ids: group.ids,
      reason: `内容完全重复${group.locator === '' ? '' : `（${group.locator}）`}：${group.content.slice(0, 60)}`,
    }))
  const merge = [...exactMerge, ...similarGroups(active)]

  const undecided = active.filter(item =>
    item.status === 'suggested' || item.status === 'staged' || item.status === 'under_review').length
  // 下钻（2026-10-25 反馈 P2）：只给「待裁决 N 条」用户不知道下一步做什么，
  // 这里拆成可行动的三类：待确认 / 待审阅 / 等圣裁（再分模型故障与真需判断）。
  const suggestedCount = active.filter(item => item.status === 'suggested').length
  const reviewCount = active.filter(item => item.status === 'staged' || item.status === 'under_review').length
  const humanItems = active.filter(item => item.status === 'human_intervention')
  const MODEL_FAILURE_REASON = /max-tokens|未输出正文|LLM 未返回 JSON|JSON 不完整|JSON 不是对象|Expected .*in JSON|连接中断/iu
  const modelFailureCount = humanItems.filter(item => MODEL_FAILURE_REASON.test(item.debateSummary ?? '')).length
  const needsHumanCount = humanItems.length - modelFailureCount
  const risks: string[] = []
  if (faded > 0) risks.push(`${faded} 条记忆已褪色，建议确认后归档`)
  if (undecided > 0) risks.push(`${undecided} 条记忆尚未裁决（待确认 ${suggestedCount} 条 / 待审阅 ${reviewCount} 条），长期停留会稀释注意力`)
  if (humanItems.length > 0) risks.push(`${humanItems.length} 条等待人类圣裁：其中 ${modelFailureCount} 条是模型故障遗留（可批量重试），${needsHumanCount} 条需要你亲自判断`)
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
 * 从审查摘要里提取「想问老板的问题」。
 * 格式不合法时返回 undefined——宁可没有探针，也不猜测模型意图。
 */
export function parseCurationProbe(text: string): { question: string; reason: string } | undefined {
  const question = /【想问】[ \t]*([^\n【]*)/u.exec(text)?.[1]?.trim() ?? ''
  if (question === '') return undefined
  // 明确表达「没有问题」时，不硬造一个探针——为了提问而提问只会稀释注意力。
  if (/^(无|没有|暂无|没有问题|（无）|\(无\)|none|n\/a)$/iu.test(question)) return undefined
  // 模型经常输出空的【原因】：匹配到空串时 ?? 默认值 不会生效，这里显式兜底。
  const reasonText = /【原因】[ \t]*([^\n【]*)/u.exec(text)?.[1]?.trim() ?? ''
  const reason = reasonText === '' ? '整理记忆时产生的疑问（模型未说明原因）' : reasonText
  return { question: question.slice(0, 120), reason: reason.slice(0, 120) }
}

/**
 * 整理时刻的证据包。
 *
 * 一句「完全重复的 6 组是否含差异」无法回答——因为人不知道是哪六组。
 * 这里把提问所依据的结构化数据一并带上，让问题可以被展开、被判断、被追问。
 */
export function buildProbeEvidence(
  payload: CurationReportPayload,
  items?: readonly MemoryRecord[],
): Record<string, unknown> {
  // 待裁决明细：只有列出具体条目，「76 + 12 是否超过 78」这类矛盾才能自证。
  const undecidedItems = (items ?? [])
    .filter(item => item.archived !== true
      && (item.status === 'suggested' || item.status === 'staged' || item.status === 'under_review'))
    .slice(0, 12)
    .map(item => ({
      id: item.id,
      type: item.type,
      excerpt: (item.errorSignature ?? item.content).replace(/\s+/gu, ' ').slice(0, 80),
    }))
  return {
    kind: 'curation',
    generatedAt: payload.generatedAt,
    total: payload.total,
    keepCount: payload.keep.length,
    undecided: payload.stats.undecided,
    undecidedItems,
    // 口径说明：分类维度与状态维度是两套尺子，数量相加没有意义。
    note: 'keep/archive/highValue 按显著性互斥分类；undecided 按 status 统计。两者是不同维度，会重叠，不能相加。',
    mergeGroups: payload.merge.slice(0, 8).map(group => ({
      count: group.ids.length,
      reason: group.reason,
      ids: group.ids,
    })),
    archiveCandidates: payload.archive.slice(0, 6).map(item => ({
      id: item.id,
      excerpt: item.content,
      reason: item.reason,
    })),
    highValue: payload.highValue.slice(0, 6).map(item => ({
      id: item.id,
      excerpt: item.content,
      reason: item.reason,
    })),
    risks: payload.risks,
  }
}

/**
 * 可选的 LLM 审查摘要：只基于规则报告作判断，不编造记忆。
 * 顺带给模型一个机会提出「想问老板的真问题」——整理时刻本就最清楚自己的盲区，
 * 在这里提问的边际成本只是几十个 token，不需要额外的唤醒。
 * 预算耗尽、无 LLM 或失败时返回 undefined，调用方回退规则摘要。
 */
export async function summarizeCurationWithLlm(
  ctx: MemoryContextBase,
  store: MemoryStore,
  payload: CurationReportPayload,
  // 思考型模型的 reasoning 也算进 maxTokens：实测一次整理要思考 5000+ 字，
  // 3000 会在正文之前就被截断。给足空间，正文才有机会出现。
  maxTokens = 8000,
): Promise<{ text: string; tokensUsed: number; probe?: { question: string; reason: string }; error?: string } | undefined> {
  try {
    const budget = await readBudget(store)
    if (budget.exceeded) {
      return { text: '', tokensUsed: 0, error: `每日预算已用完（今日 ${budget.todayTokens} / 上限 ${budget.dailyBudget}）` }
    }
    const lines = [
      `总数 ${payload.total}；保留 ${payload.keep.length}；归档候选 ${payload.archive.length}；高价值 ${payload.highValue.length}；重复组 ${payload.merge.length}；待裁决 ${payload.stats.undecided}。`,
      payload.archive.length === 0 ? '' : `归档候选：${payload.archive.slice(0, 5).map(item => `${item.content}（${item.reason}）`).join('；')}`,
      payload.highValue.length === 0 ? '' : `高价值：${payload.highValue.slice(0, 5).map(item => `${item.content}（${item.reason}）`).join('；')}`,
      payload.merge.length === 0 ? '' : `重复组：${payload.merge.slice(0, 5).map(group => `${group.ids.length} 条 · ${group.reason}`).join('；')}`,
      payload.risks.length === 0 ? '' : `风险：${payload.risks.join('；')}`,
    ].filter(line => line !== '')
    const completion = await complete(
      ctx,
      '你是记忆整理器的审查者。只根据给定报告作判断，不编造新记忆；输出中文。',
      [
        '请审查这份记忆整理报告，按以下格式输出：',
        '1. 最值得保留的 1-2 条及理由（60 字内）；',
        '2. 最该归档的 1-2 条及风险（60 字内）；',
        '3. 人类裁决时最该检查什么（40 字内）；',
        '',
        '最后另起两行，提一个你最想问老板的真问题。三条硬要求：',
        '· 必须指向具体的记忆内容、矛盾，或做决定时真正缺的那条信息；',
        '· 不要问「数量对不上」这类统计口径问题——那种问题自己查一下就知道，不值得占用人的注意力；',
        '· 如果这次确实没有值得问的，就输出【想问】无，不要为了提问而提问。',
        '【想问】<问题，30 字以内，或写「无」>',
        '【原因】<为什么问，30 字以内>',
        '',
        ...lines,
      ].join('\n'),
      maxTokens,
    )
    const raw = completion.text.trim()
    if (raw === '') return { text: '', tokensUsed: completion.tokensUsed, error: 'LLM 返回了空文本' }
    const probe = parseCurationProbe(raw)
    const stripped = probe === undefined ? raw : raw.replace(/【想问】[\s\S]*$/u, '').trim()
    return {
      text: (stripped === '' ? raw : stripped).slice(0, 800),
      tokensUsed: completion.tokensUsed,
      ...(probe === undefined ? {} : { probe }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[dsh-evolution-flywheel] curation LLM summary failed:', error)
    return { text: '', tokensUsed: 0, error: message }
  }
}

/**
 * 错误签名归一化：把路径、数字、引号内容替换为占位符。
 * 用于把「同一种错误、不同文件」聚成一组（2026-10-25 反馈 P1-1：
 * ReplaceFileW EIO 因路径不同被拆成 3 条，用户视角是同一个问题）。
 */
export function normalizeErrorSignature(value: string): string {
  return value
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/"[^"]*"/g, '<str>')
    .replace(/'[^']*'/g, '<str>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

export interface SimilarErrorGroup {
  /** 归一化后的签名（用于展示「这组是什么问题」）。 */
  signature: string
  ids: string[]
  excerpts: string[]
}

/** 按归一化签名把同类错误聚组；只读，合并不自动执行。 */
export function similarErrorGroups(items: readonly MemoryRecord[], minSize = 2): SimilarErrorGroup[] {
  const groups = new Map<string, SimilarErrorGroup>()
  for (const item of items) {
    if (item.archived === true) continue
    if (item.type !== 'skill_error_fix') continue
    const raw = item.errorSignature ?? item.content
    const signature = normalizeErrorSignature(raw)
    if (signature === '') continue
    // 归一化可能过度：`ToolError: <str>: <str>,` 这种只剩占位符的签名会把不同错误聚到一起。
    // 去掉占位符后信息量不足 8 个字符的，视为「太泛」不参与聚类。
    const informative = signature
      .replace(/^(?:Tool|Fs|ToolArgs|Web|Search|Agent)?(?:Error|Exception):\s*/iu, '')
      .replace(/<path>|<n>|<str>/gu, '')
      .replace(/[\s:,;()[\]{}"'`]+/gu, '')
    if (informative.length < 8) continue
    const group = groups.get(signature) ?? { signature, ids: [], excerpts: [] }
    group.ids.push(item.id)
    if (group.excerpts.length < 6) group.excerpts.push(raw.replace(/\s+/g, ' ').slice(0, 80))
    groups.set(signature, group)
  }
  return [...groups.values()].filter(group => group.ids.length >= minSize)
}

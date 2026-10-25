/**
 * 记忆控制台的纯逻辑：类型、标签、时间轴、辩论气泡与筛选。
 *
 * 从 client/index.ts 抽出的原因：这些逻辑需要独立单测，不依赖 React 渲染。
 */

export type FilterTab = 'all' | 'basic' | 'skill' | 'dma' | 'human' | 'debate' | 'audit' | 'model' | 'strategy' | 'curation' | 'probe'

export interface DebateRound {
  role: 'child' | 'mother'
  content: string
}

export interface MemoryItem {
  id: string
  content: string
  type: 'fact' | 'preference' | 'skill_error_fix' | 'conflict' | 'speculative' | 'meta_insight' | 'mental_model' | 'extraction_strategy' | 'curation_report' | 'cognitive_probe' | 'cognitive_brief'
  status:
    | 'suggested'
    | 'staged'
    | 'under_review'
    | 'debating'
    | 'approved'
    | 'rejected'
    | 'human_intervention'
    | 'speculative'
  createdAt: string
  errorSignature?: string
  context?: string
  resolution?: string
  /** 解法来源：inferred=模型推测（默认）；verified=人类确认或探针验证。 */
  resolutionSource?: 'inferred' | 'verified'
  reviewReason?: string
  debateSummary?: string
  metaInsight?: string
  counterexample?: string
  origin?: string
  originDetail?: string
  trace?: string[]
  humanDecision?: 'adopt' | 'discard'
  challenge?: string
  debateRounds?: DebateRound[]
  topic?: string
  discipline?: string
  sources?: string[]
  runId?: string
  tokensUsed?: number
  reviewRound?: number
  /** 提炼策略专属字段。 */
  thinkingModel?: string
  analogyReason?: string
  effectiveFor?: string
  strategyStage?: 'small' | 'large' | 'merge'
  successCount?: number
  failureCount?: number
  appliedCount?: number
  lastAppliedAt?: string
  rule?: boolean
  mergedFrom?: string[]
  confidence?: number
  lastSeenAt?: string
  lastRecalledAt?: string
  count?: number
  humanInterventions?: number
  verifiedAt?: string
  reportJson?: string
  archived?: boolean
  probeReason?: string
  probeState?: 'open' | 'answered' | 'searching' | 'ignored'
  answer?: string
  answeredAt?: string
  probeSource?: string
  /** 证据包 JSON：探针提问所依据的结构化上下文。 */
  probeContext?: string
  /** 对话线程 JSON：[{role,text,at}]，支持多轮追问。 */
  probeThread?: string
}

export interface TimelineNode {
  key: string
  title: string
  text: string
  tone?: string
}

export function memoryTypeLabel(type: MemoryItem['type']): string {
  if (type === 'skill_error_fix') return '排错经验'
  if (type === 'conflict') return '冲突提醒'
  if (type === 'speculative') return '漫游假想'
  if (type === 'meta_insight') return '元认知洞察'
  if (type === 'mental_model') return '思维模型'
  if (type === 'extraction_strategy') return '提炼策略'
  if (type === 'curation_report') return '整理报告'
  if (type === 'cognitive_probe') return '认知探针'
  if (type === 'cognitive_brief') return '认知简报'
  return type === 'fact' ? '事实' : '偏好'
}

/**
 * 跨学科洞察的五步「认知推导流水线」标签。
 * 与 Host 端 `DMA_INSIGHT_STEP_LABELS` 一一对应；别名用于兼容旧三段式数据与模型的轻微措辞漂移。
 * 顺序即推导顺序：原貌 -> 概括 -> 迁移 -> 代价 -> 人类启示。
 */
const INSIGHT_STEP_DEFS = [
  { key: 'origin', label: '学科知识原貌', aliases: ['学科知识原貌', '知识原貌', '学科原貌', '学科视角'] },
  { key: 'structure', label: '结构概括', aliases: ['结构概括', '底层逻辑', '运作机制'] },
  { key: 'mapping', label: '映射与套用', aliases: ['映射与套用', '映射套用', '映射迁移', '对进化插件'] },
  { key: 'tradeoff', label: '作用与代价', aliases: ['作用与代价', '代价与作用', 'trade-off', 'tradeoff', 'trade_off'] },
  { key: 'human', label: '人类启示', aliases: ['人类启示', '现实启示', '人类建议'] },
] as const

export type InsightStepKey = typeof INSIGHT_STEP_DEFS[number]['key']

export interface InsightStep {
  key: InsightStepKey
  /** 推导序号，从 1 开始。 */
  index: number
  /** 规范标签名（不含【】）。 */
  label: string
  /** 原文标签（含【】），用于界面上逐字高亮。 */
  tag: string
  text: string
}

export interface InsightBreakdown {
  steps: InsightStep[]
  /** 第一个标签之前的行（通常是 `[DMA 元认知] 标题`）。 */
  preamble: string
  /** 命中的步数。 */
  matched: number
  /** 是否足够当作「思维推导卡片」渲染；不足则回退纯文本。 */
  structured: boolean
}

const INSIGHT_TAG_RE = /【([^】\n]{1,40})】/gu
/** 卡片正文里的来源 footer：`\n来源：...`，解析时必须切掉，不能混进最后一步。 */
const INSIGHT_FOOTER_RE = /\n\s*(?:来源|参考|sources?)\s*[:：]/iu

/** 把模型可能写入的字面 `\n` 还原成真换行，再统一 CRLF。 */
function normalizeInsightContent(content: string): string {
  return content.replace(/\r\n?/gu, '\n').replace(/\\n/gu, '\n')
}

/** 清掉步骤正文的行首序号/项目符号与行尾空白。 */
function cleanInsightStepBody(body: string): string {
  const footer = body.search(INSIGHT_FOOTER_RE)
  const head = footer >= 0 ? body.slice(0, footer) : body
  return head
    .replace(/^\s*(?:[-*•·]|\d+[.、)．]|（\d+）|[一二三四五六七八九十]+[、.])\s*/u, '')
    // 模型偶尔写成 `**【标签】**：正文`，标签前后的 markdown 记号与冒号都要剥掉。
    .replace(/^[\s*_`~:：-]+/u, '')
    .replace(/[ \t]+$/gmu, '')
    // 切段按下一个标签的位置，正文尾部会残留「5. 」这类序号，必须一并清掉。
    .replace(/(?:\s*(?:\d+[.、)．]|（\d+）|[一二三四五六七八九十]+[、.]))?\s*$/u, '')
    .replace(/[\s*_`~]+$/u, '')
}

/**
 * 解析 meta_insight 正文为五步推导卡片数据。
 *
 * 解析基于标签位置而非行号：即使模型没换行、或在同一行里写满五步，也能切段。
 * 命中少于 3 步时 `structured = false`，由调用方回退纯文本，绝不丢内容。
 */
export function parseMetaInsight(content: string): InsightBreakdown {
  const text = normalizeInsightContent(content ?? '')
  const hits: Array<{ key: InsightStepKey; label: string; tag: string; start: number; end: number }> = []
  const seen = new Set<InsightStepKey>()

  INSIGHT_TAG_RE.lastIndex = 0
  for (;;) {
    const match = INSIGHT_TAG_RE.exec(text)
    if (match === null) break
    const raw = (match[1] ?? '').trim()
    if (raw === '') continue
    const def = INSIGHT_STEP_DEFS.find(item =>
      item.aliases.some(alias => raw.toLowerCase().includes(alias.toLowerCase())))
    if (def === undefined || seen.has(def.key)) continue
    seen.add(def.key)
    hits.push({
      key: def.key,
      label: def.label,
      tag: `【${raw}】`,
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  hits.sort((left, right) => left.start - right.start)
  const steps: InsightStep[] = hits.map((hit, index) => {
    const next = hits[index + 1]
    const body = text.slice(hit.end, next === undefined ? text.length : next.start)
    return {
      key: hit.key,
      index: index + 1,
      label: hit.label,
      tag: hit.tag,
      text: cleanInsightStepBody(body),
    }
  })
  const first = hits[0]
  // 一个标签都没命中时，整段文本就是 preamble：调用方回退纯文本时不会丢内容。
  const preamble = first === undefined
    ? text.trim()
    : cleanInsightStepBody(text.slice(0, first.start))

  return {
    steps,
    preamble,
    matched: steps.length,
    structured: steps.length >= 3,
  }
}

/** 把 ISO 时间格式化为可读的本地时间标签。 */
export function formatMemoryTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 来源标签；旧数据没有 origin 时回退到本地记忆。 */
export function originLabel(origin?: string): string {
  if (origin === 'error-capture') return '错误捕获'
  if (origin === 'dma') return '跨学科漫游'
  if (origin === 'model-distill') return '模型提炼'
  if (origin === 'strategy-reflection') return '提炼反思'
  if (origin === 'strategy-merge') return '策略融合'
  if (origin === 'curation') return '整理 Agent'
  if (origin === 'probe') return '认知探针'
  if (origin === 'browser-observer') return '浏览器动作'
  if (origin === 'manual') return '手动记录'
  return '本地记忆'
}

export function memoryStatusLabel(status: MemoryItem['status']): string {
  if (status === 'under_review') return '审核中'
  if (status === 'debating') return '对抗辩论中'
  if (status === 'human_intervention') return '请求人类圣裁'
  if (status === 'rejected') return '已丢弃'
  if (status === 'speculative') return '离线漫游'
  if (status === 'staged') return '待审核'
  if (status === 'suggested') return '待确认'
  if (status === 'approved') return '已生效'
  return String(status)
}

export function isMetaItem(item: MemoryItem): boolean {
  return item.type === 'meta_insight' || item.type === 'speculative'
}

export function normalizeMemoryStatus(status: unknown): MemoryItem['status'] {
  // 返回值也要 trim：下游按精确值比较状态，带空白的 'approved ' 会全部失配（F3）。
  return typeof status === 'string' && status.trim() !== ''
    ? status.trim() as MemoryItem['status']
    : 'suggested'
}

/** 由现有持久化字段还原四段式对抗时间轴；缺失字段如实标注，不虚构。 */
export function buildTimeline(item: MemoryItem): TimelineNode[] {
  // 与 hasDebateRecord 同源：非空 debateRounds 也算进入过辩论（F1），
  // 否则会出现「时间轴说没辩论、下方气泡在吵架」的自相矛盾。
  const hasRounds = item.debateRounds !== undefined && item.debateRounds.length > 0
  const hasDebate = hasRounds || item.debateSummary !== undefined || item.challenge !== undefined
  const submitted = item.errorSignature !== undefined
    ? `错误：${item.errorSignature}${item.context !== undefined ? `\n上下文：${item.context}` : ''}`
    : item.content
  const review = item.reviewReason ?? (hasDebate ? '驳回理由未记录' : '初审通过，未进入辩论')
  const challenge = item.challenge ?? (hasDebate
    ? `本轮反驳未单独记录，以下为辩论摘要：\n${item.debateSummary ?? (hasRounds ? '（逐轮记录见下方辩论对话）' : '（空）')}`
    : '未进入辩论')
  const verdict = item.status === 'human_intervention'
    ? '等待人类圣裁'
    : item.status === 'approved'
      ? item.humanDecision === 'adopt' ? '人类强制采纳，已生效' : '裁决通过，已生效'
      : item.status === 'rejected'
        ? item.humanDecision === 'discard' ? '人类强制驳回，已丢弃' : '裁决驳回，已丢弃'
        : memoryStatusLabel(item.status)
  return [
    { key: 'submit', title: '① 子 Agent 提交', text: submitted },
    { key: 'review', title: '② 母 Agent 初审', text: review },
    { key: 'challenge', title: '③ 子 Agent 顶嘴', text: challenge },
    {
      key: 'verdict',
      title: '④ 裁决',
      text: verdict,
      tone: item.status === 'human_intervention'
        ? '#d92d20'
        : item.status === 'rejected' ? '#6b7280' : '#15803d',
    },
  ]
}

export function hasDebateRecord(item: MemoryItem): boolean {
  // 空数组不算记录：buildDebateBubbles 对同一输入返回 []，两处必须同源（F2）。
  return (item.debateRounds !== undefined && item.debateRounds.length > 0)
    || item.challenge !== undefined
    || item.debateSummary !== undefined
    || item.status === 'debating'
    || item.status === 'human_intervention'
}

export function debateVerdictText(item: MemoryItem): string {
  if (item.status === 'human_intervention') return '未收敛 · 等待人类圣裁'
  if (item.status === 'debating') return '辩论进行中 · 等待母 Agent 回应'
  if (item.status === 'approved') {
    return item.humanDecision === 'adopt' ? '人类强制采纳 · 已生效' : '辩论收敛 · 裁决通过'
  }
  if (item.status === 'rejected') {
    return item.humanDecision === 'discard' ? '人类强制驳回 · 已丢弃' : '辩论收敛 · 裁决驳回'
  }
  return memoryStatusLabel(item.status)
}

/** 优先使用逐轮记录；旧数据只有 challenge 时降级为一条子 Agent 发言。 */
export function buildDebateBubbles(item: MemoryItem): DebateRound[] {
  if (item.debateRounds !== undefined && item.debateRounds.length > 0) return item.debateRounds
  if (item.challenge !== undefined) return [{ role: 'child', content: item.challenge }]
  return []
}

/** 列表筛选：Tab 命中 + 关键词（正文/类型标签/状态标签）。 */
export function matchesFilter(item: MemoryItem, tab: FilterTab, keyword: string): boolean {
  const tabMatch = tab === 'all'
    || (tab === 'basic' && (item.type === 'fact' || item.type === 'preference'))
    || (tab === 'skill' && item.type === 'skill_error_fix')
    || (tab === 'dma' && isMetaItem(item))
    || (tab === 'human' && item.status === 'human_intervention')
    || (tab === 'debate' && item.type === 'skill_error_fix' && hasDebateRecord(item))
    || (tab === 'model' && item.type === 'mental_model')
    || (tab === 'strategy' && item.type === 'extraction_strategy')
    || (tab === 'curation' && item.type === 'curation_report')
    || (tab === 'probe' && (item.type === 'cognitive_probe' || item.type === 'cognitive_brief'))
    || tab === 'audit'
  if (!tabMatch) return false
  if (keyword === '') return true
  return [
    item.content,
    memoryTypeLabel(item.type),
    memoryStatusLabel(item.status),
    item.createdAt,
    originLabel(item.origin),
    item.discipline ?? '',
    item.topic ?? '',
    item.thinkingModel ?? '',
    item.analogyReason ?? '',
    item.effectiveFor ?? '',
    item.resolution ?? '',
    item.errorSignature ?? '',
    item.context ?? '',
    item.reviewReason ?? '',
    item.debateSummary ?? '',
    item.challenge ?? '',
    item.strategyStage ?? '',
    item.rule === true ? '跨域映射法则 融合法则' : '',
    (item.mergedFrom ?? []).join(' '),
    item.reportJson ?? '',
    ...(item.trace ?? []),
    ...(item.sources ?? []),
  ].some(text => text.toLowerCase().includes(keyword))
}

export interface AuditVerdict {
  durability: 'long-term' | 'temporary'
  necessity: 'needed' | 'unneeded' | 'uncertain'
  reason: string
}

const TRANSIENT_ERROR = /vitest|test.*(failed|失败)|exit code|EPERM|Cannot find module|ConvertFrom-Json|thread-safe/iu

/** 规则自审计：只给建议，不自动删除。 */
export function auditItem(item: MemoryItem): AuditVerdict {
  if (item.status === 'rejected') {
    return { durability: 'temporary', necessity: 'unneeded', reason: '已被驳回，可归档或删除' }
  }
  if (item.type === 'preference' || item.type === 'fact') {
    return { durability: 'long-term', necessity: 'needed', reason: '偏好/事实类，长期有效' }
  }
  if (item.type === 'mental_model') {
    return item.status === 'approved'
      ? { durability: 'long-term', necessity: 'needed', reason: '已采纳的思维模型，可跨任务复用' }
      : { durability: 'temporary', necessity: 'uncertain', reason: '模型候选，待人类采纳' }
  }
  if (item.type === 'extraction_strategy') {
    if (item.rule === true) {
      return item.status === 'approved'
        ? { durability: 'long-term', necessity: 'needed', reason: '人类已裁决的跨域映射法则，以最高优先级注入' }
        : { durability: 'temporary', necessity: 'uncertain', reason: '融合法则候选，等待人类裁决' }
    }
    return item.status === 'approved'
      ? { durability: 'long-term', necessity: 'needed', reason: '已裁决的提炼方法论，可跨任务复用' }
      : { durability: 'temporary', necessity: 'uncertain', reason: '提炼方法论候选，仅试用注入，待人类裁决' }
  }
  if (item.type === 'curation_report') {
    return item.status === 'approved'
      ? { durability: 'temporary', necessity: 'uncertain', reason: '已执行的人类裁决报告，可归档备查' }
      : { durability: 'temporary', necessity: 'uncertain', reason: '整理报告待人类裁决，未执行归档' }
  }
  if (item.type === 'skill_error_fix') {
    if (item.status === 'human_intervention') {
      return { durability: 'temporary', necessity: 'uncertain', reason: '待人类裁决，暂不归类' }
    }
    if (item.status !== 'approved') {
      return { durability: 'temporary', necessity: 'uncertain', reason: '尚未确认，暂不归类' }
    }
    if (TRANSIENT_ERROR.test(item.errorSignature ?? item.content)) {
      return { durability: 'temporary', necessity: 'unneeded', reason: '测试/环境副产物，通常无需长期保留' }
    }
    if ((item.resolution ?? '').trim() === '') {
      return { durability: 'temporary', necessity: 'uncertain', reason: '缺少可执行解决办法' }
    }
    return { durability: 'long-term', necessity: 'needed', reason: '已确认的排错经验，含解决办法' }
  }
  if (item.type === 'speculative' || item.type === 'meta_insight') {
    return { durability: 'temporary', necessity: 'uncertain', reason: '漫游假想，需人工判断是否沉淀' }
  }
  return { durability: 'temporary', necessity: 'uncertain', reason: '未分类' }
}

export interface AuditSummary {
  longTerm: number
  temporary: number
  needed: number
  unneeded: number
  uncertain: number
}

export function auditSummary(items: readonly MemoryItem[]): AuditSummary {
  const summary: AuditSummary = { longTerm: 0, temporary: 0, needed: 0, unneeded: 0, uncertain: 0 }
  for (const item of items) {
    const verdict = auditItem(item)
    if (verdict.durability === 'long-term') summary.longTerm += 1
    else summary.temporary += 1
    if (verdict.necessity === 'needed') summary.needed += 1
    else if (verdict.necessity === 'unneeded') summary.unneeded += 1
    else summary.uncertain += 1
  }
  return summary
}

/** 各分区卡片数量，用于 Tab 徽标。 */
export function tabCounts(items: readonly MemoryItem[]): Record<FilterTab, number> {
  const counts: Record<FilterTab, number> = { all: 0, basic: 0, skill: 0, dma: 0, human: 0, debate: 0, audit: 0, model: 0, strategy: 0, curation: 0, probe: 0 }
  for (const item of items) {
    for (const tab of Object.keys(counts) as FilterTab[]) {
      if (matchesFilter(item, tab, '')) counts[tab] += 1
    }
  }
  return counts
}

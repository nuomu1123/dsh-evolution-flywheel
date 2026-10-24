/**
 * 记忆控制台的纯逻辑：类型、标签、时间轴、辩论气泡与筛选。
 *
 * 从 client/index.ts 抽出的原因：这些逻辑需要独立单测，不依赖 React 渲染。
 */

export type FilterTab = 'all' | 'basic' | 'skill' | 'dma' | 'human' | 'debate' | 'audit' | 'model' | 'strategy'

export interface DebateRound {
  role: 'child' | 'mother'
  content: string
}

export interface MemoryItem {
  id: string
  content: string
  type: 'fact' | 'preference' | 'skill_error_fix' | 'conflict' | 'speculative' | 'meta_insight' | 'mental_model' | 'extraction_strategy'
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
  return type === 'fact' ? '事实' : '偏好'
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
  return typeof status === 'string' && status.trim() !== ''
    ? status as MemoryItem['status']
    : 'suggested'
}

/** 由现有持久化字段还原四段式对抗时间轴；缺失字段如实标注，不虚构。 */
export function buildTimeline(item: MemoryItem): TimelineNode[] {
  const hasDebate = item.debateSummary !== undefined || item.challenge !== undefined
  const submitted = item.errorSignature !== undefined
    ? `错误：${item.errorSignature}${item.context !== undefined ? `\n上下文：${item.context}` : ''}`
    : item.content
  const review = item.reviewReason ?? (hasDebate ? '驳回理由未记录' : '初审通过，未进入辩论')
  const challenge = item.challenge ?? (hasDebate
    ? `本轮反驳未单独记录，以下为辩论摘要：\n${item.debateSummary ?? '（空）'}`
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
  return item.debateRounds !== undefined
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
    || tab === 'audit'
  if (!tabMatch) return false
  if (keyword === '') return true
  return item.content.toLowerCase().includes(keyword)
    || memoryTypeLabel(item.type).includes(keyword)
    || memoryStatusLabel(item.status).includes(keyword)
    || item.createdAt.toLowerCase().includes(keyword)
    || originLabel(item.origin).includes(keyword)
    || (item.discipline ?? '').toLowerCase().includes(keyword)
    || (item.topic ?? '').toLowerCase().includes(keyword)
    || (item.thinkingModel ?? '').toLowerCase().includes(keyword)
    || (item.analogyReason ?? '').toLowerCase().includes(keyword)
    || (item.effectiveFor ?? '').toLowerCase().includes(keyword)
    || (item.sources ?? []).some(source => source.toLowerCase().includes(keyword))
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
  const counts: Record<FilterTab, number> = { all: 0, basic: 0, skill: 0, dma: 0, human: 0, debate: 0, audit: 0, model: 0, strategy: 0 }
  for (const item of items) {
    for (const tab of Object.keys(counts) as FilterTab[]) {
      if (matchesFilter(item, tab, '')) counts[tab] += 1
    }
  }
  return counts
}

/**
 * 记忆存储：插件自己的 JSONL 文件，读取列表、追加草稿、确认与按 id 删除。
 *
 * 只读写 `$DSH_HOME/storages/dsh-memory-minimal/memories.jsonl`，
 * 不接触 profile、node_modules 或其他插件的数据。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { clampMetaInsight, sanitizeText } from './sanitize.js'

const sanitize = (value: unknown, maxLength = 1000): string =>
  sanitizeText(value, maxLength, '记忆写入')

/** 读取归一化时不写拦截日志，避免轮询把历史内容反复记成新事件。 */
const sanitizeQuiet = (value: unknown, maxLength = 1000): string =>
  sanitizeText(value, maxLength, '记忆读取', false)

export type MemoryType = 'fact' | 'preference' | 'skill_error_fix' | 'conflict' | 'speculative' | 'meta_insight' | 'mental_model' | 'extraction_strategy'
export type MemoryStatus =
  | 'suggested'
  | 'staged'
  | 'under_review'
  | 'debating'
  | 'approved'
  | 'rejected'
  | 'human_intervention'
  | 'speculative'

export type DebateRole = 'child' | 'mother'

export interface DebateRound {
  role: DebateRole
  content: string
}

export interface MemoryRecord {
  id: string
  content: string
  type: MemoryType
  status: MemoryStatus
  createdAt: string
  /** 排错经验的结构化字段。 */
  errorSignature?: string
  context?: string
  resolution?: string
  fingerprint?: string
  lastSeenAt?: string
  count?: number
  /** 母 Agent 初审理由。 */
  reviewReason?: string
  /** 对抗辩论摘要。 */
  debateSummary?: string
  /** 子 Agent 在对抗辩论中的反驳要点。 */
  challenge?: string
  /** 对抗辩论的逐轮发言。 */
  debateRounds?: DebateRound[]
  /** 辩论/裁决产生的元认知结论，硬限制 100 字。 */
  metaInsight?: string
  /** 思维模型的适用边界/反例。 */
  counterexample?: string
  /** 记忆来源：error-capture / dma / model-distill / manual。 */
  origin?: string
  /** 来源细节：工具、学科、会话等。 */
  originDetail?: string
  /** 提炼/写入过程，按步骤记录。 */
  trace?: string[]
  /** 辩论轮次（本实现固定 1 轮）。 */
  reviewRound?: number
  /** 人类圣裁结果。 */
  humanDecision?: 'adopt' | 'discard'
  /** 离线 DMA 漫游话题与来源。 */
  topic?: string
  /** 离线漫游命中的学科视角。 */
  discipline?: string
  sources?: string[]
  /** 同一次离线漫游共享的运行 id，用于 Token 账单去重。 */
  runId?: string
  /** 初审消耗的 token。 */
  reviewTokens?: number
  /** 辩论与申诉消耗的 token。 */
  debateTokens?: number
  /** 本次探索消耗的 token。 */
  tokensUsed?: number
  /** 提炼策略：本次提炼使用的思维模型（例如“系统韧性”“反馈回路”）。 */
  thinkingModel?: string
  /** 提炼策略：为什么这样类比（跨域映射的推理依据）。 */
  analogyReason?: string
  /** 提炼策略：这种提炼方法对哪类原始材料最有效。 */
  effectiveFor?: string
  /** 提炼策略的来源环节：small=四段式小提炼，large=睡眠巩固大提炼，merge=策略融合。 */
  strategyStage?: 'small' | 'large' | 'merge'
  /** 提炼策略：被成功采纳的次数（人类采纳或产出被采纳时累加）。 */
  successCount?: number
  /** 提炼策略：被判定失败的次数。 */
  failureCount?: number
  /** 提炼策略：被注入到下一次提炼提示词的次数。 */
  appliedCount?: number
  /** 提炼策略：最近一次被注入的时间。 */
  lastAppliedAt?: string
  /** 提炼策略：是否已进化为“跨域映射法则”（最高优先级）。 */
  rule?: boolean
  /** 提炼策略：融合来源的策略 id 列表。 */
  mergedFrom?: string[]
  /** 提炼策略：模型自评置信度（0-1）。 */
  confidence?: number
}

const MAX_FILE_BYTES = 1024 * 1024
const MAX_CONTENT_CHARS = 2000
const SKILL_DEBOUNCE_MS = 5 * 60 * 1000

export interface SkillErrorInput {
  errorSignature: string
  context: string
  resolution?: string
  fingerprint: string
}

export interface SkillCaptureResult {
  item: MemoryRecord
  created: boolean
}

function defaultDataDir(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-memory-minimal')
}

function seedRecords(): MemoryRecord[] {
  const now = Date.now()
  return [
    {
      id: 'seed-1',
      content: 'DSH 插件以单包、单 Loader entry 为最小可安装单元。',
      type: 'fact',
      status: 'approved',
      createdAt: new Date(now - 3 * 60_000).toISOString(),
    },
    {
      id: 'seed-2',
      content: '本地插件优先通过 link 安装；修改源码后需要重启或热加载生效。',
      type: 'preference',
      status: 'approved',
      createdAt: new Date(now - 2 * 60_000).toISOString(),
    },
    {
      id: 'seed-3',
      content: '删除记忆应持久化到本地 JSONL，刷新页面后不再出现。',
      type: 'fact',
      status: 'approved',
      createdAt: new Date(now - 60_000).toISOString(),
    },
    {
      id: 'seed-4',
      content: '界面文案使用中文，记忆列表按时间倒序展示。',
      type: 'preference',
      status: 'approved',
      createdAt: new Date(now).toISOString(),
    },
  ]
}

const MEMORY_TYPES: readonly MemoryType[] = [
  'fact',
  'preference',
  'skill_error_fix',
  'conflict',
  'speculative',
  'meta_insight',
  'mental_model',
  'extraction_strategy',
]
const MEMORY_STATUSES: readonly MemoryStatus[] = [
  'suggested',
  'staged',
  'under_review',
  'debating',
  'approved',
  'rejected',
  'human_intervention',
  'speculative',
]

function isRecord(value: unknown): value is MemoryRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && record.id.trim() !== ''
    && typeof record.content === 'string'
    && typeof record.type === 'string'
    && MEMORY_TYPES.includes(record.type as MemoryType)
    && typeof record.createdAt === 'string'
    && (record.status === undefined || MEMORY_STATUSES.includes(record.status as MemoryStatus))
}

function normalizeDebateRounds(value: unknown): DebateRound[] {
  if (!Array.isArray(value)) return []
  const rounds: DebateRound[] = []
  for (const entry of value.slice(0, 6)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { role?: unknown; content?: unknown }
    if (record.role !== 'child' && record.role !== 'mother') continue
    if (typeof record.content !== 'string') continue
    const content = sanitizeQuiet(record.content, 300)
    if (content !== '') rounds.push({ role: record.role, content })
  }
  return rounds
}

function normalizeRecord(value: MemoryRecord): MemoryRecord {
  return {
    id: value.id,
    content: value.content,
    type: value.type,
    status: MEMORY_STATUSES.includes(value.status) ? value.status : 'approved',
    createdAt: value.createdAt,
    ...(typeof value.errorSignature === 'string' ? { errorSignature: value.errorSignature } : {}),
    ...(typeof value.context === 'string' ? { context: value.context } : {}),
    ...(typeof value.resolution === 'string' ? { resolution: value.resolution } : {}),
    ...(typeof value.fingerprint === 'string' ? { fingerprint: value.fingerprint } : {}),
    ...(typeof value.lastSeenAt === 'string' ? { lastSeenAt: value.lastSeenAt } : {}),
    ...(typeof value.count === 'number' ? { count: value.count } : {}),
    ...(typeof value.reviewReason === 'string' ? { reviewReason: value.reviewReason } : {}),
    ...(typeof value.debateSummary === 'string' ? { debateSummary: value.debateSummary } : {}),
    ...(typeof value.challenge === 'string' ? { challenge: sanitizeQuiet(value.challenge, 300) } : {}),
    ...(Array.isArray(value.debateRounds) ? { debateRounds: normalizeDebateRounds(value.debateRounds) } : {}),
    ...(typeof value.metaInsight === 'string' ? { metaInsight: sanitizeQuiet(value.metaInsight, 100) } : {}),
    ...(typeof value.counterexample === 'string' ? { counterexample: sanitizeQuiet(value.counterexample, 500) } : {}),
    ...(typeof value.origin === 'string'
      ? { origin: sanitizeQuiet(value.origin, 60) }
      : { origin: value.type === 'mental_model' ? 'model-distill' : value.type === 'meta_insight' ? 'dma' : value.type === 'skill_error_fix' ? 'error-capture' : 'manual' }),
    ...(typeof value.originDetail === 'string' ? { originDetail: sanitizeQuiet(value.originDetail, 300) } : {}),
    ...(Array.isArray(value.trace)
      ? { trace: value.trace.filter((step): step is string => typeof step === 'string').slice(0, 10) }
      : {}),
    ...(typeof value.reviewRound === 'number' ? { reviewRound: value.reviewRound } : {}),
    ...(value.humanDecision === 'adopt' || value.humanDecision === 'discard'
      ? { humanDecision: value.humanDecision }
      : {}),
    ...(typeof value.topic === 'string' ? { topic: sanitizeQuiet(value.topic, 300) } : {}),
    ...(typeof value.discipline === 'string' ? { discipline: sanitizeQuiet(value.discipline, 120) } : {}),
    ...(Array.isArray(value.sources)
      ? { sources: value.sources.filter((source): source is string => typeof source === 'string').slice(0, 10) }
      : {}),
    ...(typeof value.runId === 'string' && value.runId.trim() !== ''
      ? { runId: value.runId.trim().slice(0, 100) }
      : {}),
    ...(typeof value.reviewTokens === 'number' ? { reviewTokens: value.reviewTokens } : {}),
    ...(typeof value.debateTokens === 'number' ? { debateTokens: value.debateTokens } : {}),
    ...(typeof value.tokensUsed === 'number' ? { tokensUsed: value.tokensUsed } : {}),
    ...(typeof value.thinkingModel === 'string' ? { thinkingModel: sanitizeQuiet(value.thinkingModel, 120) } : {}),
    ...(typeof value.analogyReason === 'string' ? { analogyReason: sanitizeQuiet(value.analogyReason, 500) } : {}),
    ...(typeof value.effectiveFor === 'string' ? { effectiveFor: sanitizeQuiet(value.effectiveFor, 300) } : {}),
    ...(value.strategyStage === 'small' || value.strategyStage === 'large' || value.strategyStage === 'merge'
      ? { strategyStage: value.strategyStage }
      : {}),
    ...(typeof value.successCount === 'number' ? { successCount: Math.max(0, Math.trunc(value.successCount)) } : {}),
    ...(typeof value.failureCount === 'number' ? { failureCount: Math.max(0, Math.trunc(value.failureCount)) } : {}),
    ...(typeof value.appliedCount === 'number' ? { appliedCount: Math.max(0, Math.trunc(value.appliedCount)) } : {}),
    ...(typeof value.lastAppliedAt === 'string' ? { lastAppliedAt: value.lastAppliedAt } : {}),
    ...(value.rule === true ? { rule: true } : {}),
    ...(Array.isArray(value.mergedFrom)
      ? { mergedFrom: value.mergedFrom.filter((id): id is string => typeof id === 'string').slice(0, 12) }
      : {}),
    ...(typeof value.confidence === 'number'
      ? { confidence: Math.max(0, Math.min(1, value.confidence)) }
      : {}),
  }
}

/** 串行写入队列：所有 fs 写入都必须经过它。 */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private active = 0

  get busy(): boolean {
    return this.active > 0
  }

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.active += 1
    const next = this.tail.then(job, job)
    this.tail = next.then(() => undefined, () => undefined)
    return next.finally(() => {
      this.active -= 1
    })
  }
}

export class MemoryStore {
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()
  private readonly writes = new WriteQueue()

  constructor(dataDir: string = defaultDataDir()) {
    this.file = join(dataDir, 'memories.jsonl')
  }

  get writeQueueBusy(): boolean {
    return this.writes.busy
  }

  /** 读取全部记忆；首次读取时写入种子数据。 */
  list(): Promise<MemoryRecord[]> {
    return this.runExclusive(async () => {
      await this.ensureSeeded()
      return this.readAll()
    })
  }

  /**
   * 追加一条待确认草稿。相同内容已存在时不重复写入。
   * @param content 候选记忆文本。
   * @param type 记忆类型。
   * @returns 新记录；重复或空内容返回 undefined。
   */
  appendSuggested(content: string, type: MemoryType): Promise<MemoryRecord | undefined> {
    const text = sanitize(content, MAX_CONTENT_CHARS)
    if (text === '') return Promise.resolve(undefined)
    return this.runExclusive(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      if (items.some(item => item.content.trim() === text)) return undefined
      const record: MemoryRecord = {
        id: `mem-${randomUUID()}`,
        content: text,
        type,
        status: 'suggested',
        createdAt: new Date().toISOString(),
      }
      await this.writeAll([record, ...items])
      return record
    })
  }

  /** 把一条记忆从 suggested 改为 approved；已 approved 时原样返回。 */
  approve(id: string): Promise<MemoryRecord | undefined> {
    const key = id.trim()
    if (key === '') return Promise.resolve(undefined)
    return this.runExclusive(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      const index = items.findIndex(item => item.id === key)
      if (index < 0) return undefined
      const current = items[index]
      if (current === undefined) return undefined
      if (current.status === 'approved') return current
      // 只允许从待确认状态批准；human_intervention 必须走 humanDecide，避免绕过人类裁决。
      if (current.status !== 'suggested' && current.status !== 'staged' && current.status !== 'speculative') {
        return undefined
      }
      const updated: MemoryRecord = {
        ...current,
        status: 'approved',
        ...(current.type === 'extraction_strategy'
          ? { successCount: (current.successCount ?? 0) + 1 }
          : {}),
      }
      const next = [...items]
      next[index] = updated
      await this.writeAll(next)
      return updated
    })
  }

  /**
   * 捕获一条排错经验。相同 fingerprint 在 5 分钟内只记录一次；
   * 超过窗口后更新已有记录的 lastSeenAt/count，而不是无限追加。
   */
  captureSkillError(input: SkillErrorInput): Promise<SkillCaptureResult | undefined> {
    const fingerprint = input.fingerprint.trim()
    const errorSignature = sanitize(input.errorSignature, 300)
    const context = sanitize(input.context, 500) || '未记录任务上下文'
    const resolution = input.resolution === undefined ? undefined : sanitize(input.resolution, 1000)
    if (fingerprint === '' || errorSignature === '') return Promise.resolve(undefined)
    return this.runExclusive(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      const index = items.findIndex(item => item.type === 'skill_error_fix' && item.fingerprint === fingerprint)
      const now = Date.now()
      const nowIso = new Date(now).toISOString()
      if (index >= 0) {
        const existing = items[index]
        if (existing === undefined) return undefined
        const last = Date.parse(existing.lastSeenAt ?? existing.createdAt)
        if (Number.isFinite(last) && now - last < SKILL_DEBOUNCE_MS) return undefined
        const updated: MemoryRecord = {
          ...existing,
          lastSeenAt: nowIso,
          count: (existing.count ?? 0) + 1,
          ...(existing.resolution === undefined && resolution !== undefined && resolution !== ''
            ? { resolution }
            : {}),
        }
        const next = [...items]
        next[index] = updated
        await this.writeAll(next)
        return { item: updated, created: false }
      }
      const record: MemoryRecord = {
        id: `mem-${randomUUID()}`,
        content: `错误：${errorSignature}`,
        type: 'skill_error_fix',
        status: 'staged',
        createdAt: nowIso,
        lastSeenAt: nowIso,
        count: 1,
        errorSignature,
        context,
        fingerprint,
        ...(resolution !== undefined && resolution !== ''
          ? { resolution }
          : {}),
        origin: 'error-capture',
        originDetail: '工具错误',
        trace: [
          '工具错误捕获',
          `指纹：${fingerprint.slice(0, 80)}`,
          `上下文：${context.slice(0, 120)}`,
        ],
      }
      await this.writeAll([record, ...items])
      return { item: record, created: true }
    })
  }

  /** 给已有的排错经验补充解决办法；返回更新后的记录。 */
  attachResolution(fingerprint: string, resolution: string): Promise<MemoryRecord | undefined> {
    const key = fingerprint.trim()
    const text = resolution.trim().slice(0, 1000)
    if (key === '' || text === '') return Promise.resolve(undefined)
    return this.runExclusive(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      const index = items.findIndex(item =>
        item.type === 'skill_error_fix'
        && item.fingerprint === key
        && (item.resolution === undefined || item.resolution.trim() === ''))
      if (index < 0) return undefined
      const current = items[index]
      if (current === undefined) return undefined
      const updated: MemoryRecord = { ...current, resolution: text }
      const next = [...items]
      next[index] = updated
      await this.writeAll(next)
      return updated
    })
  }

  /** 按记忆 id 设置/清空解决办法；返回更新后的记录。 */
  setResolution(id: string, resolution: string): Promise<MemoryRecord | undefined> {
    const key = id.trim()
    if (key === '') return Promise.resolve(undefined)
    const text = resolution.trim().slice(0, 1000)
    return this.runExclusive(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      const index = items.findIndex(item => item.id === key)
      if (index < 0) return undefined
      const current = items[index]
      if (current === undefined) return undefined
      const { resolution: _previous, ...rest } = current
      const updated: MemoryRecord = text === '' ? rest : { ...rest, resolution: text }
      const next = [...items]
      next[index] = updated
      await this.writeAll(next)
      return updated
    })
  }

  /** 按 id 更新状态机字段；所有文本再次消毒。 */
  update(
    id: string,
    patch: Partial<Omit<MemoryRecord, 'id' | 'createdAt'>>,
  ): Promise<MemoryRecord | undefined> {
    const key = id.trim()
    if (key === '') return Promise.resolve(undefined)
    if (patch.status !== undefined && !MEMORY_STATUSES.includes(patch.status)) {
      return Promise.reject(new Error(`invalid memory status: ${patch.status}`))
    }
    return this.runExclusive(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      const index = items.findIndex(item => item.id === key)
      if (index < 0) return undefined
      const current = items[index]
      if (current === undefined) return undefined
      const updated: MemoryRecord = {
        ...current,
        ...(patch.content !== undefined ? { content: sanitize(patch.content, MAX_CONTENT_CHARS) } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.errorSignature !== undefined ? { errorSignature: sanitize(patch.errorSignature, 300) } : {}),
        ...(patch.context !== undefined ? { context: sanitize(patch.context, 500) } : {}),
        ...(patch.resolution !== undefined ? { resolution: sanitize(patch.resolution, 1000) } : {}),
        ...(patch.reviewReason !== undefined ? { reviewReason: sanitize(patch.reviewReason, 500) } : {}),
        ...(patch.debateSummary !== undefined ? { debateSummary: sanitize(patch.debateSummary, 800) } : {}),
        ...(patch.challenge !== undefined ? { challenge: sanitize(patch.challenge, 300) } : {}),
        ...(Array.isArray(patch.debateRounds) ? { debateRounds: normalizeDebateRounds(patch.debateRounds) } : {}),
        ...(patch.metaInsight !== undefined ? { metaInsight: clampMetaInsight(patch.metaInsight) } : {}),
        ...(patch.counterexample !== undefined ? { counterexample: sanitize(patch.counterexample, 500) } : {}),
        ...(patch.origin !== undefined ? { origin: sanitize(patch.origin, 60) } : {}),
        ...(patch.originDetail !== undefined ? { originDetail: sanitize(patch.originDetail, 300) } : {}),
        ...(Array.isArray(patch.trace)
          ? { trace: patch.trace.filter((step): step is string => typeof step === 'string').slice(0, 10) }
          : {}),
        ...(patch.topic !== undefined ? { topic: sanitize(patch.topic, 300) } : {}),
        ...(patch.discipline !== undefined ? { discipline: sanitize(patch.discipline, 120) } : {}),
        ...(Array.isArray(patch.sources)
          ? { sources: patch.sources.filter((source): source is string => typeof source === 'string').slice(0, 10) }
          : {}),
        ...(patch.reviewRound !== undefined ? { reviewRound: patch.reviewRound } : {}),
        ...(patch.humanDecision !== undefined ? { humanDecision: patch.humanDecision } : {}),
        ...(patch.fingerprint !== undefined ? { fingerprint: patch.fingerprint.trim() } : {}),
        ...(patch.lastSeenAt !== undefined ? { lastSeenAt: patch.lastSeenAt } : {}),
        ...(patch.count !== undefined ? { count: patch.count } : {}),
        ...(patch.reviewTokens !== undefined ? { reviewTokens: patch.reviewTokens } : {}),
        ...(patch.debateTokens !== undefined ? { debateTokens: patch.debateTokens } : {}),
        ...(patch.tokensUsed !== undefined ? { tokensUsed: Math.max(0, Math.trunc(patch.tokensUsed)) } : {}),
        ...(patch.runId !== undefined ? { runId: sanitize(patch.runId, 100) } : {}),
        ...(patch.thinkingModel !== undefined ? { thinkingModel: sanitize(patch.thinkingModel, 120) } : {}),
        ...(patch.analogyReason !== undefined ? { analogyReason: sanitize(patch.analogyReason, 500) } : {}),
        ...(patch.effectiveFor !== undefined ? { effectiveFor: sanitize(patch.effectiveFor, 300) } : {}),
        ...(patch.strategyStage !== undefined ? { strategyStage: patch.strategyStage } : {}),
        ...(patch.successCount !== undefined ? { successCount: Math.max(0, Math.trunc(patch.successCount)) } : {}),
        ...(patch.failureCount !== undefined ? { failureCount: Math.max(0, Math.trunc(patch.failureCount)) } : {}),
        ...(patch.appliedCount !== undefined ? { appliedCount: Math.max(0, Math.trunc(patch.appliedCount)) } : {}),
        ...(patch.lastAppliedAt !== undefined ? { lastAppliedAt: patch.lastAppliedAt } : {}),
        ...(patch.rule !== undefined ? { rule: patch.rule } : {}),
        ...(Array.isArray(patch.mergedFrom)
          ? { mergedFrom: patch.mergedFrom.filter((id): id is string => typeof id === 'string').slice(0, 12) }
          : {}),
        ...(patch.confidence !== undefined
          ? { confidence: Math.max(0, Math.min(1, patch.confidence)) }
          : {}),
      }
      const next = [...items]
      next[index] = updated
      await this.writeAll(next)
      return updated
    })
  }

  /**
   * 记录策略被注入：appliedCount+1、lastAppliedAt=now。
   * 只触碰 extraction_strategy，其他类型即使传错 id 也不会被修改。
   */
  touchStrategies(ids: readonly string[]): Promise<MemoryRecord[]> {
    const keys = [...new Set(ids.map(id => id.trim()).filter(id => id !== ''))]
    if (keys.length === 0) return Promise.resolve([])
    return this.runExclusive(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      const now = new Date().toISOString()
      const touched: MemoryRecord[] = []
      const next = items.map(item => {
        if (item.type !== 'extraction_strategy' || !keys.includes(item.id)) return item
        const updated: MemoryRecord = {
          ...item,
          appliedCount: (item.appliedCount ?? 0) + 1,
          lastAppliedAt: now,
          trace: [...(item.trace ?? []), `第 ${(item.appliedCount ?? 0) + 1} 次被注入（${now}）`].slice(-10),
        }
        touched.push(updated)
        return updated
      })
      if (touched.length > 0) await this.writeAll(next)
      return touched
    })
  }

  /** 只读检索，供离线探索 Agent 的 memory_search 使用。 */
  search(query: string, limit = 10): Promise<MemoryRecord[]> {
    const text = query.trim().toLowerCase()
    if (text === '') return Promise.resolve([])
    return this.runExclusive(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      return items
        .filter(item => [
          item.content,
          item.resolution ?? '',
          item.context ?? '',
          item.errorSignature ?? '',
        ].some(field => field.toLowerCase().includes(text)))
        .slice(0, Math.max(1, Math.min(50, limit)))
    })
  }

  /** 离线 DMA 只能调用这里：永远只追加 speculative 元认知卡片。 */
  appendSpeculative(input: {
    title: string
    insight: string
    topic?: string
    discipline?: string
    sources?: readonly string[]
    runId?: string
    tokensUsed?: number
    origin?: string
    originDetail?: string
    trace?: readonly string[]
  }): Promise<MemoryRecord | undefined> {
    const title = sanitize(input.title, 120)
    const insight = sanitize(input.insight, 2000)
    if (insight === '') return Promise.resolve(undefined)
    const sources = (input.sources ?? [])
      .map(source => sanitize(source, 500))
      .filter(source => source !== '')
      .slice(0, 10)
    const content = [
      `[DMA 元认知] ${title || '离线探索'}`,
      insight,
      ...(sources.length > 0 ? [`来源：${sources.join(' | ')}`] : []),
    ].join('\n')
    return this.runExclusive(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      if (items.some(item => item.type === 'meta_insight' && item.content === content)) return undefined
      const record: MemoryRecord = {
        id: `mem-${randomUUID()}`,
        content,
        type: 'meta_insight',
        status: 'speculative',
        createdAt: new Date().toISOString(),
        ...(input.topic !== undefined ? { topic: sanitize(input.topic, 300) } : {}),
        ...(input.discipline !== undefined ? { discipline: sanitize(input.discipline, 120) } : {}),
        ...(sources.length > 0 ? { sources } : {}),
        ...(input.runId !== undefined && input.runId.trim() !== ''
          ? { runId: input.runId.trim().slice(0, 100) }
          : {}),
        ...(input.tokensUsed !== undefined ? { tokensUsed: input.tokensUsed } : {}),
        origin: input.origin ?? 'dma',
        ...(input.originDetail !== undefined ? { originDetail: sanitize(input.originDetail, 300) } : {}),
        ...(input.trace !== undefined && input.trace.length > 0
          ? {
            trace: input.trace
              .map(step => sanitize(step, 200))
              .filter(step => step !== '')
              .slice(0, 10),
          }
          : {}),
      }
      await this.writeAll([record, ...items])
      return record
    })
  }

  /** 按 id 删除；返回是否真的删掉了一条。 */
  delete(id: string): Promise<boolean> {
    const key = id.trim()
    if (key === '') return Promise.resolve(false)
    return this.runExclusive(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      const next = items.filter(item => item.id !== key)
      if (next.length === items.length) return false
      await this.writeAll(next)
      return true
    })
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async ensureSeeded(): Promise<void> {
    try {
      await stat(this.file)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await this.writeAll(seedRecords())
  }

  private async readAll(): Promise<MemoryRecord[]> {
    const text = await readFile(this.file, 'utf8')
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
      throw new Error('memory file exceeds 1 MiB limit')
    }
    const items: MemoryRecord[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const value: unknown = JSON.parse(trimmed)
        if (isRecord(value)) items.push(normalizeRecord(value))
      } catch {
        // 跳过损坏行，避免单条坏数据拖垮列表。
      }
    }
    return items.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  private writeAll(items: readonly MemoryRecord[]): Promise<void> {
    return this.writes.enqueue(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const text = items.map(item => JSON.stringify(item)).join('\n')
      // 先写临时文件再 rename，避免崩溃或断电留下半行/空文件。
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, text === '' ? '' : `${text}\n`, 'utf8')
      await rename(temp, this.file)
    })
  }
}

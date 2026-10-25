/**
 * 记忆存储：插件自己的 JSONL 文件，读取列表、追加草稿、确认与按 id 删除。
 *
 * 只读写 `$DSH_HOME/storages/dsh-memory-minimal/memories.jsonl`，
 * 不接触 profile、node_modules 或其他插件的数据。
 */
import { randomUUID } from 'node:crypto'
import { appendFile, link, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { clampMetaInsight, sanitizeText, scrubControlChars } from './sanitize.js'

const sanitize = (value: unknown, maxLength = 1000): string =>
  sanitizeText(value, maxLength, '记忆写入')

/** 读取归一化时不写拦截日志，避免轮询把历史内容反复记成新事件。 */
const sanitizeQuiet = (value: unknown, maxLength = 1000): string =>
  sanitizeText(value, maxLength, '记忆读取', false)

/**
 * 结构化 JSON 字段不能用文本截断：`slice(...,N)` 会把 JSON 切成非法串，
 * 下游 `JSON.parse` 一失败，整段数据就静默消失（整理报告 reportJson、追问历史 probeThread 都踩过）。
 * 这里先解析、再按结构裁剪，保证落库的仍是合法 JSON；坏 JSON 明确标记而不是原样保留。
 */
export function clampJsonField(value: string, maxLength: number, keep: 'head' | 'tail' = 'head'): string {
  const text = value.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return JSON.stringify({ truncated: true, reason: 'invalid-json', length: text.length })
  }
  const full = JSON.stringify(parsed)
  if (full.length <= maxLength) return full
  // 数组：对话/列表类保留更新的一段（keep=tail 时丢最早的）。
  if (Array.isArray(parsed)) {
    let kept = parsed
    while (kept.length > 0 && JSON.stringify(kept).length > maxLength) {
      kept = keep === 'tail' ? kept.slice(1) : kept.slice(0, -1)
    }
    return JSON.stringify(kept)
  }
  // 对象：从最大的字段开始砍半，直到放得下。
  if (typeof parsed === 'object' && parsed !== null) {
    const record: Record<string, unknown> = { ...(parsed as Record<string, unknown>) }
    const keys = Object.keys(record).sort(
      (left, right) =>
        JSON.stringify(record[right] ?? null).length - JSON.stringify(record[left] ?? null).length,
    )
    for (const key of keys) {
      if (JSON.stringify(record).length <= maxLength) break
      const item = record[key]
      if (Array.isArray(item)) record[key] = item.slice(0, Math.max(1, Math.floor(item.length / 2)))
      else if (typeof item === 'string') record[key] = item.slice(0, Math.max(120, Math.floor(item.length / 2)))
    }
    if (JSON.stringify(record).length <= maxLength) return JSON.stringify(record)
    return JSON.stringify({ truncated: true, reason: 'too-large', length: text.length })
  }
  return JSON.stringify({ truncated: true, reason: 'too-large', length: text.length })
}

export type MemoryType = 'fact' | 'preference' | 'skill_error_fix' | 'conflict' | 'speculative' | 'meta_insight' | 'mental_model' | 'extraction_strategy' | 'curation_report' | 'cognitive_probe' | 'cognitive_brief'
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
  /** resolution 的来源：inferred=模型推测未验证；verified=人类确认、探针验证或实测有效。 */
  resolutionSource?: 'inferred' | 'verified'
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
  /** 共享世界模型作用域：global=统一记忆池（默认）；main/sub 预留给未来分区。 */
  scope?: 'global' | 'main' | 'sub'
  /** 最近一次被召回注入的时间（遗忘曲线基准）。 */
  lastRecalledAt?: string
  /** 最近一次被主动探针验证的时间。 */
  verifiedAt?: string
  /** 进入人类裁决的次数（显著性来源）。 */
  humanInterventions?: number
  /** 已归档：保留在库里、可从界面检索，但不再进入系统提示。 */
  archived?: boolean
  /** 整理报告的结构化 JSON（仅 curation_report 使用）。 */
  reportJson?: string
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
  /** 认知探针：提问原因（基于哪段记忆/哪次漫游）。 */
  probeReason?: string
  /** 认知探针状态：open=待人类回答，answered=已回答，searching=已授权 DMA 搜索，ignored=跳过。 */
  probeState?: 'open' | 'answered' | 'searching' | 'ignored'
  /** 人类对探针的回答。 */
  answer?: string
  /** 回答时间。 */
  answeredAt?: string
  /** 探针来源：model-distill / dma / manual / curation。 */
  probeSource?: string
  /** 探针证据包（JSON）：提问所依据的结构化上下文，让人能展开判断而不是瞎答。 */
  probeContext?: string
  /** 探针对话线程（JSON 数组 [{role,text,at}]）：支持多轮追问，而不只是一问一答。 */
  probeThread?: string
}

/** 共享世界模型的变更事件：任何 Agent 写入后立即广播，保证秒级同步。 */
export type SharedWorldEvent =
  | { type: 'memory:added'; item: MemoryRecord }
  | { type: 'memory:updated'; item: MemoryRecord }
  | { type: 'memory:removed'; id: string }

export type SharedWorldListener = (event: SharedWorldEvent) => void

const MAX_FILE_BYTES = 1024 * 1024
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 3_000

/**
 * 跨进程写锁：用 `memories.jsonl.lock` 串行化“读 → 改 → 写”，
 * 防止旧插件或第二个进程同时写同一文件时互相覆盖。
 * 锁文件超过 30 秒视为进程崩溃后的残留，自动清理重试。
 */
async function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const lockFile = `${file}.lock`
  const started = Date.now()
  for (;;) {
    try {
      const handle = await open(lockFile, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')
        return await task()
      } finally {
        await handle.close().catch(() => {})
        await rm(lockFile, { force: true }).catch(() => {})
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const info = await stat(lockFile)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockFile, { force: true }).catch(() => {})
          continue
        }
      } catch {
        continue
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error('memory store is locked by another process')
      }
      await new Promise(resolve => setTimeout(resolve, 40 + Math.random() * 60))
    }
  }
}
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
  'curation_report',
  'cognitive_probe',
  'cognitive_brief',
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
    // 读路径只去掉控制/零宽字符，不做注入文案替换（否则会误伤技术文本）。
    content: scrubControlChars(value.content),
    type: value.type,
    // fail-safe：缺 status/非法 status 不能默认 approved（否则残缺数据会直接进注入池）。
    status: MEMORY_STATUSES.includes(value.status) ? value.status : 'suggested',
    createdAt: value.createdAt,
    ...(typeof value.errorSignature === 'string' ? { errorSignature: value.errorSignature } : {}),
    ...(typeof value.context === 'string' ? { context: value.context } : {}),
    ...(typeof value.resolution === 'string' ? { resolution: value.resolution } : {}),
    ...(value.resolutionSource === 'inferred' || value.resolutionSource === 'verified'
      ? { resolutionSource: value.resolutionSource }
      : {}),
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
    ...(value.scope === 'global' || value.scope === 'main' || value.scope === 'sub'
      ? { scope: value.scope }
      : { scope: 'global' }),
    ...(typeof value.lastRecalledAt === 'string' ? { lastRecalledAt: value.lastRecalledAt } : {}),
    ...(typeof value.verifiedAt === 'string' ? { verifiedAt: value.verifiedAt } : {}),
    ...(typeof value.humanInterventions === 'number'
      ? { humanInterventions: Math.max(0, Math.trunc(value.humanInterventions)) }
      : {}),
    ...(value.archived === true ? { archived: true } : {}),
    // 读路径只消毒、不按小上限截断：读一次就砍断的 JSON，写回后会永久损坏（P2-7）。
    ...(typeof value.reportJson === 'string' ? { reportJson: sanitizeQuiet(value.reportJson, 64000) } : {}),
    ...(typeof value.probeReason === 'string' ? { probeReason: sanitizeQuiet(value.probeReason, 500) } : {}),
    ...(value.probeState === 'open' || value.probeState === 'answered'
      || value.probeState === 'searching' || value.probeState === 'ignored'
      ? { probeState: value.probeState }
      : {}),
    ...(typeof value.answer === 'string' ? { answer: sanitizeQuiet(value.answer, 2000) } : {}),
    ...(typeof value.answeredAt === 'string' ? { answeredAt: value.answeredAt } : {}),
    ...(typeof value.probeSource === 'string' ? { probeSource: sanitizeQuiet(value.probeSource, 120) } : {}),
    ...(typeof value.probeContext === 'string' ? { probeContext: sanitizeQuiet(value.probeContext, 4000) } : {}),
    ...(typeof value.probeThread === 'string' ? { probeThread: sanitizeQuiet(value.probeThread, 32000) } : {}),
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

/** memory_search 的可选过滤条件。 */
export interface MemorySearchOptions {
  /** 只返回这些类型（单个或数组）；省略表示不过滤。 */
  type?: MemoryType | readonly MemoryType[]
  /** 是否包含已归档记录（默认 false）。 */
  includeArchived?: boolean
}

/**
 * 命中质量打分：正文命中 > 错误签名 > 上下文 > 解法；全等/前缀额外加权。
 * 返回 0 表示未命中。新记录有极小加成（最多 +3），避免旧噪声压过当前上下文。
 */
function searchScore(item: MemoryRecord, text: string): number {
  const content = item.content.toLowerCase()
  const signature = (item.errorSignature ?? '').toLowerCase()
  const context = (item.context ?? '').toLowerCase()
  const resolution = (item.resolution ?? '').toLowerCase()
  let score = 0
  if (content === text) score += 100
  else if (content.startsWith(text)) score += 50
  else if (content.includes(text)) score += 20
  if (signature.includes(text)) score += 15
  if (context.includes(text)) score += 8
  if (resolution.includes(text)) score += 5
  // 漫游猜想（speculative）常含大量技术词，但未经验证：默认降权，仍可检索到但排在后面。
  // 降权只影响排序，不能把「只命中签名」的记录抹成未命中（score 15 - 15 = 0）；
  // 原始 score 为 0（完全没命中）时仍保持未命中。
  if (item.status === 'speculative' && score > 0) score = Math.max(1, score - 15)
  if (score <= 0) return 0
  const ageDays = (Date.now() - Date.parse(item.createdAt)) / 86_400_000
  if (Number.isFinite(ageDays)) score += Math.max(0, 3 - ageDays / 10)
  return score
}

export class MemoryStore {
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()
  private readonly writes = new WriteQueue()
  /** 已隔离到 `.corrupt` 旁路文件的坏行，按原文去重，避免每次读都重复追加。 */
  private readonly quarantined = new Set<string>()

  constructor(dataDir: string = defaultDataDir(), private readonly notify?: SharedWorldListener) {
    this.file = join(dataDir, 'memories.jsonl')
  }

  /** 向共享世界模型广播一次变更；监听器异常不得影响落盘。 */
  private emit(event: SharedWorldEvent): void {
    if (this.notify === undefined) return
    try {
      this.notify(event)
    } catch (error) {
      console.error('[dsh-evolution-flywheel] shared world broadcast failed:', error)
    }
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
    return this.runExclusiveLocked(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      if (items.some(item => item.content.trim() === text)) return undefined
      const record: MemoryRecord = {
        id: `mem-${randomUUID()}`,
        content: text,
        type,
        status: 'suggested',
        createdAt: new Date().toISOString(),
        scope: 'global',
      }
      await this.writeAll([record, ...items])
      this.emit({ type: 'memory:added', item: record })
      return record
    })
  }

  /** 把一条记忆从 suggested 改为 approved；已 approved 时原样返回。 */
  approve(id: string): Promise<MemoryRecord | undefined> {
    const key = id.trim()
    if (key === '') return Promise.resolve(undefined)
    return this.runExclusiveLocked(async () => {
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
      this.emit({ type: 'memory:updated', item: updated })
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
    return this.runExclusiveLocked(async () => {
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
        this.emit({ type: 'memory:updated', item: updated })
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
          // 错误捕获路径的 resolution 都来自模型，默认标记为「推测」。
          ? { resolution, resolutionSource: 'inferred' as const }
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
      this.emit({ type: 'memory:added', item: record })
      return { item: record, created: true }
    })
  }

  /** 给已有的排错经验补充解决办法；返回更新后的记录。 */
  attachResolution(fingerprint: string, resolution: string): Promise<MemoryRecord | undefined> {
    const key = fingerprint.trim()
    const text = resolution.trim().slice(0, 1000)
    if (key === '' || text === '') return Promise.resolve(undefined)
    return this.runExclusiveLocked(async () => {
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
      this.emit({ type: 'memory:updated', item: updated })
      return updated
    })
  }

  /** 按记忆 id 设置/清空解决办法；返回更新后的记录。 */
  /** 更新解法文本；source 默认 inferred（新文本未验证），人类确认或探针验证可显式标 verified。 */
  setResolution(id: string, resolution: string, source: 'inferred' | 'verified' = 'inferred'): Promise<MemoryRecord | undefined> {
    const key = id.trim()
    if (key === '') return Promise.resolve(undefined)
    const text = resolution.trim().slice(0, 1000)
    return this.runExclusiveLocked(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      const index = items.findIndex(item => item.id === key)
      if (index < 0) return undefined
      const current = items[index]
      if (current === undefined) return undefined
      const { resolution: _previous, ...rest } = current
      const updated: MemoryRecord = text === ''
        ? rest
        : { ...rest, resolution: text, resolutionSource: source }
      const next = [...items]
      next[index] = updated
      await this.writeAll(next)
      this.emit({ type: 'memory:updated', item: updated })
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
    return this.runExclusiveLocked(async () => {
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
        ...(patch.resolutionSource !== undefined ? { resolutionSource: patch.resolutionSource } : {}),
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
        ...(patch.lastRecalledAt !== undefined ? { lastRecalledAt: patch.lastRecalledAt } : {}),
        ...(patch.verifiedAt !== undefined ? { verifiedAt: patch.verifiedAt } : {}),
        ...(patch.humanInterventions !== undefined
          ? { humanInterventions: Math.max(0, Math.trunc(patch.humanInterventions)) }
          : {}),
        ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
        ...(patch.reportJson !== undefined ? { reportJson: clampJsonField(patch.reportJson, 16000) } : {}),
        ...(patch.probeReason !== undefined ? { probeReason: sanitize(patch.probeReason, 500) } : {}),
        ...(patch.probeState !== undefined ? { probeState: patch.probeState } : {}),
        ...(patch.answer !== undefined ? { answer: sanitize(patch.answer, 2000) } : {}),
        ...(patch.answeredAt !== undefined ? { answeredAt: patch.answeredAt } : {}),
        ...(patch.probeSource !== undefined ? { probeSource: sanitize(patch.probeSource, 120) } : {}),
        ...(patch.probeContext !== undefined ? { probeContext: sanitize(patch.probeContext, 4000) } : {}),
        ...(patch.probeThread !== undefined ? { probeThread: clampJsonField(patch.probeThread, 8000, 'tail') } : {}),
      }
      const next = [...items]
      next[index] = updated
      await this.writeAll(next)
      this.emit({ type: 'memory:updated', item: updated })
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
    return this.runExclusiveLocked(async () => {
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
      if (touched.length > 0) {
        await this.writeAll(next)
        for (const item of touched) this.emit({ type: 'memory:updated', item })
      }
      return touched
    })
  }

  /** 记录这些记忆被召回注入：只更新 lastRecalledAt，作为遗忘曲线的基准。 */
  touchRecalled(ids: readonly string[]): Promise<void> {
    const keys = [...new Set(ids.map(id => id.trim()).filter(id => id !== ''))]
    if (keys.length === 0) return Promise.resolve()
    return this.runExclusiveLocked(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      const now = new Date().toISOString()
      let changed = false
      const next = items.map(item => {
        if (!keys.includes(item.id)) return item
        changed = true
        return { ...item, lastRecalledAt: now }
      })
      if (changed) await this.writeAll(next)
    })
  }

  /**
   * 只读检索，供 memory_search 工具使用。
   *
   * 2026-10-25 真实使用反馈：旧实现按文件顺序返回、无类型过滤，搜「插件」10 条里
   * 只有 1 条有用（其余是跨学科漫游）。现在按命中质量排序，并支持按类型过滤。
   */
  search(query: string, limit = 10, options: MemorySearchOptions = {}): Promise<MemoryRecord[]> {
    return this.searchWithTotal(query, limit, options).then(result => result.items)
  }

  /**
   * 与 search 相同，但附带**命中总数**，让调用方知道「只返回了前 N 条」。
   * 2026-10-25 子 Agent 反馈：搜「EIO」有 15 条命中却只回 3 条，没有任何提示。
   */
  searchWithTotal(query: string, limit = 10, options: MemorySearchOptions = {}): Promise<{ items: MemoryRecord[]; total: number }> {
    const text = query.trim().toLowerCase()
    if (text === '') return Promise.resolve({ items: [], total: 0 })
    const types = options.type === undefined
      ? undefined
      : new Set<MemoryType>(Array.isArray(options.type) ? options.type : [options.type])
    const includeArchived = options.includeArchived === true
    return this.runExclusive(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      // 多词查询按 AND 语义：每个词都必须命中（2026-10-25 子 Agent 实测：
      // 整串子串匹配让「插件 启动」这类查询 4 次全部返回 0 条）。
      const terms = text.split(/\s+/u).filter(term => term !== '')
      const scored: Array<{ item: MemoryRecord; score: number }> = []
      for (const item of items) {
        if (!includeArchived && item.archived === true) continue
        if (types !== undefined && !types.has(item.type)) continue
        let score = 0
        let allMatched = true
        for (const term of terms) {
          const termScore = searchScore(item, term)
          if (termScore === 0) {
            allMatched = false
            break
          }
          score += termScore
        }
        if (allMatched) scored.push({ item, score })
      }
      scored.sort((left, right) =>
        right.score - left.score || right.item.createdAt.localeCompare(left.item.createdAt))
      const capped = scored.slice(0, Math.max(1, Math.min(50, limit))).map(entry => entry.item)
      return { items: capped, total: scored.length }
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
    return this.runExclusiveLocked(async () => {
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
      this.emit({ type: 'memory:added', item: record })
      return record
    })
  }

  /** 按 id 删除；返回是否真的删掉了一条。 */
  delete(id: string): Promise<boolean> {
    const key = id.trim()
    if (key === '') return Promise.resolve(false)
    return this.runExclusiveLocked(async () => {
      await this.ensureSeeded()
      const items = await this.readAll()
      const next = items.filter(item => item.id !== key)
      if (next.length === items.length) return false
      await this.writeAll(next)
      this.emit({ type: 'memory:removed', id: key })
      return true
    })
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /** 写路径专用：在进程内串行之外，再加一层跨进程文件锁。 */
  private runExclusiveLocked<T>(task: () => Promise<T>): Promise<T> {
    return this.runExclusive(() => withFileLock(this.file, task))
  }

  private async ensureSeeded(): Promise<void> {
    try {
      await stat(this.file)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // 并发首播必须「排他创建」而不是覆盖写：writeAll 是整表替换，会把另一个进程
    // 刚 append 的记录一起盖掉（Agent3 实测：同进程 185/200、跨进程 9/80 首播失败）。
    const payload = seedRecords().map(item => JSON.stringify(item)).join('\n')
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(temp, payload === '' ? '' : `${payload}\n`, 'utf8')
    try {
      // 硬链接是原子的：目标已存在会 EEXIST，正好表示别人先播种成功，不算失败。
      await link(temp, this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      await rm(temp, { force: true })
    }
  }

  private async readAll(): Promise<MemoryRecord[]> {
    const text = await readFile(this.file, 'utf8')
    const bytes = Buffer.byteLength(text, 'utf8')
    // 读路径不再因上限直接拒绝：超限时用户更需要能打开面板、能删除（否则永久锁死）。
    if (bytes > MAX_FILE_BYTES) {
      console.error(
        `[dsh-evolution-flywheel] 记忆库 ${bytes} 字节已超过 1 MiB 上限：写操作会被拒绝，请归档或清理`,
      )
    }
    const items: MemoryRecord[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const value: unknown = JSON.parse(trimmed)
        if (isRecord(value)) {
          items.push(normalizeRecord(value))
        } else {
          // 合法 JSON 但不是记忆对象（如 `{}`、数组、别家文件混入）同样不能静默丢。
          await this.quarantine(trimmed, new Error('不是合法的记忆对象'))
        }
      } catch (error) {
        // 坏行不能静默消失：后续任一 writeAll 都会用内存集合重写整个文件，
        // 静默丢弃等于把损坏行永久删除。先隔离到 `.corrupt` 旁路文件，再继续。
        await this.quarantine(trimmed, error)
      }
    }
    return items.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /**
   * 把无法解析的 JSONL 行备份到 `${file}.corrupt`。
   *
   * 为什么不能只记日志：`readAll` 之后通常紧跟一次 `writeAll`（追加/更新/确认都会
   * 重写整个文件），内存里没有的行会被物理删除。备份到旁路文件后，坏行仍可人工恢复。
   * 同一进程内按原文去重，避免高频读路径反复追加同一行。
   */
  private async quarantine(line: string, error: unknown): Promise<void> {
    const snippet = line.length > 500 ? `${line.slice(0, 500)}…` : line
    if (this.quarantined.has(snippet)) return
    this.quarantined.add(snippet)
    // 上限 500 条，防止一个被反复读的坏文件把内存吃光。
    if (this.quarantined.size > 500) {
      const oldest = this.quarantined.values().next().value
      if (oldest !== undefined) this.quarantined.delete(oldest)
    }
    const reason = error instanceof Error ? error.message : String(error)
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await appendFile(`${this.file}.corrupt`, `${new Date().toISOString()}\t${snippet}\n`, 'utf8')
      console.error(
        `[dsh-evolution-flywheel] memories.jsonl 损坏行已隔离到 .corrupt（${reason}）：${snippet.slice(0, 120)}`,
      )
    } catch (appendError) {
      // 连备份都失败时必须是高音量错误：这一行确实可能丢。
      console.error('[dsh-evolution-flywheel] 损坏行隔离失败，该行可能丢失：', appendError, snippet.slice(0, 120))
    }
  }

  private writeAll(items: readonly MemoryRecord[]): Promise<void> {
    return this.writes.enqueue(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const text = items.map(item => JSON.stringify(item)).join('\n')
      const payload = text === '' ? '' : `${text}\n`
      const targetBytes = Buffer.byteLength(payload, 'utf8')
      // 写前预检：append 不能把库推过上限（否则之后连删除都会失败，形成死锁）。
      if (targetBytes > MAX_FILE_BYTES) {
        let currentBytes = 0
        try {
          currentBytes = (await stat(this.file)).size
        } catch {
          currentBytes = 0
        }
        // 允许「瘦身」越过检查：删除/归档/裁剪必须始终可用，否则库一旦超限就再也救不回来。
        if (targetBytes >= currentBytes) {
          throw new Error(
            `记忆库将超过 1 MiB 上限（目标 ${targetBytes} 字节，当前 ${currentBytes} 字节）：请先归档或删除部分记忆再写入`,
          )
        }
      }
      // 先写临时文件再 rename，避免崩溃或断电留下半行/空文件。
      // 临时名带随机后缀：同进程多个 store 实例也不会互相踩。
      const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temp, payload, 'utf8')
      await this.replaceFile(temp, this.file)
    })
  }

  /** rename 在 Windows 上可能被占用方短暂挡住（EPERM/EACCES），重试几次再放弃。 */
  private async replaceFile(temp: string, target: string): Promise<void> {
    // 6 次、40~240ms 退避：并发读（readAll）与写会短暂互斥，实测 Windows 上常见 EPERM。
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await rename(temp, target)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOENT') throw error
        if (attempt === 5) {
          // 最后兜底：放弃原子 rename，改为直接覆盖写。宁可牺牲原子性，也不能让记忆写不进去。
          console.warn('[dsh-evolution-flywheel] rename 持续 EPERM，回退为直接覆盖写（放弃原子性）')
          await writeFile(target, await readFile(temp))
          await rm(temp, { force: true })
          return
        }
        await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)))
      }
    }
  }
}

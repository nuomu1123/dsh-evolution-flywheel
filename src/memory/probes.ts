/**
 * 认知探针：AI 基于自身世界模型的缺口，主动向人类提问。
 *
 * - 探针是记忆（cognitive_probe），可追溯来源与原因；
 * - 人类可回答、授权 DMA 定向搜索、或跳过；
 * - 每周生成一份“认知简报”，汇总好问题与人类没答上来的盲区。
 */
import type { MemoryContextBase } from './context.js'
import type { MemoryEventHub } from './events.js'
import type { MemoryRecord, MemoryStore } from './store.js'
import { appendAudit } from '../audit.js'

export type ProbeSource = 'model-distill' | 'dma' | 'manual' | 'curation'

export interface ProbeInput {
  question: string
  reason: string
  source: ProbeSource
  sourceId?: string
  /** 证据包：本次提问所依据的结构化上下文，随探针落库，供人展开判断。 */
  context?: unknown
}

/**
 * 客服式套话：不携带任何新信息，只是在征求许可（"需要我帮你整理吗"）。
 * 主体性原则要求探针必须带跨学科类比、新规律或具体分歧，命中即拒绝落库。
 *
 * 注意：模式要精确到"许可征求"，不能误伤带实质信息的问句
 * （例如"你希望「分歧」保持开放还是收敛？"、"请告诉我需要哪种前提"都应放行）。
 */
const SERVICE_TONE_PATTERNS: readonly RegExp[] = [
  // 带"我"的许可征求
  /需要我(帮你|为你|来|继续|整理|处理|做)/u,
  /要不要我(帮你|为你|来|继续|整理|处理|做)/u,
  /(你|您)要不要我/u,
  /是否需要我/u,
  // 自荐式动作
  /我帮你(把|整理|处理|做|跑|看看|合并|归档)/u,
  /要我(帮你|为你|把|做|整理|处理|合并)/u,
  /我可以(帮你|为你)(整理|处理|做|看)/u,
  // 只征求下一步指令（没有具体对象）
  /(你|您)希望我/u,
  // 文档明确列为禁止的短问句变体（无"我"前缀）
  /(要不要|要)继续/u,
  /^继续吗[?？]?$/u,
]

/** 判断一句探针是否退化成了客服式提问。 */
export function isServiceToneQuestion(question: string): boolean {
  const text = question.trim()
  if (text === '') return false
  return SERVICE_TONE_PATTERNS.some(pattern => pattern.test(text))
}

/** 创建一条待人类回答的探针；同名且未跳过的探针不重复创建。 */
export async function createProbe(
  store: MemoryStore,
  input: ProbeInput,
): Promise<MemoryRecord | undefined> {
  const question = input.question.trim().slice(0, 500)
  if (question === '') return undefined
  // 主体性守卫：客服式套话不落库，但要留下审计痕迹——否则没人知道"为什么这次没探针"。
  if (isServiceToneQuestion(question)) {
    appendAudit('memory.probe.rejected', {
      source: input.source,
      question: question.slice(0, 120),
      reason: 'service-tone',
    })
    return undefined
  }
  const items = await store.list()
  const existing = items.find(item =>
    item.type === 'cognitive_probe'
    && item.content.trim() === question
    && item.probeState !== 'ignored')
  if (existing !== undefined) return existing
  const created = await store.appendSuggested(question, 'cognitive_probe')
  if (created === undefined) return undefined
  const contextJson = input.context === undefined
    ? undefined
    : JSON.stringify(input.context).slice(0, 4000)
  return store.update(created.id, {
    // 调用方可能传来空原因（模型没给）：必须留一句可读的说明，否则界面上是空白。
    probeReason: input.reason.trim() === ''
      ? `由 ${input.source} 生成的待确认问题（未提供原因）`
      : input.reason.trim().slice(0, 500),
    probeState: 'open',
    probeSource: input.source,
    ...(contextJson === undefined ? {} : { probeContext: contextJson }),
    origin: 'probe',
    originDetail: input.source,
    trace: [
      `来源：${input.source}`,
      ...(input.sourceId === undefined ? [] : [`来源记忆：${input.sourceId}`]),
      `原因：${input.reason.slice(0, 200)}`,
      ...(input.context === undefined ? [] : ['已附带证据包']),
    ],
  })
}

/** 人类回答探针：写入答案并置为 approved，成为可注入的知识。 */
export async function answerProbe(
  store: MemoryStore,
  id: string,
  answer: string,
): Promise<MemoryRecord | undefined> {
  const text = answer.trim().slice(0, 2000)
  if (text === '') return undefined
  return store.update(id, {
    answer: text,
    probeState: 'answered',
    answeredAt: new Date().toISOString(),
    status: 'approved',
    resolution: text,
    trace: ['人类已回答探针'],
  })
}

/** 标记探针已授权 DMA 定向搜索。 */
export async function markProbeSearching(
  store: MemoryStore,
  id: string,
): Promise<MemoryRecord | undefined> {
  return store.update(id, { probeState: 'searching' })
}

/** 跳过一个探针：保留记录但不再注入。 */
export async function ignoreProbe(
  store: MemoryStore,
  id: string,
): Promise<MemoryRecord | undefined> {
  return store.update(id, { probeState: 'ignored', status: 'rejected' })
}

export interface CognitiveBrief {
  generatedAt: string
  total: number
  open: number
  answered: number
  searching: number
  ignored: number
  openQuestions: Array<{ id: string; question: string; reason: string }>
  blindSpots: string[]
  summary: string
}

/** 汇总探针状态与人类没答上来的盲区。 */
export function buildCognitiveBrief(items: readonly MemoryRecord[], now = Date.now()): CognitiveBrief {
  const probes = items.filter(item => item.type === 'cognitive_probe')
  const byState = (state: string): MemoryRecord[] => probes.filter(item => item.probeState === state)
  const open = byState('open')
  const answered = byState('answered')
  const searching = byState('searching')
  const ignored = byState('ignored')
  const openQuestions = open.slice(0, 10).map(item => ({
    id: item.id,
    question: item.content.slice(0, 120),
    reason: (item.probeReason ?? '').slice(0, 120),
  }))
  const blindSpots = open.slice(0, 5).map(item => item.content.slice(0, 80))
  return {
    generatedAt: new Date(now).toISOString(),
    total: probes.length,
    open: open.length,
    answered: answered.length,
    searching: searching.length,
    ignored: ignored.length,
    openQuestions,
    blindSpots,
    summary: `共 ${probes.length} 个探针：待回答 ${open.length}，已回答 ${answered.length}，搜索中 ${searching.length}，跳过 ${ignored.length}。`,
  }
}

/** 生成并落库一份每周认知简报；同一周不重复。 */
export async function appendCognitiveBrief(
  store: MemoryStore,
  items: readonly MemoryRecord[],
  now = Date.now(),
): Promise<MemoryRecord | undefined> {
  const brief = buildCognitiveBrief(items, now)
  if (brief.total === 0) return undefined
  const week = new Date(now).toISOString().slice(0, 10)
  const existing = items.find(item =>
    item.type === 'cognitive_brief' && item.createdAt.slice(0, 10) === week)
  if (existing !== undefined) return existing
  const created = await store.appendSuggested(`认知简报：${brief.summary}`, 'cognitive_brief')
  if (created === undefined) return undefined
  return store.update(created.id, {
    context: brief.blindSpots.join('；').slice(0, 500),
    origin: 'probe',
    originDetail: '每周认知简报',
    trace: [
      brief.summary,
      ...brief.blindSpots.slice(0, 3).map(question => `盲区：${question}`),
    ],
  })
}

/** 每周检查一次认知简报；单飞保护，失败只写日志。 */
export function registerCognitiveBriefSchedule(
  ctx: MemoryContextBase,
  store: MemoryStore,
  events: MemoryEventHub,
  intervalMs = 24 * 60 * 60_000,
): void {
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    try {
      const items = await store.list()
      const last = items
        .filter(item => item.type === 'cognitive_brief')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      const lastAt = last === undefined ? undefined : Date.parse(last.createdAt)
      if (lastAt !== undefined && Number.isFinite(lastAt) && Date.now() - lastAt < 7 * 24 * 60 * 60_000) return
      if (items.filter(item => item.type === 'cognitive_probe').length === 0) return
      running = true
      const brief = await appendCognitiveBrief(store, items, Date.now())
      if (brief !== undefined) events.publish({ type: 'memory:added', item: brief })
    } catch (error) {
      console.error('[dsh-evolution-flywheel] cognitive brief schedule failed:', error)
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

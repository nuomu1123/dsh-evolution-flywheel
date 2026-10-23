/**
 * 用量聚合：把记忆条目里的审阅/辩论/漫游 token 汇总成账单。
 * 漫游按 runId 去重，避免一次运行的多条洞察重复计费。
 */
import type { MemoryRecord } from './store.js'

export interface UsageSummary {
  todayTokens: number
  totalTokens: number
  dmaTodayTokens: number
  dmaTotalTokens: number
  reviewTodayTokens: number
  reviewTotalTokens: number
  debateTodayTokens: number
  debateTotalTokens: number
  todayRuns: number
  totalRuns: number
  lastRunTokens: number
  disciplineBreakdown: Array<{ discipline: string; tokens: number; runs: number }>
}

interface RunLedger {
  tokens: number
  createdAt: string
  discipline: string
}

export function summarizeUsage(items: readonly MemoryRecord[], now = new Date()): UsageSummary {
  const today = now.toDateString()
  const runs = new Map<string, RunLedger>()
  for (const item of items) {
    if (typeof item.tokensUsed !== 'number' || item.tokensUsed < 0) continue
    const key = item.runId ?? `item:${item.id}`
    const previous = runs.get(key)
    if (previous === undefined || item.createdAt > previous.createdAt) {
      runs.set(key, {
        tokens: Math.max(item.tokensUsed, previous?.tokens ?? 0),
        createdAt: item.createdAt,
        discipline: item.discipline ?? '未标注',
      })
    }
  }

  const ledger = [...runs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const todayRuns = ledger.filter(run => new Date(run.createdAt).toDateString() === today)
  const sum = (list: RunLedger[]): number => list.reduce((total, run) => total + run.tokens, 0)

  let reviewTodayTokens = 0
  let reviewTotalTokens = 0
  let debateTodayTokens = 0
  let debateTotalTokens = 0
  for (const item of items) {
    const review = typeof item.reviewTokens === 'number' ? item.reviewTokens : 0
    const debate = typeof item.debateTokens === 'number' ? item.debateTokens : 0
    reviewTotalTokens += review
    debateTotalTokens += debate
    if (new Date(item.createdAt).toDateString() === today) {
      reviewTodayTokens += review
      debateTodayTokens += debate
    }
  }

  const byDiscipline = new Map<string, { tokens: number; runs: number }>()
  for (const run of ledger) {
    const entry = byDiscipline.get(run.discipline) ?? { tokens: 0, runs: 0 }
    entry.tokens += run.tokens
    entry.runs += 1
    byDiscipline.set(run.discipline, entry)
  }

  const dmaTodayTokens = sum(todayRuns)
  const dmaTotalTokens = sum(ledger)
  return {
    todayTokens: dmaTodayTokens + reviewTodayTokens + debateTodayTokens,
    totalTokens: dmaTotalTokens + reviewTotalTokens + debateTotalTokens,
    dmaTodayTokens,
    dmaTotalTokens,
    reviewTodayTokens,
    reviewTotalTokens,
    debateTodayTokens,
    debateTotalTokens,
    todayRuns: todayRuns.length,
    totalRuns: ledger.length,
    lastRunTokens: ledger[0]?.tokens ?? 0,
    disciplineBreakdown: [...byDiscipline.entries()]
      .map(([discipline, value]) => ({ discipline, tokens: value.tokens, runs: value.runs }))
      .sort((left, right) => right.tokens - left.tokens),
  }
}

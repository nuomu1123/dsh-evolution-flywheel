/**
 * 每日 Token 预算：默认 0 表示不限制；由 DSH_MEMORY_DAILY_TOKEN_BUDGET 覆盖。
 * 预算只统计「今天创建的记忆条目」上的审阅/辩论/漫游用量。
 */
import type { MemoryStore } from './store.js'
import { summarizeUsage } from './usage.js'

export interface BudgetSnapshot {
  /** 每日预算；0 表示不限制。 */
  dailyBudget: number
  /** 今日已用 token。 */
  todayTokens: number
  /** 剩余预算；-1 表示不限制。 */
  remaining: number
  /** 是否已用完。 */
  exceeded: boolean
}

export function dailyBudget(): number {
  const raw = process.env.DSH_MEMORY_DAILY_TOKEN_BUDGET
  if (raw === undefined || raw.trim() === '') return 0
  const parsed = Number(raw)
  // 非法值不能静默变成「不限」：至少留下一条可查的警告。
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[dsh-evolution-flywheel] DSH_MEMORY_DAILY_TOKEN_BUDGET=${raw} 非法，按 0（不限）处理`)
    return 0
  }
  return Math.trunc(parsed)
}

export async function readBudget(store: MemoryStore): Promise<BudgetSnapshot> {
  const budget = dailyBudget()
  const usage = summarizeUsage(await store.list())
  return {
    dailyBudget: budget,
    todayTokens: usage.todayTokens,
    remaining: budget > 0 ? Math.max(0, budget - usage.todayTokens) : -1,
    exceeded: budget > 0 && usage.todayTokens >= budget,
  }
}

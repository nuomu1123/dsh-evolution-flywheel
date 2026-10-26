/**
 * 批评者采纳率：只做纯计算，便于单测。
 *
 * 语义（2026-10-25 b665bf2 引入）：批评者对一条记录**提出过意见**（issues > 0），
 * 且最终审阅结论为 reject —— 说明批评与审阅同向，视为「采纳」；
 * 审阅仍然 approve 则视为「未采纳」。两件事都必须能在审计里找到同一个 id 才计入 tracked。
 *
 * 输入必须按 **最新在前** 排列（与 readAudit 的返回顺序一致）：同一 id 只取第一条事件，
 * 否则重试/多次审阅会把旧结论当成最新结论。
 */
import type { AuditEntry } from '../audit.js'

export interface CriticAdoption {
  tracked: number
  aligned: number
  misaligned: number
  rate: number | null
}

export function computeCriticAdoption(entries: AuditEntry[]): CriticAdoption {
  const verdicts = new Map<string, string>()
  const criticisms = new Map<string, number>()

  for (const entry of entries) {
    const id = typeof entry.payload.id === 'string' ? entry.payload.id : ''
    if (id === '') continue
    if (entry.event === 'memory.review.verdict') {
      const decision = typeof entry.payload.decision === 'string' ? entry.payload.decision : ''
      if (decision !== '' && !verdicts.has(id)) verdicts.set(id, decision)
    } else if (entry.event === 'memory.critic' && entry.payload.source === 'review') {
      const issues = typeof entry.payload.issues === 'number' ? entry.payload.issues : 0
      if (!criticisms.has(id)) criticisms.set(id, issues)
    }
  }

  let tracked = 0
  let aligned = 0
  for (const [id, issues] of criticisms) {
    if (issues === 0) continue
    const decision = verdicts.get(id)
    if (decision === undefined) continue
    tracked += 1
    if (decision === 'reject') aligned += 1
  }

  return {
    tracked,
    aligned,
    misaligned: tracked - aligned,
    rate: tracked === 0 ? null : aligned / tracked,
  }
}

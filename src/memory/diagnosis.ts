/**
 * 自诊断：让插件能回答「我现在健康吗」。
 *
 * 为什么需要它（2026-10-25 真实使用反馈）：那一次 10 项修复里有 8 项是使用者翻源码
 * 才发现的——插件能记录每一处症状，却不会诊断自己。这个模块把「哪里疼」聚合成一份
 * 可直接读的报告：模型故障多少条、待裁决怎么分布、哪些错误在重复、下一步建议做什么。
 */
import { similarErrorGroups } from './curator.js'
import type { MemoryRecord } from './store.js'

/**
 * 「机械失败」判定：这些 human_intervention 不是需要人判断，而是模型容量/瞬时故障。
 * 批量重试只碰这些；正常的人工裁决记录不会被动。
 */
export const STUCK_REVIEW_REASON = /max-tokens|未输出正文|连接中断|流式响应中断|ECONNRESET|socket hang up|fetch failed|LLM 未返回 JSON|JSON 不完整|JSON 不是对象|Expected .*in JSON/iu

/** 是否是「因模型故障卡住」的记录（可批量重试）。 */
export function isStuckReview(record: { status?: string; debateSummary?: string }): boolean {
  return record.status === 'human_intervention' && STUCK_REVIEW_REASON.test(record.debateSummary ?? '')
}

/** 把失败原因归成可读的几类（用于诊断报告）。 */
function failureKind(reason: string): string {
  if (/max-tokens/iu.test(reason)) return 'reasoning 吃光 token'
  if (/未输出正文/iu.test(reason)) return '空正文'
  if (/JSON/iu.test(reason)) return 'JSON 解析失败'
  if (/连接中断|ECONNRESET|socket hang up|fetch failed/iu.test(reason)) return '连接中断'
  return '其他'
}

export interface SelfDiagnosis {
  generatedAt: string
  totals: {
    all: number
    active: number
    byStatus: Record<string, number>
  }
  pending: {
    /** suggested：等人确认的草稿。 */
    awaitingConfirm: number
    /** staged / under_review：等审阅。 */
    awaitingReview: number
    /** human_intervention 总数。 */
    needsHuman: number
    /** 其中因模型故障卡住的（可批量重试）。 */
    modelFailure: number
    /** 其中真正需要人判断的。 */
    realJudgement: number
  }
  llmFailures: {
    total: number
    byKind: Record<string, number>
  }
  similarErrors: Array<{ signature: string; count: number }>
  suggestions: string[]
}

/** 汇总一份健康报告；纯函数，不读文件、不调模型。 */
export function buildSelfDiagnosis(items: readonly MemoryRecord[]): SelfDiagnosis {
  // 与整理报告口径一致：元数据类不计入「有多少条记忆」（2026-10-25 子 Agent 反馈）。
  const active = items.filter(item => item.archived !== true
    && item.type !== 'curation_report'
    && item.type !== 'cognitive_probe'
    && item.type !== 'cognitive_brief')
  const byStatus: Record<string, number> = {}
  for (const item of active) {
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
  }

  const awaitingConfirm = active.filter(item => item.status === 'suggested').length
  const awaitingReview = active.filter(item => item.status === 'staged' || item.status === 'under_review').length
  const humanItems = active.filter(item => item.status === 'human_intervention')
  const modelFailureItems = humanItems.filter(item => isStuckReview(item))

  const byKind: Record<string, number> = {}
  for (const item of modelFailureItems) {
    const kind = failureKind(item.debateSummary ?? '')
    byKind[kind] = (byKind[kind] ?? 0) + 1
  }

  const similarErrors = similarErrorGroups(active)
    .map(group => ({ signature: group.signature, count: group.ids.length }))
    .sort((left, right) => right.count - left.count)

  const suggestions: string[] = []
  if (modelFailureItems.length > 0) {
    suggestions.push(
      `${modelFailureItems.length} 条记录因模型故障卡住，可批量重试：POST /api/review/retry {"limit":${modelFailureItems.length}}`,
    )
  }
  if (similarErrors.length > 0) {
    const top = similarErrors[0]
    if (top !== undefined) {
      suggestions.push(
        `${similarErrors.length} 组相似错误可合并（最大一组 ${top.count} 条：${top.signature.slice(0, 40)}），先 GET /api/similar-errors 查看`,
      )
    }
  }
  const realJudgement = humanItems.length - modelFailureItems.length
  if (realJudgement > 0) {
    suggestions.push(`${realJudgement} 条需要你亲自判断（证据不足或未收敛），这类不能自动处理`)
  }
  if (awaitingConfirm > 0) {
    suggestions.push(`${awaitingConfirm} 条待确认的草稿，可在面板逐条确认或等待整理`)
  }
  if (suggestions.length === 0) suggestions.push('当前没有需要处理的问题')

  return {
    generatedAt: new Date().toISOString(),
    totals: { all: items.length, active: active.length, byStatus },
    pending: {
      awaitingConfirm,
      awaitingReview,
      needsHuman: humanItems.length,
      modelFailure: modelFailureItems.length,
      realJudgement,
    },
    llmFailures: { total: modelFailureItems.length, byKind },
    similarErrors,
    suggestions,
  }
}

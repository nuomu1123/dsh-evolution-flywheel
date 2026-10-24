/**
 * 整理报告的纯数据契约与解析函数。
 *
 * 故意不依赖 Node 内置模块与 LLM：服务端（curator/api）与浏览器端
 * 都可以安全导入，避免把 fs / review-driver 打进 client bundle。
 */

export type CurationTrigger = 'threshold' | 'manual' | 'scheduled'

export interface CurationItem {
  id: string
  content: string
  reason: string
}

export interface CurationQuality {
  approved: number
  rejected: number
  pending: number
  total: number
  /** 已裁决报告的采纳率 0-1；无裁决时为 0。 */
  approvalRate: number
  /** 最近几条否决理由，供下轮整理引用。 */
  rejectionReasons: string[]
}

/** 集群里每个角色的执行痕迹。 */
export interface CurationRoleTrace {
  name: string
  summary: string
  elapsedMs: number
}

export interface CurationReportPayload {
  trigger: CurationTrigger
  generatedAt: string
  total: number
  keep: CurationItem[]
  archive: CurationItem[]
  highValue: CurationItem[]
  merge: Array<{ ids: string[]; reason: string }>
  risks: string[]
  stats: {
    fresh: number
    faded: number
    duplicates: number
    highSalience: number
    undecided: number
  }
  quality?: CurationQuality
  /** 可选的 LLM 审查摘要；预算不足或失败时回退规则摘要。 */
  llmSummary?: string
  /** 多角色集群的执行痕迹：classifier / red-team / reporter。 */
  roles?: CurationRoleTrace[]
  summary: string
}

/** 解析报告 JSON；损坏时返回 undefined。 */
export function parseCurationPayload(text: string | undefined): CurationReportPayload | undefined {
  if (text === undefined || text.trim() === '') return undefined
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return undefined
    return value as CurationReportPayload
  } catch {
    return undefined
  }
}

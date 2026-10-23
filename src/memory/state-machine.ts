/**
 * 子母递归对抗状态机：
 *
 *   staged -> under_review -> approved
 *                          \-> debating -> approved
 *                                      \-> rejected
 *                                      \-> human_intervention -> approved/rejected
 *
 * 只做状态流转与持久化；LLM 审阅/辩论由 SkillReviewDriver 注入，便于测试与替换。
 */
import { readBudget } from './budget.js'
import type { MemoryEventHub } from './events.js'
import { clampMetaInsight, sanitizeText } from './sanitize.js'

const sanitize = (value: unknown, maxLength = 1000): string =>
  sanitizeText(value, maxLength, '状态机')
import type { DebateRound, MemoryRecord, MemoryStore } from './store.js'

export interface ReviewVerdict {
  decision: 'approve' | 'reject'
  reason: string
  /** 母 Agent 在初审阶段建议的解决办法。 */
  resolution?: string
  metaInsight?: string
  /** 本次初审消耗的 token。 */
  tokensUsed?: number
}

export interface DebateVerdict {
  converged: boolean
  decision: 'approve' | 'reject' | 'human_intervention'
  metaInsight?: string
  resolution?: string
  /** 子 Agent 的反驳要点。 */
  challenge?: string
  /** 子/母 Agent 的逐轮发言。 */
  rounds?: DebateRound[]
  summary?: string
  /** 本次辩论消耗的 token。 */
  tokensUsed?: number
}

export interface EvidenceItem {
  title: string
  url: string
  snippet: string
}

export interface EvidenceSearch {
  /** 最多检索 limit 个网页；实现方必须自己限制外部调用次数。 */
  search(query: string, limit: number): Promise<EvidenceItem[]>
}

export interface SkillReviewDriver {
  /** 母 Agent 初审。 */
  review(record: MemoryRecord): Promise<ReviewVerdict>
  /** 子母一轮对抗辩论。 */
  debate(record: MemoryRecord, review: ReviewVerdict): Promise<DebateVerdict>
  /** 开卷申诉：带外部证据再次请求母 Agent 裁决。 */
  appeal?(
    record: MemoryRecord,
    review: ReviewVerdict,
    evidence: readonly EvidenceItem[],
  ): Promise<DebateVerdict>
}

export class SkillReviewEngine {
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly store: MemoryStore,
    private readonly events: MemoryEventHub,
    private readonly driver: SkillReviewDriver,
    private readonly evidenceSearch?: EvidenceSearch,
  ) {}

  /** 提交一条 staged 经验，驱动完整状态机。并发重复提交会被单飞保护。 */
  async review(id: string): Promise<MemoryRecord | undefined> {
    const key = id.trim()
    if (key === '' || this.inFlight.has(key)) return undefined
    this.inFlight.add(key)
    try {
      const record = (await this.store.list()).find(item => item.id === key)
      if (record === undefined || record.type !== 'skill_error_fix') return undefined
      if (record.status === 'approved' || record.status === 'rejected' || record.status === 'human_intervention') {
        return record
      }

      const budget = await readBudget(this.store)
      if (budget.exceeded) return record

      await this.patch(key, {
        status: 'under_review',
        reviewRound: 1,
      })

      const safeRecord = this.safeRecord(record)
      let verdict: ReviewVerdict
      try {
        verdict = await this.driver.review(safeRecord)
      } catch (error) {
        return this.humanIntervention(key, `初审失败：${this.errorText(error)}`)
      }

      const reviewReason = sanitize(verdict.reason, 500)
      if (verdict.decision === 'approve') {
        return this.patch(key, {
          status: 'approved',
          reviewReason,
          ...(verdict.resolution !== undefined && verdict.resolution.trim() !== ''
            ? { resolution: sanitize(verdict.resolution, 1000) }
            : {}),
          ...(verdict.tokensUsed !== undefined ? { reviewTokens: verdict.tokensUsed } : {}),
          ...(verdict.metaInsight !== undefined ? { metaInsight: clampMetaInsight(verdict.metaInsight) } : {}),
        })
      }

      await this.patch(key, {
        status: 'debating',
        reviewReason,
        reviewRound: 1,
        ...(verdict.tokensUsed !== undefined ? { reviewTokens: verdict.tokensUsed } : {}),
      })

      let debate: DebateVerdict
      const review: ReviewVerdict = {
        decision: 'reject',
        reason: reviewReason,
        ...(verdict.resolution !== undefined && verdict.resolution.trim() !== ''
          ? { resolution: sanitize(verdict.resolution, 1000) }
          : {}),
        ...(verdict.metaInsight !== undefined ? { metaInsight: clampMetaInsight(verdict.metaInsight) } : {}),
      }
      try {
        debate = await this.driver.debate(safeRecord, review)
      } catch (error) {
        return this.humanIntervention(key, `辩论失败：${this.errorText(error)}`)
      }

      const debateSummary = sanitize(debate.summary ?? '', 800)
      const challenge = sanitize(debate.challenge ?? '', 300)
      const debateRounds = (debate.rounds ?? [])
        .filter(round => round.role === 'child' || round.role === 'mother')
        .map(round => ({ role: round.role, content: sanitize(round.content, 300) }))
        .filter(round => round.content !== '')
        .slice(0, 6)
      const metaInsight = debate.metaInsight === undefined ? undefined : clampMetaInsight(debate.metaInsight)
      if (!debate.converged || debate.decision === 'human_intervention') {
        const withEvidence = await this.tryEvidenceAppeal(key, safeRecord, review, debateSummary)
        if (withEvidence !== undefined) return withEvidence
        return this.patch(key, {
          status: 'human_intervention',
          debateSummary,
          ...(challenge !== '' ? { challenge } : {}),
          ...(debateRounds.length > 0 ? { debateRounds } : {}),
          ...(debate.tokensUsed !== undefined ? { debateTokens: debate.tokensUsed } : {}),
          ...(metaInsight !== undefined ? { metaInsight } : {}),
        })
      }

      return this.patch(key, {
        status: debate.decision === 'approve' ? 'approved' : 'rejected',
        debateSummary,
        ...(challenge !== '' ? { challenge } : {}),
        ...(debateRounds.length > 0 ? { debateRounds } : {}),
        ...(debate.tokensUsed !== undefined ? { debateTokens: debate.tokensUsed } : {}),
        ...(metaInsight !== undefined ? { metaInsight } : {}),
        ...(debate.decision === 'approve' && debate.resolution !== undefined && debate.resolution.trim() !== ''
          ? { resolution: sanitize(debate.resolution, 1000) }
          : {}),
      })
    } finally {
      this.inFlight.delete(key)
    }
  }

  /**
   * 对已经进入 human_intervention 的经验发起“开卷申诉”。
   * 最多检索 3 个网页；仍不收敛则保持 human_intervention。
   */
  async arbitrateWithEvidence(id: string): Promise<MemoryRecord | undefined> {
    const key = id.trim()
    if (key === '' || this.inFlight.has(key)) return undefined
    const record = (await this.store.list()).find(item => item.id === key)
    if (record === undefined || record.status !== 'human_intervention') return record
    const budget = await readBudget(this.store)
    if (budget.exceeded) return record
    this.inFlight.add(key)
    try {
      const review: ReviewVerdict = {
        decision: 'reject',
        reason: record.reviewReason ?? '历史辩论未收敛',
      }
      return (await this.tryEvidenceAppeal(
        key,
        this.safeRecord(record),
        review,
        record.debateSummary ?? '',
      )) ?? record
    } finally {
      this.inFlight.delete(key)
    }
  }

  /** 人类圣裁：只允许处理 human_intervention。 */
  async humanDecide(id: string, decision: 'adopt' | 'discard'): Promise<MemoryRecord | undefined> {
    const key = id.trim()
    if (key === '') return undefined
    const record = (await this.store.list()).find(item => item.id === key)
    if (record === undefined || record.status !== 'human_intervention') return undefined
    return this.patch(key, {
      status: decision === 'adopt' ? 'approved' : 'rejected',
      humanDecision: decision,
    })
  }

  private async patch(
    id: string,
    patch: Parameters<MemoryStore['update']>[1],
  ): Promise<MemoryRecord | undefined> {
    const item = await this.store.update(id, patch)
    if (item !== undefined) this.events.publish({ type: 'memory:updated', item })
    return item
  }

  private async humanIntervention(id: string, reason: string): Promise<MemoryRecord | undefined> {
    return this.patch(id, {
      status: 'human_intervention',
      debateSummary: sanitize(reason, 800),
    })
  }

  /**
   * 开卷辩论：最多取 3 条外部证据，消毒后交给母 Agent 二次裁决。
   * 返回 undefined 表示没有可用搜索工具/证据。
   */
  private async tryEvidenceAppeal(
    id: string,
    record: MemoryRecord,
    review: ReviewVerdict,
    previousSummary: string,
  ): Promise<MemoryRecord | undefined> {
    if (this.evidenceSearch === undefined || this.driver.appeal === undefined) return undefined

    let rawEvidence: EvidenceItem[]
    try {
      rawEvidence = await this.evidenceSearch.search(record.errorSignature ?? '', 3)
    } catch (error) {
      console.error('[dsh-evolution-flywheel] evidence search failed:', error)
      return undefined
    }

    const evidence = rawEvidence.slice(0, 3)
      .map(item => ({
        title: sanitize(item.title, 120),
        url: sanitize(item.url, 500),
        snippet: sanitize(item.snippet, 500),
      }))
      .filter(item => item.snippet !== '')
    if (evidence.length === 0) return undefined

    const evidenceSummary = evidence
      .map(item => `- ${item.title || item.url}: ${item.snippet}`)
      .join('\n')
    const summaryWithEvidence = `${previousSummary}\n场外证据：\n${evidenceSummary}`.trim()

    let appeal: DebateVerdict
    try {
      appeal = await this.driver.appeal(record, review, evidence)
    } catch (error) {
      console.error('[dsh-evolution-flywheel] evidence appeal failed:', error)
      return this.patch(id, {
        status: 'human_intervention',
        debateSummary: review.reason,
      })
    }

    const meta = appeal.metaInsight === undefined ? undefined : clampMetaInsight(appeal.metaInsight)
    if (appeal.converged && appeal.decision === 'approve') {
      return this.patch(id, {
        status: 'approved',
        debateSummary: summaryWithEvidence,
        ...(appeal.tokensUsed !== undefined
          ? { debateTokens: (record.debateTokens ?? 0) + appeal.tokensUsed }
          : {}),
        ...(meta !== undefined ? { metaInsight: meta } : {}),
        ...(appeal.resolution !== undefined && appeal.resolution.trim() !== ''
          ? { resolution: sanitize(appeal.resolution, 1000) }
          : {}),
      })
    }

    return this.patch(id, {
      status: 'human_intervention',
      debateSummary: `${summaryWithEvidence}\n场外证据仍未说服母 Agent。`.slice(0, 800),
      ...(appeal.tokensUsed !== undefined
        ? { debateTokens: (record.debateTokens ?? 0) + appeal.tokensUsed }
        : {}),
      ...(meta !== undefined ? { metaInsight: meta } : {}),
    })
  }

  private safeRecord(record: MemoryRecord): MemoryRecord {
    return {
      ...record,
      errorSignature: sanitize(record.errorSignature ?? '', 300),
      context: sanitize(record.context ?? '', 500),
      ...(record.resolution !== undefined ? { resolution: sanitize(record.resolution, 1000) } : {}),
    }
  }

  private errorText(error: unknown): string {
    return sanitize(error instanceof Error ? error.message : String(error), 300)
  }
}

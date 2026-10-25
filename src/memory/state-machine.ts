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
import { appendAudit } from '../audit.js'
import { readBudget } from './budget.js'
import type { MemoryEventHub } from './events.js'
import { clampMetaInsight, sanitizeText } from './sanitize.js'

const sanitize = (value: unknown, maxLength = 1000): string =>
  sanitizeText(value, maxLength, '状态机')
import type { DebateRound, MemoryRecord, MemoryStore } from './store.js'
import type { StrategyHooks } from './strategy.js'

/**
 * 可重试的模型失败：思考型模型把额度吃光、流式连接中断。
 * 这些是瞬时/容量问题，重试一次的成本远小于把记录永久钉进 human_intervention。
 * 鉴权、配置、请求格式错误不可重试（重试只会重复失败）。
 */
const RETRYABLE_MODEL_ERROR = /max-tokens|未输出正文|连接中断|流式响应中断|ECONNRESET|socket hang up|fetch failed/iu

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
  /** 母 Agent 初审；strategyHint 是提炼前自动注入的方法论。 */
  review(record: MemoryRecord, strategyHint?: string): Promise<ReviewVerdict>
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
    private readonly strategy?: StrategyHooks,
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

      // 提炼前：自动读取最近最成功的 2-3 条方法论，注入初审提示词。
      let strategyText = ''
      let strategyNames: string[] = []
      if (this.strategy !== undefined) {
        try {
          const injection = await this.strategy.injection(3)
          strategyText = injection.text
          strategyNames = injection.names
        } catch (error) {
          console.error('[dsh-evolution-flywheel] strategy injection failed:', error)
        }
      }

      await this.patch(key, {
        status: 'under_review',
        reviewRound: 1,
        ...(strategyNames.length > 0
          ? {
            trace: [
              ...(record.trace ?? []),
              `提炼前注入 ${strategyNames.length} 条策略：${strategyNames.join(' / ').slice(0, 160)}`,
            ].slice(-10),
          }
          : {}),
      })

      const task = `排错经验：${record.errorSignature ?? record.content}｜上下文：${record.context ?? '未记录'}`
      const safeRecord = this.safeRecord(record)
      let verdict: ReviewVerdict
      try {
        verdict = await this.driver.review(safeRecord, strategyText)
      } catch (error) {
        const message = this.errorText(error)
        // 容量/瞬时错误重试一次；仍失败才升级人工，避免一次饿死就永久堆积。
        if (!RETRYABLE_MODEL_ERROR.test(message)) {
          return this.reflectAfter(
            await this.humanIntervention(key, `初审失败：${message}`),
            task,
            `初审失败：${message}`,
          )
        }
        try {
          verdict = await this.driver.review(safeRecord, strategyText)
        } catch (retryError) {
          const retryMessage = this.errorText(retryError)
          return this.reflectAfter(
            await this.humanIntervention(key, `初审失败（已重试）：${retryMessage}`),
            task,
            `初审失败（已重试）：${retryMessage}`,
          )
        }
      }

      const reviewReason = sanitize(verdict.reason, 500)
      // 记录审阅结论：批评者采纳率要靠它关联（批评有意见 → 最终是否被驳回）。
      appendAudit('memory.review.verdict', {
        id: record.id,
        decision: verdict.decision,
        flywheel: 'comprehend',
      })
      if (verdict.decision === 'approve') {
        return this.reflectAfter(
          await this.patch(key, {
            status: 'approved',
            reviewReason,
            ...(verdict.resolution !== undefined && verdict.resolution.trim() !== ''
              ? { resolution: sanitize(verdict.resolution, 1000) }
              : {}),
            ...(verdict.tokensUsed !== undefined ? { reviewTokens: verdict.tokensUsed } : {}),
            ...(verdict.metaInsight !== undefined ? { metaInsight: clampMetaInsight(verdict.metaInsight) } : {}),
          }),
          task,
          `初审通过：${reviewReason}${verdict.resolution === undefined ? '' : `｜建议解决：${verdict.resolution}`}`,
        )
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
        const message = this.errorText(error)
        if (!RETRYABLE_MODEL_ERROR.test(message)) {
          return this.reflectAfter(
            await this.humanIntervention(key, `辩论失败：${message}`),
            task,
            `辩论失败：${message}`,
          )
        }
        // 同样的容量/瞬时错误策略：重试一次再升级人工。
        try {
          debate = await this.driver.debate(safeRecord, review)
        } catch (retryError) {
          const retryMessage = this.errorText(retryError)
          return this.reflectAfter(
            await this.humanIntervention(key, `辩论失败（已重试）：${retryMessage}`),
            task,
            `辩论失败（已重试）：${retryMessage}`,
          )
        }
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
        if (withEvidence !== undefined) {
          return this.reflectAfter(
            withEvidence,
            task,
            `开卷申诉后状态：${withEvidence.status === 'approved' ? '证据说服母 Agent，已通过' : '证据仍不足以推翻驳回，交人类裁决'}`,
          )
        }
        return this.reflectAfter(
          await this.patch(key, {
            status: 'human_intervention',
            debateSummary,
            humanInterventions: (record.humanInterventions ?? 0) + 1,
            ...(challenge !== '' ? { challenge } : {}),
            ...(debateRounds.length > 0 ? { debateRounds } : {}),
            ...(debate.tokensUsed !== undefined ? { debateTokens: debate.tokensUsed } : {}),
            ...(metaInsight !== undefined ? { metaInsight } : {}),
          }),
          task,
          `辩论未收敛：${debateSummary || '双方未达成一致'}`,
        )
      }

      return this.reflectAfter(
        await this.patch(key, {
          status: debate.decision === 'approve' ? 'approved' : 'rejected',
          debateSummary,
          ...(challenge !== '' ? { challenge } : {}),
          ...(debateRounds.length > 0 ? { debateRounds } : {}),
          ...(debate.tokensUsed !== undefined ? { debateTokens: debate.tokensUsed } : {}),
          ...(metaInsight !== undefined ? { metaInsight } : {}),
          ...(debate.decision === 'approve' && debate.resolution !== undefined && debate.resolution.trim() !== ''
            ? { resolution: sanitize(debate.resolution, 1000) }
            : {}),
        }),
        task,
        `辩论收敛，裁决${debate.decision === 'approve' ? '通过' : '驳回'}：${debateSummary || '无摘要'}`,
      )
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
      // 人类采纳 = 这条解法被验证过；recall 才能放心说「请优先参考」。
      ...(decision === 'adopt' && typeof record.resolution === 'string' && record.resolution.trim() !== ''
        ? { resolutionSource: 'verified' as const }
        : {}),
    })
  }

  /** 小提炼收尾：强迫后置反思并入库为策略候选；失败不阻塞主流程。 */
  private async reflectAfter(
    item: MemoryRecord | undefined,
    task: string,
    outcome: string,
  ): Promise<MemoryRecord | undefined> {
    if (this.strategy === undefined || item === undefined) return item
    // 交人类裁决时不额外消耗 LLM；预算耗尽时也跳过反思。
    if (item.status === 'human_intervention') return item
    try {
      const budget = await readBudget(this.store)
      if (budget.exceeded) return item
      await this.strategy.reflect({ stage: 'small', task, outcome })
    } catch (error) {
      console.error('[dsh-evolution-flywheel] strategy reflection failed:', error)
    }
    return item
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
    const current = (await this.store.list()).find(item => item.id === id)
    return this.patch(id, {
      status: 'human_intervention',
      debateSummary: sanitize(reason, 800),
      humanInterventions: (current?.humanInterventions ?? 0) + 1,
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

    // 用最新记录作为基线，避免丢失本轮辩论产生的 token。
    const fresh = (await this.store.list()).find(item => item.id === id)
    const baseDebateTokens = fresh?.debateTokens ?? record.debateTokens ?? 0

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
          ? { debateTokens: baseDebateTokens + appeal.tokensUsed }
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
        ? { debateTokens: baseDebateTokens + appeal.tokensUsed }
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

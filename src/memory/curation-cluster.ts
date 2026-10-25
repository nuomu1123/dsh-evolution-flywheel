/**
 * 整理 Agent 集群（阶段 3 的最小形态）。
 *
 * 三个角色，共享同一份记忆池：
 * - classifier：规则分类（保留 / 归档 / 高价值 / 重复）；
 * - red-team：只负责挑刺，专查“误归档”和“合并误判”；
 * - reporter：汇总分类与红队意见，输出最终待裁决报告。
 *
 * 第一版是同进程顺序执行（规则引擎零成本）；跨进程并行要等锁与调度再演进。
 */
import {compactCurationPayload,  buildCurationReport, buildProbeEvidence, shouldRunCuration, summarizeCurationQuality, summarizeCurationWithLlm } from './curator.js'
import { createProbe } from './probes.js'
import { memorySalience } from './decay.js'
import type { MemoryContextBase } from './context.js'
import type { MemoryEventHub } from './events.js'
import type {
  CurationReportPayload,
  CurationRoleTrace,
  CurationTrigger,
} from './curation-shared.js'
import type { MemoryRecord, MemoryStore } from './store.js'

export interface RedTeamReview {
  risks: string[]
  summary: string
}

/** 红队：只根据报告与记忆池挑刺，不改写主报告。 */
export function reviewCurationReport(
  items: readonly MemoryRecord[],
  payload: CurationReportPayload,
): RedTeamReview {
  const byId = new Map(items.map(item => [item.id, item]))
  const risks: string[] = []
  for (const entry of payload.archive) {
    const item = byId.get(entry.id)
    if (item === undefined) continue
    if (memorySalience(item) >= 0.55) {
      risks.push(`红队：${entry.content} 仍有较高显著性，归档前请复核`)
    }
    if ((item.humanInterventions ?? 0) > 0) {
      risks.push(`红队：${entry.content} 曾进入人类裁决，归档前请确认不是误判`)
    }
  }
  if (payload.merge.length > 0) {
    risks.push(`红队：${payload.merge.length} 组重复/相似候选需要人工确认，不要自动合并`)
  }
  const unique = [...new Set(risks)].slice(0, 8)
  return {
    risks: unique,
    summary: unique.length === 0
      ? '红队：未发现需要额外复核的风险'
      : `红队：发现 ${unique.length} 条需复核风险`,
  }
}

/** 集群入口：classifier → red-team → reporter，返回带角色痕迹的报告。 */
export async function runCurationCluster(
  items: readonly MemoryRecord[],
  now = Date.now(),
  trigger: CurationTrigger = 'manual',
): Promise<CurationReportPayload> {
  const classifierStart = Date.now()
  const payload = buildCurationReport(items, now, trigger)
  const classifier: CurationRoleTrace = {
    name: 'classifier',
    summary: payload.summary,
    elapsedMs: Date.now() - classifierStart,
  }

  const redStart = Date.now()
  const red = reviewCurationReport(items, payload)
  const redTeam: CurationRoleTrace = {
    name: 'red-team',
    summary: red.summary,
    elapsedMs: Date.now() - redStart,
  }

  const reporterStart = Date.now()
  payload.risks = [...new Set([...payload.risks, ...red.risks])].slice(0, 10)
  payload.quality = summarizeCurationQuality(items)
  payload.roles = [
    classifier,
    redTeam,
    {
      name: 'reporter',
      summary: '汇总规则分类与红队意见，生成待人类裁决的报告',
      elapsedMs: Date.now() - reporterStart,
    },
  ]
  return payload
}

/**
 * 后台集群整理调度：每 30 分钟检查，满足阈值才生成报告。
 * 只生成待裁决报告；单飞保护，LLM 摘要失败回退规则摘要。
 */
export function registerCurationSchedule(
  ctx: MemoryContextBase,
  store: MemoryStore,
  events: MemoryEventHub,
  intervalMs = 30 * 60_000,
): void {
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    try {
      const items = await store.list()
      const last = items
        .filter(item => item.type === 'curation_report')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      const parsed = last === undefined ? Number.NaN : Date.parse(last.createdAt)
      if (!shouldRunCuration(items, Number.isFinite(parsed) ? parsed : undefined)) return
      running = true
      const payload = await runCurationCluster(items, Date.now(), 'threshold')
      const llm = typeof ctx.get === 'function' && ctx.get('llm') !== undefined
        ? await summarizeCurationWithLlm(ctx, store, payload)
        : undefined
      // 只有真正拿到摘要才写入；llm.error 存在时 text 通常为空，
      // 写进去会让报告显示"摘要已生成"却没有任何内容。
      if (llm !== undefined && llm.error === undefined) payload.llmSummary = llm.text
      if (llm?.probe !== undefined) {
        await createProbe(store, {
          question: llm.probe.question,
          reason: llm.probe.reason,
          source: 'curation',
          context: buildProbeEvidence(payload, items),
        }).catch(error => {
          console.error('[dsh-evolution-flywheel] curation probe failed:', error)
        })
      }
      const created = await store.appendSuggested(`整理报告：${payload.summary}`, 'curation_report')
      if (created === undefined) return
      const updated = await store.update(created.id, {
        reportJson: JSON.stringify(compactCurationPayload(payload)),
        ...(llm === undefined ? {} : { reviewTokens: llm.tokensUsed }),
        origin: 'curation',
        originDetail: '后台集群整理（待人类裁决）',
        trace: [
          payload.summary,
          ...(payload.roles ?? []).map(role => `${role.name}：${role.summary}`),
          ...(llm === undefined
            ? []
            : [llm.error === undefined ? 'AI 审查摘要已生成' : `AI 审查摘要失败：${llm.error}`]),
          ...payload.risks,
        ].slice(0, 10),
      })
      events.publish({ type: 'memory:added', item: updated ?? created })
    } catch (error) {
      console.error('[dsh-evolution-flywheel] curation schedule failed:', error)
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

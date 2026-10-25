/**
 * 可调参数集中在这里，避免夜间漫游时间和成本上限散落在代码里。
 * 所有值都可以通过环境变量覆盖；不包含任何密钥。
 */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

export const memoryConfig = {
  /** 每日漫游 cron，默认凌晨 03:00。 */
  dmaCron: process.env.DSH_DMA_CRON?.trim() || '0 3 * * *',
  /** 调度器检查间隔。 */
  dmaTickMs: envInt('DSH_DMA_TICK_MS', 30_000, 5_000, 300_000),
  /** 单次夜间漫游总 token 熔断线。 */
  dmaTokenLimit: envInt('DSH_DMA_TOKEN_LIMIT', 50_000, 1_000, 200_000),
  /** 直连 LLM 单次输出上限。 */
  dmaMaxTokens: envInt('DSH_DMA_MAX_TOKENS', 800, 100, 4_000),
  /** 单次会话搜索调用上限。 */
  dmaSearchLimit: envInt('DSH_DMA_SEARCH_LIMIT', 5, 1, 10),
  /** 喂给模型的外部证据条数上限。 */
  dmaEvidenceLimit: envInt('DSH_DMA_EVIDENCE_LIMIT', 3, 1, 5),
  /**
   * 子母审阅/单轮辩论的单次输出上限。
   * 2026-10-25 实测：思考型模型一次 reasoning 就 1900–3200 字，500/900 会让模型把额度
   * 全花在思考上、不输出正文，失败记录被直接钉进 human_intervention（当时 24/119 条）。
   * 这里给 reasoning 留出空间；配合 state-machine 的「可重试错误再试一次」。
   */
  reviewMaxTokens: envInt('DSH_MEMORY_REVIEW_MAX_TOKENS', 2000, 200, 4_000),
  /** 对抗辩论单次输出上限（含逐轮发言）。 */
  debateMaxTokens: envInt('DSH_MEMORY_DEBATE_MAX_TOKENS', 2000, 200, 4_000),
} as const

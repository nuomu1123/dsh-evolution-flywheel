/**
 * 记忆的“时间感”与“显著性”。
 *
 * - 遗忘曲线：按类型半衰期 + 显著性延长，计算保留率；
 * - 时间感知：注入时标注“N 天前”，过期提示重新验证；
 * - 显著性：人类干预次数与重复报错次数放大权重，注入时高亮红线。
 *
 * 纯函数，服务端与客户端共用；不读文件、不依赖宿主。
 */

export interface MemoryPerception {
  type: string
  createdAt: string
  lastSeenAt?: string
  lastRecalledAt?: string
  count?: number
  humanInterventions?: number
}

/** 各类型的基础半衰期（天）：排错经验比偏好衰减快得多。 */
const HALF_LIFE_DAYS: Record<string, number> = {
  skill_error_fix: 14,
  meta_insight: 7,
  speculative: 7,
  conflict: 30,
  mental_model: 60,
  extraction_strategy: 30,
  fact: 90,
  preference: 365,
}

const DEFAULT_HALF_LIFE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

/** 距离“最后一次被看见/被召回”的天数；无有效时间时返回 0。 */
export function memoryAgeDays(record: MemoryPerception, now = Date.now()): number {
  const base = parseTime(record.lastRecalledAt)
    ?? parseTime(record.lastSeenAt)
    ?? parseTime(record.createdAt)
  if (base === undefined) return 0
  return Math.max(0, (now - base) / DAY_MS)
}

/**
 * 显著性 0-1：
 * - 人类干预一次 +0.25（最多 3 次）；
 * - 同一错误重复 3 次以上按次数递增（最多 +0.35）；
 * - 基础 0.15。
 */
export function memorySalience(record: MemoryPerception): number {
  const human = Math.min(Math.max(record.humanInterventions ?? 0, 0), 3)
  const repeats = Math.max(record.count ?? 1, 1)
  const repeatBoost = repeats >= 3 ? Math.min((repeats - 2) * 0.08, 0.35) : 0
  return Math.min(1, 0.15 + human * 0.25 + repeatBoost)
}

/** 保留率 0-1：半衰期随显著性延长，高显著记忆更难褪色。 */
export function memoryFreshness(record: MemoryPerception, now = Date.now()): number {
  const halfLife = (HALF_LIFE_DAYS[record.type] ?? DEFAULT_HALF_LIFE_DAYS)
    * (1 + memorySalience(record) * 2)
  const days = memoryAgeDays(record, now)
  return Math.exp(-Math.LN2 * days / halfLife)
}

/** 低于阈值视为“褪色”，默认 0.2。 */
export function isFaded(record: MemoryPerception, now = Date.now(), threshold = 0.2): boolean {
  return memoryFreshness(record, now) < threshold
}

/** 注入用的一行感知标签：`7 天前 · 保留 42%`，显著时追加警示。 */
export function perceptionLabel(record: MemoryPerception, now = Date.now()): string {
  const days = Math.floor(memoryAgeDays(record, now))
  const retention = Math.round(memoryFreshness(record, now) * 100)
  const age = days === 0 ? '今天' : `${days} 天前`
  const salience = memorySalience(record)
  const flags: string[] = []
  if (retention < 50) flags.push('环境可能已变，建议重新验证')
  if (salience >= 0.8) flags.push('⚠️ 致命红线')
  else if (salience >= 0.55) flags.push('高显著')
  return [`${age} · 保留 ${retention}%`, ...flags].join(' · ')
}

/** 是否需要提醒模型“先验证再沿用”。 */
export function needsVerification(record: MemoryPerception, now = Date.now()): boolean {
  return memoryFreshness(record, now) < 0.5
}

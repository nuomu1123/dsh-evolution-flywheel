/**
 * 防御护城河之一：文本消毒。
 *
 * 只做“中和/降级”，不执行任何内容；用于错误捕获、LLM 审阅与辩论输入。
 * 命中可疑模式时写入内存环形日志，供前端“安全拦截日志”实时展示。
 */
import { appendAudit } from '../audit.js'

const INJECTION_PATTERNS: readonly RegExp[] = [
  /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|above|prior)?\s*(?:instructions?|prompts?)/giu,
  /忽略.{0,16}(?:之前|以上|前面)?.{0,8}(?:指令|提示|规则)/gu,
  /(?:system|developer)\s+prompt/giu,
  /系统提示词?/gu,
  /you\s+are\s+now|你现在是|从现在开始你/giu,
  /(?:执行|运行|run)\s*(?:以下|下列|the\s+following)/giu,
  /(?:curl|wget|powershell|cmd\.exe|bash)\s+[^\n]{0,200}/giu,
  /(?:rm\s+-rf|del\s+\/f|format\s+[a-z]:)/giu,
]

const INJECTION_LABELS: readonly string[] = [
  '英文提示词覆盖',
  '中文提示词覆盖',
  '英文系统提示词',
  '中文系统提示词',
  '角色劫持',
  '命令执行指令',
  '远程命令下载',
  '破坏性命令',
]

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/gu

export interface SecurityIntercept {
  /** 单次进程内递增序号。 */
  id: number
  /** ISO 时间。 */
  time: string
  /** 调用方标注的来源，例如 web-search / memory-write / review-prompt。 */
  source: string
  /** 命中的规则名称，多个用顿号连接。 */
  pattern: string
  /** 原文片段，最多 80 字，仅用于人工判断，不落盘。 */
  excerpt: string
}

const INTERCEPT_LIMIT = 50
const intercepts: SecurityIntercept[] = []
let interceptSeq = 0

/** 最近的安全拦截记录（新到旧），只保存在当前进程内。 */
export function listSecurityIntercepts(): readonly SecurityIntercept[] {
  return intercepts.slice()
}

/** 测试与手动清理用：清空环形日志。 */
export function resetSecurityIntercepts(): void {
  intercepts.length = 0
  interceptSeq = 0
}

function recordIntercept(source: string, original: string, patterns: readonly string[]): void {
  if (patterns.length === 0) return
  const normalizedSource = source.trim()
  const excerpt = original
    .replace(CONTROL_CHARS, ' ')
    .replace(ZERO_WIDTH, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80)
  const entry: SecurityIntercept = {
    id: ++interceptSeq,
    time: new Date().toISOString(),
    source: normalizedSource === '' ? 'unknown' : normalizedSource.slice(0, 40),
    pattern: patterns.join('、'),
    excerpt: excerpt === '' ? '（空）' : excerpt,
  }
  intercepts.unshift(entry)
  appendAudit('security.intercept', {
    source: entry.source,
    pattern: entry.pattern,
    excerpt: entry.excerpt,
  })
  if (intercepts.length > INTERCEPT_LIMIT) intercepts.length = INTERCEPT_LIMIT
}

/**
 * 过滤控制字符、零宽字符和常见提示词注入指令。
 * @param value 原始文本。
 * @param maxLength 最大保留长度。
 * @param source 拦截日志的来源标注；默认 unknown。
 * @param record 是否写入拦截日志；读取归一化等路径可传 false。
 * @returns 可安全送入 LLM/存储的文本。
 */
export function sanitizeText(value: unknown, maxLength = 1000, source = 'unknown', record = true): string {
  const original = String(value ?? '')
  let text = original
    .replace(CONTROL_CHARS, '')
    .replace(ZERO_WIDTH, '')

  const hits: string[] = []

  // HTML 实体先还原，再剥离标签，避免 <system> 等标签藏在实体里。
  text = text
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&amp;/giu, '&')

  const beforeHidden = text
  text = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
  if (text !== beforeHidden) hits.push('HTML隐藏区块')

  text = text.replace(/<[^>]{0,500}>/gu, ' ')

  // 长 base64 串通常是网页隐藏文本，直接移除，不尝试执行/解码。
  const beforeBase64 = text
  text = text.replace(/[A-Za-z0-9+/]{80,}={0,2}/gu, '[已移除的base64隐藏文本]')
  if (text !== beforeBase64) hits.push('base64隐藏文本')

  for (let index = 0; index < INJECTION_PATTERNS.length; index += 1) {
    const pattern = INJECTION_PATTERNS[index]
    if (pattern === undefined) continue
    const before = text
    text = text.replace(pattern, '[已过滤的潜在注入内容]')
    if (text !== before) hits.push(INJECTION_LABELS[index] ?? '可疑注入指令')
  }

  if (hits.length > 0 && record) recordIntercept(source, original, hits)

  return text
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
    .slice(0, Math.max(0, maxLength))
}

/** 元认知结论硬限制 100 字。 */
export function clampMetaInsight(value: unknown): string {
  return sanitizeText(value, 100)
}

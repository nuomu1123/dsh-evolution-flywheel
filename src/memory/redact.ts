/**
 * 敏感信息脱敏层（2026-10-24 体检后补）。
 *
 * 为什么必须有这一层：
 * - `skill-extractor` 会把失败工具的**参数原文**写进记忆的 context；
 * - `browser-observer` 会把浏览器 URL 与操作参数写进记忆；
 * - 记忆会通过 SSE 广播到 Web 面板，并可能被导出/检索。
 *
 * 而浏览器 URL 常带 `?token=`，登录表单里有密码，命令里可能带 API Key。
 * 原样落盘等于把凭据写进日志。所有「工具调用 → 记忆」的写入路径都必须先过这里。
 *
 * 原则：**宁可少记一点，也不落凭据**。URL 的 query/hash 一律不落盘（它们最常藏 token）。
 */

/** 整个字段都算敏感的键名（值直接打码）。 */
const SENSITIVE_KEY = /^(password|passwd|pwd|token|access_?token|refresh_?token|secret|api_?key|apikey|authorization|auth|cookie|session|session_?id|otp|captcha|验证码|密码|口令)$/iu

/** 自由文本里的凭据形态。 */
const TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // ?token=xxx / &api_key=xxx / #access_token=xxx
  [/([?&#](?:token|access_?token|refresh_?token|api_?key|apikey|key|secret|password|passwd|pwd|session|session_?id|otp|code)=)[^&#\s"']+/giu, '$1***'],
  // Authorization: Bearer xxx
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gu, '$1***'],
  // 常见平台密钥前缀
  [/\b(sk|ak|ghp|gho|ghs|github_pat|xoxb|xoxp)[-_][A-Za-z0-9_-]{8,}/gu, '$1_***'],
  // 邮件/手机号这类可识别信息，只保留形态提示（避免记忆里堆积他人隐私）
  [/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/gu, '***@$2'],
]

/** 对自由文本做凭据打码，再截断。 */
export function redactText(text: string, max = 200): string {
  let out = text
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out.slice(0, max)
}

/**
 * URL 脱敏：只保留「协议 + 主机 + 路径」，query 与 hash 一律丢弃。
 * 非 http(s) 的特殊页（about:/data:）原样截断；无法解析时退回文本打码。
 */
export function redactUrl(url: string, max = 300): string {
  const trimmed = url.trim()
  if (trimmed === '') return ''
  if (/^(about|data|file):/iu.test(trimmed)) return redactText(trimmed, Math.min(max, 120))
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return redactText(trimmed, Math.min(max, 120))
    }
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.protocol}//${parsed.host}${path}`.slice(0, max)
  } catch {
    return redactText(trimmed, max)
  }
}

/** 递归打码：敏感键整值替换为 ***，字符串走文本规则。 */
function maskValue(value: unknown, depth: number): unknown {
  if (depth > 6) return '…'
  if (Array.isArray(value)) return value.slice(0, 20).map(item => maskValue(item, depth + 1))
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    // 形如 { name: 'pwd', value: 'hunter2' } 的结构：敏感词在值里而不是键里。
    const nameHint = ['name', 'key', 'field', 'label'].some(key => {
      const hint = record[key]
      return typeof hint === 'string' && SENSITIVE_KEY.test(hint.trim())
    })
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) {
      if (SENSITIVE_KEY.test(key) || (nameHint && (key === 'value' || key === 'text'))) {
        out[key] = '***'
      } else {
        out[key] = maskValue(item, depth + 1)
      }
    }
    return out
  }
  if (typeof value === 'string') return redactText(value, 300)
  return value
}

/**
 * 工具参数脱敏后的摘要。
 * 解析失败时退回原文打码（至少不会把 `?token=` 写进去）。
 */
export function redactArgs(raw: string | undefined, max = 200): string {
  if (raw === undefined || raw.trim() === '') return '无参数'
  try {
    const value: unknown = JSON.parse(raw)
    return JSON.stringify(maskValue(value, 0)).slice(0, max)
  } catch {
    return redactText(raw.trim(), max)
  }
}

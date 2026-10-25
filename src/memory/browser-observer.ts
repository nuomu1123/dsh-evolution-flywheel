/**
 * 浏览器观察器：把 `browser_*` 的「不可逆动作」写进 MemoryStore。
 *
 * 为什么是「不可逆动作」而不是「全部浏览器操作」：
 * - 失败（isError / data.error）已由 skill-extractor 统一捕获，这里再记就是重复；
 * - 只读浏览（snapshot / find / screenshot）量级大、价值低，记了就是噪音；
 * - 真正缺的是「成功但不可逆」的动作 —— 点提交、上传文件、确认对话框、执行任意代码。
 *   这些正是浏览器纪律第 3 条要求先说明后果再执行的高风险动作，必须留痕。
 *
 * 数据来源是宿主同一条 `session/event` 流里的 `tool/call` 与 `tool/result`，
 * 与 skill-extractor 共用事件源，不需要解析会话日志、也不跨进程。
 *
 * 隐私边界（2026-10-24 补）：URL 的 query/hash 一律不落盘（常藏 token），
 * 密码类输入与敏感键值统一打码，见 `redact.ts`。
 */
import type { MemoryContextBase } from './context.js'
import type { MemoryEventHub } from './events.js'
import { redactArgs, redactText, redactUrl } from './redact.js'
import type { MemoryStore } from './store.js'

/** 会产生真实副作用的浏览器工具（与 browser-audit.mjs 的 SIDE_EFFECT 保持一致）。 */
const SIDE_EFFECT = new Set([
  'browser_click', 'browser_type', 'browser_press_key', 'browser_drag', 'browser_drop',
  'browser_select_option', 'browser_fill_form', 'browser_file_upload', 'browser_handle_dialog',
  'browser_run_code_unsafe', 'browser_close',
  // evaluate 能执行任意 JS（含 fetch / localStorage / cookie 写入），
  // 旧分类把它算只读是盲区：只有「代码里带副作用」时才记录，避免调试噪音。
  'browser_evaluate',
])

/** 无论参数是什么都必须留痕：能执行任意代码 / 上传文件 / 处理确认框。 */
const ALWAYS_AUDIT = new Set([
  'browser_run_code_unsafe', 'browser_file_upload', 'browser_handle_dialog',
])

/** 参数里出现这些词，就视为不可逆动作（与浏览器纪律的清单一致）。 */
const IRREVERSIBLE_WORDS = /提交|保存|发送|删除|购买|支付|下单|确认|注销|清空|submit|send|delete|pay|buy|confirm|remove|clear/iu

/** 代码里的副作用形态（用于 browser_evaluate）：命中即留痕。 */
const CODE_SIDE_EFFECT = /fetch\s*\(|XMLHttpRequest|localStorage\s*\.|sessionStorage\s*\.|indexedDB|document\s*\.\s*cookie\s*=|location\s*\.\s*(?:href|assign|replace)/iu

/** 元素描述里出现这些词，说明输入内容可能是凭据，一律打码。 */
const SECRET_INPUT_HINT = /密码|password|passwd|口令|验证码|otp|secret|token/iu

const DEBOUNCE_MS = 5 * 60_000
const MAX_PENDING = 200

interface ToolEventLike {
  type?: string
  data?: {
    callId?: string
    name?: string
    arguments?: string
    message?: {
      toolCallId?: string
      isError?: boolean
      content?: Array<{ type?: string; text?: string }>
    }
    error?: { name?: string; code?: string; reason?: string }
  }
}

interface PendingCall {
  short: string
  summary: string
  at: number
}

export interface BrowserObserverContext extends MemoryContextBase {}

/** `mcp__playwright-mcp__browser_click` → `browser_click`；非浏览器工具返回空串。 */
function shortName(name: string): string {
  const index = name.lastIndexOf('__')
  const base = index >= 0 ? name.slice(index + 2) : name
  return base.startsWith('browser_') ? base : ''
}

function sessionId(session: unknown): string {
  if (typeof session === 'object' && session !== null && typeof (session as { id?: unknown }).id === 'string') {
    return (session as { id: string }).id
  }
  return 'unknown'
}

/**
 * 从参数 JSON 里挑出「点了什么」的关键字段。
 * - url 走 redactUrl（丢弃 query/hash）；
 * - text/value/fields 若元素描述提示是密码框，则整体打码；
 * - code 只保留前 80 字符（run_code_unsafe / evaluate 的证据）。
 */
function summarizeArgs(raw: string | undefined, max = 160): string {
  if (raw === undefined || raw.trim() === '') return '无参数'
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      const secretHint = SECRET_INPUT_HINT.test(
        ['element', 'target', 'selector']
          .map(key => (typeof record[key] === 'string' ? record[key] as string : ''))
          .join(' '),
      )
      const parts: string[] = []
      for (const key of ['url', 'element', 'target', 'selector', 'text', 'value', 'fields', 'query', 'code']) {
        const item = record[key]
        if (typeof item === 'string' && item.trim() !== '') {
          const trimmed = item.trim()
          if (key === 'url') {
            parts.push(`${key}=${redactUrl(trimmed, 120)}`)
          } else if ((key === 'text' || key === 'value' || key === 'fields') && secretHint) {
            parts.push(`${key}=***`)
          } else {
            parts.push(`${key}=${redactText(trimmed, 80)}`)
          }
        } else if (Array.isArray(item)) {
          parts.push(`${key}=${redactText(JSON.stringify(item), 80)}`)
        }
      }
      if (parts.length > 0) return parts.join('；').slice(0, max)
    }
  } catch {
    // 参数不是合法 JSON 时保留脱敏后的原文，至少让人知道传了什么。
  }
  return redactArgs(raw, max)
}

function urlOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'object' && value !== null) {
      const url = (value as Record<string, unknown>).url
      if (typeof url === 'string' && url.trim() !== '') return redactUrl(url.trim())
    }
  } catch {
    // 忽略：导航参数不是 JSON 时不影响其它工具。
  }
  return undefined
}

function shouldAudit(call: PendingCall): boolean {
  if (!SIDE_EFFECT.has(call.short)) return false
  if (ALWAYS_AUDIT.has(call.short)) return true
  if (IRREVERSIBLE_WORDS.test(call.summary)) return true
  return call.short === 'browser_evaluate' && CODE_SIDE_EFFECT.test(call.summary)
}

async function record(
  store: MemoryStore,
  events: MemoryEventHub,
  call: PendingCall,
  url: string | undefined,
  now: number,
): Promise<void> {
  const irreversible = ALWAYS_AUDIT.has(call.short) || IRREVERSIBLE_WORDS.test(call.summary)
  const content = `[浏览器审计] ${irreversible ? '不可逆动作' : '副作用动作'}：${call.short}`
    + `；页面：${url ?? '未记录'}；参数：${call.summary}`
  const created = await store.appendSuggested(content, 'fact')
  if (created === undefined) return
  const updated = await store.update(created.id, {
    // 审计留痕是机器事实，不是待人类确认的知识：直接 approved，
    // 否则每次不可逆点击都会往「待裁决」里加一条，稀释整理报告的注意力。
    status: 'approved',
    origin: 'browser-observer',
    originDetail: '浏览器副作用动作',
    trace: [`浏览器动作（${new Date(now).toISOString()}）：${call.short} → ${url ?? '未知页面'}`],
  })
  if (updated !== undefined) events.publish({ type: 'memory:updated', item: updated })
  else events.publish({ type: 'memory:added', item: created })
}

/**
 * 注册浏览器观察器；所有副作用都由 ctx.effect 清理。
 * `ctx.on` 缺失时静默跳过（与其它监听器一致，能力探测而非报错）。
 */
export function registerBrowserObserver(
  ctx: BrowserObserverContext,
  store: MemoryStore,
  events: MemoryEventHub,
): void {
  if (typeof ctx.on !== 'function') return
  const pending = new Map<string, PendingCall>()
  const lastSeen = new Map<string, number>()
  const latestUrl = new Map<string, string>()

  const onSessionEvent = (session: unknown, event: unknown): void => {
    try {
      const toolEvent = event as ToolEventLike
      const data = toolEvent.data
      const key = sessionId(session)

      if (toolEvent.type === 'tool/call') {
        const short = shortName(data?.name ?? '')
        if (short === '') return
        if (short === 'browser_navigate') {
          const url = urlOf(data?.arguments)
          if (url !== undefined) latestUrl.set(key, url)
        }
        if (data?.callId === undefined) return
        pending.set(data.callId, { short, summary: summarizeArgs(data.arguments), at: Date.now() })
        while (pending.size > MAX_PENDING) {
          const oldest = pending.keys().next().value
          if (oldest === undefined) break
          pending.delete(oldest)
        }
        return
      }

      if (toolEvent.type !== 'tool/result') return
      const message = data?.message
      // 失败交给 skill-extractor（它会把 context 写成「工具 xxx 执行失败」），避免双写。
      if (message?.isError === true || data?.error !== undefined) return
      const callId = message?.toolCallId ?? data?.callId
      if (callId === undefined) return
      const call = pending.get(callId)
      if (call === undefined) return
      pending.delete(callId)
      if (!shouldAudit(call)) return

      const url = latestUrl.get(key)
      const fingerprint = `${call.short}|${url ?? ''}|${call.summary}`
      const now = Date.now()
      const last = lastSeen.get(fingerprint)
      if (last !== undefined && now - last < DEBOUNCE_MS) return
      lastSeen.set(fingerprint, now)
      while (lastSeen.size > MAX_PENDING) {
        const oldest = lastSeen.keys().next().value
        if (oldest === undefined) break
        lastSeen.delete(oldest)
      }

      void record(store, events, call, url, now).catch(error => {
        console.error('[dsh-evolution-flywheel] browser audit capture failed:', error)
      })
    } catch (error) {
      console.error('[dsh-evolution-flywheel] browser observer handler failed:', error)
    }
  }

  try {
    ctx.effect(() => ctx.on('session/event', onSessionEvent))
  } catch (error) {
    console.error('[dsh-evolution-flywheel] browser observer registration failed:', error)
  }
}

/**
 * 外部情报检索适配器。
 *
 * 优先复用 DSH 已注册的 web_search 工具；一次搜索最多取 3 条来源。
 * 不直接访问网络，也不执行网页中的任何指令。
 */
import { randomUUID } from 'node:crypto'
import type { MemoryContextBase } from './context.js'
import { sanitizeText } from './sanitize.js'

const sanitize = (value: unknown, maxLength = 1000): string =>
  sanitizeText(value, maxLength, '网页搜索')
import type { EvidenceItem, EvidenceSearch } from './state-machine.js'

interface ToolResultLike {
  isError?: boolean
  value?: unknown
  content?: Array<{ type?: string; text?: string }>
}

interface ToolDefinitionLike {
  name: string
  execute(args: unknown, exec: Record<string, unknown>): Promise<ToolResultLike>
}

interface ToolsLike {
  get?(name: string): ToolDefinitionLike | undefined
  schemas?(): Array<{ name: string }>
  execute(input: Record<string, unknown>): Promise<ToolResultLike>
}

interface WebServiceLike {
  search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<unknown>
}

const SEARCH_TOOL_NAMES = ['web_search', 'web-search', 'search', 'mcp__search'] as const

/** 外部文本统一消毒，并留下可审计的拦截日志。 */
function externalText(value: unknown, maxLength: number): string {
  const raw = typeof value === 'string' ? value : ''
  if (raw === '') return ''
  const clean = sanitize(raw, maxLength)
  if (clean.includes('[已过滤的潜在注入内容]')) {
    console.error('[dsh-memory-minimal] sanitizeText intercepted a web injection payload')
  }
  return clean
}

function toolsOf(ctx: MemoryContextBase): ToolsLike | undefined {
  try {
    const value = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    if (typeof value !== 'object' || value === null) return undefined
    const tools = value as Partial<ToolsLike>
    if (typeof tools.execute !== 'function') return undefined
    return tools as ToolsLike
  } catch {
    return undefined
  }
}

function webOf(ctx: MemoryContextBase): WebServiceLike | undefined {
  try {
    const value = typeof ctx.get === 'function' ? ctx.get('web') : undefined
    if (typeof value !== 'object' || value === null) return undefined
    const web = value as Partial<WebServiceLike>
    return typeof web.search === 'function' ? web as WebServiceLike : undefined
  } catch {
    return undefined
  }
}

function sourcesFrom(value: unknown, limit: number): EvidenceItem[] {
  const sources: EvidenceItem[] = []
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const list = Array.isArray(record.sources) ? record.sources : []
    for (const entry of list.slice(0, limit)) {
      if (typeof entry !== 'object' || entry === null) continue
      const source = entry as Record<string, unknown>
      const url = externalText(source.url, 500)
      const title = externalText(source.title, 120) || url
      const snippet = externalText(
        typeof source.snippet === 'string'
          ? source.snippet
          : typeof source.description === 'string' ? source.description : '',
        500,
      )
      if (snippet !== '' || url !== '') sources.push({ title, url, snippet })
    }
    if (sources.length === 0 && typeof record.answer === 'string') {
      const answer = externalText(record.answer, 500)
      if (answer !== '') sources.push({ title: '搜索摘要', url: '', snippet: answer })
    }
  }
  return sources.slice(0, limit)
}

/** 创建宿主可用的搜索适配器：优先 web_search 工具，其次直接 ctx.web.search。 */
export function createToolEvidenceSearch(
  ctx: MemoryContextBase,
  scopeAgent?: object,
): EvidenceSearch | undefined {
  const tools = toolsOf(ctx)
  const web = webOf(ctx)

  let toolName: string | undefined
  if (tools !== undefined) {
    const visible = new Set((tools.schemas?.() ?? []).map(schema => schema.name))
    for (const name of SEARCH_TOOL_NAMES) {
      if (visible.has(name) || tools.get?.(name) !== undefined) {
        toolName = name
        break
      }
    }
  }
  if (toolName === undefined && web === undefined) return undefined

  return {
    async search(query: string, limit: number): Promise<EvidenceItem[]> {
      const max = Math.min(5, Math.max(1, limit))
      const cleanQuery = sanitize(query, 300)

      if (toolName !== undefined && tools !== undefined) {
        try {
          const result = await tools.execute({
            callId: randomUUID(),
            name: toolName,
            arguments: { queries: [cleanQuery] },
            ...(scopeAgent !== undefined ? { agent: scopeAgent } : {}),
            signal: AbortSignal.timeout(15_000),
          })
          if (result.isError !== true) {
            const items = sourcesFrom(result.value, max)
            if (items.length > 0) return items
          }
        } catch (error) {
          console.error('[dsh-memory-minimal] web_search tool failed, trying ctx.web:', error)
        }
      }

      if (web !== undefined) {
        try {
          const result = await web.search({ query: cleanQuery, maxResults: max }, AbortSignal.timeout(30_000))
          return sourcesFrom(result, max)
        } catch (error) {
          console.error('[dsh-memory-minimal] ctx.web.search failed:', error)
        }
      }

      return []
    },
  }
}

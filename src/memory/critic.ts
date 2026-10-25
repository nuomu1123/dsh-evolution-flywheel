/**
 * 分级批评者（heterogeneous critic）——**模板，不是标准答案**。
 *
 * 这段声明的意图，和代码同样重要：
 *
 * 1. 这里提供的只是**一套可粗略复用的模板**。默认路由（qwen2.5-coder:14b / qwen2.5:14b）
 *    只代表「本机当前能跑什么」，不代表「什么模型最适合批评」。
 * 2. 如果你的机器能部署其他家族的大模型（32B、其他厂商、云端 API），**请直接替换路由**：
 *    `DSH_MEMORY_CRITIC_CODE_MODEL` / `_TEXT_MODEL` / `_MEMORY_MODEL` / `_DISTILL_MODEL`。
 *    批评者的价值主要在「异构」——不同家族才照得见彼此的盲点；同族更强常常只是「更会同意自己」。
 * 3. 模板本身是**动态变化**的：提示词、严重度阈值、触发条件都应该随使用数据调整。
 *    请用 `/api/critic/stats` 的采纳率自己判断，而不是相信这里的默认值。
 * 4. 改变才是常态：今天合适的路由，明天可能就该换掉。不要把它当成固定标准。
 */

export type CriticKind = 'code' | 'text' | 'memory' | 'distill'

export interface CriticIssue {
  severity: 'high' | 'medium' | 'low'
  /** 出问题的位置（函数名、字段名、段落片段）。 */
  where: string
  /** 为什么是问题（一句话，≤300 字）。 */
  why: string
}

export interface CriticResult {
  ok: boolean
  /** 实际使用的批评者标识（模型名），便于记账与校准。 */
  critic: string
  issues: CriticIssue[]
  /** 降级原因：调用失败/超时/输出不可解析时给出，调用方应静默继续。 */
  degraded?: string
}

export interface CriticOptions {
  endpoint?: string
  routes?: Partial<Record<CriticKind, string>>
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_ROUTES: Record<CriticKind, string> = {
  code: 'qwen2.5-coder:14b',
  text: 'qwen2.5:14b',
  memory: 'qwen2.5:14b',
  distill: 'qwen2.5:14b',
}

/**
 * 当前路由（环境变量优先）。
 * 换成别的家族/更大的模型，只需要改环境变量——这是本模板最重要的可替换点。
 */
export function criticRoutes(): Record<CriticKind, string> {
  const pick = (env: string | undefined, fallback: string): string => {
    const value = env?.trim()
    return value === undefined || value === '' ? fallback : value
  }
  return {
    code: pick(process.env.DSH_MEMORY_CRITIC_CODE_MODEL, DEFAULT_ROUTES.code),
    text: pick(process.env.DSH_MEMORY_CRITIC_TEXT_MODEL, DEFAULT_ROUTES.text),
    memory: pick(process.env.DSH_MEMORY_CRITIC_MEMORY_MODEL, DEFAULT_ROUTES.memory),
    distill: pick(process.env.DSH_MEMORY_CRITIC_DISTILL_MODEL, DEFAULT_ROUTES.distill),
  }
}

/** Ollama 兼容端点；换成本地 vLLM/LM Studio（兼容 /api/chat 或 /v1/chat/completions）时改这里。 */
export function criticEndpoint(): string {
  const value = process.env.DSH_MEMORY_CRITIC_URL?.trim()
  return value === undefined || value === '' ? 'http://127.0.0.1:11434' : value
}

/** 批评者是否启用（默认关闭：批评会带来延迟，应由使用者在设置里主动打开）。 */
export function criticEnabled(): boolean {
  const raw = (process.env.DSH_MEMORY_CRITIC ?? '').trim().toLowerCase()
  return raw === 'on' || raw === '1' || raw === 'true'
}

/**
 * 各类任务的系统提示。
 *
 * 注意：这里刻意让批评者「只做它能做的事」，不做最终裁决——
 * 14B 级别模型抓「实现与声明不一致 / 前后矛盾 / 过度概括」很在行，
 * 抓「逻辑正确但世界不认」完全不行，后者只能靠真实反馈与人类。
 */
const KIND_PROMPTS: Record<CriticKind, string> = {
  code: [
    '你是只做结构检查的代码审阅者，不是设计评审。',
    '只找这几类问题：契约不一致（返回值/字段/schema 与声明不符）、明显的语法或类型错误、未处理的边界（null/空数组/超长输入）、异常的静默吞掉。',
    '不要评价命名风格、架构好坏、性能猜测。没有发现问题就返回空数组。',
  ].join('\n'),
  text: [
    '你是严格的一致性检查员，只核对文本内部是否自洽。',
    '只找这几类问题：前后矛盾、数字或日期不一致、结论超出所给证据、把推测写成事实。',
    '不要补充新知识，不要评判观点对错。没有发现问题就返回空数组。',
  ].join('\n'),
  memory: [
    '你是记忆库质检员，只检查这条记忆是否可被验证、是否会误导未来的自己。',
    '只找这几类问题：无法验证的断言、可能过时的环境假设（版本/路径/端口）、与常见事实明显冲突、缺失关键的适用边界。',
    '不要重写内容。没有发现问题就返回空数组。',
  ].join('\n'),
  distill: [
    '你是提炼结果检查员，只检查「压缩是否过度」。',
    '只找这几类问题：把单次经验写成普适规律、缺少反例或适用边界、与原素材的细节不一致、结论强度超过证据。',
    '不要提出新的规律。没有发现问题就返回空数组。',
  ].join('\n'),
}

const OUTPUT_SPEC = [
  '只输出严格 JSON，不要 Markdown 代码块，不要解释：',
  '{"issues":[{"severity":"high|medium|low","where":"位置","why":"一句话原因"}]}',
].join('\n')

interface OllamaChatResponse {
  message?: { content?: string }
  error?: string
}

/** 从模型输出里抽出第一个 JSON 对象（模型常加解释或代码块）。 */
function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

function normalizeIssues(value: unknown): CriticIssue[] {
  if (typeof value !== 'object' || value === null) return []
  const list = (value as { issues?: unknown }).issues
  if (!Array.isArray(list)) return []
  const issues: CriticIssue[] = []
  for (const entry of list.slice(0, 8)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const severity = record.severity === 'high' || record.severity === 'medium' ? record.severity : 'low'
    const where = typeof record.where === 'string' ? record.where.trim().slice(0, 120) : ''
    const why = typeof record.why === 'string' ? record.why.trim().slice(0, 300) : ''
    if (why === '') continue
    issues.push({ severity, where: where === '' ? '未标注位置' : where, why })
  }
  return issues
}

/**
 * 调用批评者。
 *
 * 永远不抛错：失败/超时/输出不可解析都返回 `ok:false` + `degraded`，
 * 由调用方静默继续——批评是增强项，不能阻断主流程。
 */
export async function criticize(
  input: { kind: CriticKind; content: string; question?: string },
  options: CriticOptions = {},
): Promise<CriticResult> {
  const kind = input.kind
  const model = options.routes?.[kind] ?? criticRoutes()[kind]
  const endpoint = options.endpoint ?? criticEndpoint()
  const timeoutMs = options.timeoutMs ?? 25_000
  const fetchImpl = options.fetchImpl ?? fetch
  const question = input.question?.trim() ?? ''
  const body = {
    model,
    stream: false,
    options: { temperature: 0.1, num_predict: 600 },
    messages: [
      { role: 'system', content: KIND_PROMPTS[kind] },
      {
        role: 'user',
        content: [
          question === '' ? '' : `要核对的问题：${question}`,
          '待检查内容：',
          input.content.slice(0, 6000),
          '',
          OUTPUT_SPEC,
        ].filter(line => line !== '').join('\n'),
      },
    ],
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${endpoint.replace(/\/+$/u, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      return { ok: false, critic: model, issues: [], degraded: `HTTP ${response.status}` }
    }
    const data = await response.json() as OllamaChatResponse
    if (typeof data.error === 'string' && data.error !== '') {
      return { ok: false, critic: model, issues: [], degraded: data.error.slice(0, 200) }
    }
    const text = data.message?.content ?? ''
    const parsed = extractJson(text)
    if (parsed === undefined) {
      return { ok: false, critic: model, issues: [], degraded: '输出无法解析为 JSON' }
    }
    return { ok: true, critic: model, issues: normalizeIssues(parsed) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, critic: model, issues: [], degraded: reason.slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

/** 供审计/记账使用的一行摘要，避免把整段批评写进日志。 */
export function criticSummary(result: CriticResult): string {
  if (!result.ok) return `${result.critic} 降级：${result.degraded ?? '未知原因'}`
  if (result.issues.length === 0) return `${result.critic} 无异议`
  const high = result.issues.filter(issue => issue.severity === 'high').length
  return `${result.critic} 提出 ${result.issues.length} 条（high ${high}）`
}

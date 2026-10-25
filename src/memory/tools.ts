/**
 * 记忆浏览器的 Host 工具：memory_list / memory_delete。
 *
 * 工具与 HTTP API 共用同一个 MemoryStore；工具供模型调用，HTTP API 供
 * Web UI 调用。两者都只操作插件自己的 JSONL 文件。
 */
import type { ToolDefinitionLike } from '../index.js'
import type { MemoryRecord, MemoryStore, MemoryType } from './store.js'

export interface MemoryToolContext {
  effect(callback: () => () => void): unknown
  tools: {
    register(definition: ToolDefinitionLike): () => void
  }
}

const MEMORY_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    content: { type: 'string' },
    type: { type: 'string' },
    status: { type: 'string' },
    createdAt: { type: 'string' },
    errorSignature: { type: 'string' },
    context: { type: 'string' },
    resolution: { type: 'string' },
  },
  required: ['id', 'content', 'type', 'status', 'createdAt'],
  additionalProperties: true,
}

function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export function memoryListTool(store: MemoryStore): ToolDefinitionLike {
  return {
    name: 'memory_list',
    description: 'List every memory stored by dsh-evolution-flywheel. Returns a JSON array of { id, content, type, createdAt }.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: { type: 'array', items: MEMORY_ITEM_SCHEMA },
      render: renderJson,
    },
    async execute(): Promise<MemoryRecord[]> {
      return store.list()
    },
  }
}

export function memorySearchTool(store: MemoryStore): ToolDefinitionLike {
  return {
    name: 'memory_search',
    description: 'Search local dsh-evolution-flywheel memories by text. Results are ranked by hit quality (content > error signature > context > resolution); archived entries are excluded and speculative notes are down-weighted. Multi-word queries default to AND; when nothing matches they are automatically relaxed to OR and the response carries relaxed:true (do NOT conclude "not found" from an empty AND). English/digit tokens match on word boundaries (SSE will not hit AssertionError); full-width text is normalized. Read-only; returns { items, total, truncated } — total is the full match count and truncated=true means more matched than returned (raise limit to see them).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        limit: { type: 'number', description: 'Maximum results, 1-50; defaults to 10.' },
        type: { type: 'string', description: 'Optional memory type filter: fact / preference / skill_error_fix / speculative / meta_insight / mental_model / extraction_strategy / curation_report / cognitive_probe / cognitive_brief.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          items: { type: 'array', items: MEMORY_ITEM_SCHEMA },
          total: { type: 'number' },
          truncated: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      render: renderJson,
    },
    async execute(args: unknown): Promise<{ items: MemoryRecord[]; total: number; truncated: boolean }> {
      const record = (args ?? {}) as { query?: unknown; limit?: unknown; type?: unknown }
      const query = typeof record.query === 'string' ? record.query : ''
      const limit = typeof record.limit === 'number' && Number.isFinite(record.limit) ? record.limit : 10
      // 类型过滤是可选的：只有传了合法类型才启用，避免模型乱传导致空结果。
      const requested = typeof record.type === 'string' ? record.type.trim() : ''
      const known: readonly MemoryType[] = ['fact', 'preference', 'skill_error_fix', 'conflict', 'speculative', 'meta_insight', 'mental_model', 'extraction_strategy', 'curation_report', 'cognitive_probe', 'cognitive_brief']
      const options = (known as readonly string[]).includes(requested) ? { type: requested as MemoryType } : {}
      const result = await store.searchWithTotal(query, limit, options)
      return {
        items: result.items,
        total: result.total,
        truncated: result.total > result.items.length,
        // AND 全空时已自动放宽为 OR；告诉调用方，避免误以为「库里没有」。
        ...(result.relaxed ? { relaxed: true, note: '多词 AND 无结果，已放宽为 OR（按命中词数排序）' } : {}),
      }
    },
  }
}

export function memoryDeleteTool(store: MemoryStore): ToolDefinitionLike {
  return {
    name: 'memory_delete',
    description: 'Delete one memory by id. Returns { ok, id, deleted }. Only dsh-evolution-flywheel\'s own memory store is touched.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The memory id to delete.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          deleted: { type: 'boolean' },
        },
        required: ['ok', 'id', 'deleted'],
        additionalProperties: false,
      },
      render: renderJson,
    },
    async execute(args: unknown): Promise<{ ok: true; id: string; deleted: boolean }> {
      const id = typeof (args as { id?: unknown } | null)?.id === 'string'
        ? (args as { id: string }).id.trim()
        : ''
      if (id === '') throw new Error('memory_delete requires a non-empty id')
      const deleted = await store.delete(id)
      return { ok: true, id, deleted }
    },
  }
}

export function memoryApproveTool(store: MemoryStore): ToolDefinitionLike {
  return {
    name: 'memory_approve',
    description: 'Approve one memory by id, changing its status from suggested to approved. Returns { ok, id, item }.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The memory id to approve.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderJson,
    },
    async execute(args: unknown): Promise<{ ok: true; id: string; item: unknown }> {
      const id = typeof (args as { id?: unknown } | null)?.id === 'string'
        ? (args as { id: string }).id.trim()
        : ''
      if (id === '') throw new Error('memory_approve requires a non-empty id')
      const item = await store.approve(id)
      if (item === undefined) throw new Error('memory_approve: memory not found')
      return { ok: true, id, item }
    },
  }
}

export function memoryProbeTool(store: MemoryStore): ToolDefinitionLike {
  return {
    name: 'memory_probe',
    description: 'Record the result of an active probe (a minimal experiment, console.log or test) that verifies or refutes a memory. Updates verifiedAt and confidence, appends a trace step, and returns the updated memory.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory id to verify.' },
        hypothesis: { type: 'string', description: 'What was uncertain and is being tested.' },
        evidence: { type: 'string', description: 'Observed result: stdout, exit code, or key output.' },
        verified: { type: 'boolean', description: 'true if the memory still holds; false if reality contradicted it.' },
      },
      required: ['id', 'hypothesis', 'evidence', 'verified'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderJson,
    },
    async execute(args: unknown): Promise<{ ok: true; id: string; item: unknown }> {
      const record = (args ?? {}) as {
        id?: unknown
        hypothesis?: unknown
        evidence?: unknown
        verified?: unknown
      }
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      const hypothesis = typeof record.hypothesis === 'string' ? record.hypothesis.trim().slice(0, 300) : ''
      const evidence = typeof record.evidence === 'string' ? record.evidence.trim().slice(0, 1000) : ''
      const verified = record.verified === true
      if (id === '' || hypothesis === '' || evidence === '') {
        throw new Error('memory_probe requires id, hypothesis and evidence')
      }
      const current = (await store.list()).find(item => item.id === id)
      if (current === undefined) throw new Error('memory_probe: memory not found')
      const now = new Date().toISOString()
      const base = current.confidence ?? 0.5
      const nextConfidence = Math.max(0, Math.min(1, verified ? base + 0.2 : base - 0.3))
      const item = await store.update(id, {
        verifiedAt: now,
        confidence: nextConfidence,
        // 探针结论要双向落地（2026-10-25 子 Agent 反馈发现的 bug）：
        // 成立标 verified；被推翻必须退回 inferred，否则被推翻的解法会继续冒充「已验证」。
        ...(typeof current.resolution === 'string' && current.resolution.trim() !== ''
          ? { resolutionSource: verified ? 'verified' as const : 'inferred' as const }
          : {}),
        trace: [
          ...(current.trace ?? []),
          `探针（${now}）：${hypothesis} → ${verified ? '验证成立' : '被现实推翻'}；结果：${evidence.slice(0, 200)}`,
        ].slice(-10),
      })
      if (item === undefined) throw new Error('memory_probe: update failed')
      console.error(
        `[dsh-evolution-flywheel] 主动探针：${hypothesis.slice(0, 60)} → ${verified ? '成立' : '推翻'}`,
      )
      return { ok: true, id, item }
    },
  }
}

export function memoryUpdateResolutionTool(store: MemoryStore): ToolDefinitionLike {  return {
    name: 'memory_update_resolution',
    description: 'Update the resolution text of one memory by id. Returns { ok, id, item }.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The memory id to update.' },
        resolution: { type: 'string', description: 'The new resolution text; empty clears it.' },
        verified: { type: 'boolean', description: 'true when this fix is confirmed by a human or a real reproduction; defaults to false (inferred).' },
      },
      required: ['id', 'resolution'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderJson,
    },
    async execute(args: unknown): Promise<{ ok: true; id: string; item: unknown }> {
      const record = (args ?? {}) as { id?: unknown; resolution?: unknown; verified?: unknown }
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      const resolution = typeof record.resolution === 'string' ? record.resolution : ''
      if (id === '') throw new Error('memory_update_resolution requires a non-empty id')
      // verified=true 表示这条解法已被人类确认或实测过，recall 会据此改写措辞。
      const item = await store.setResolution(id, resolution, record.verified === true ? 'verified' : 'inferred')
      if (item === undefined) throw new Error('memory_update_resolution: memory not found')
      return { ok: true, id, item }
    },
  }
}

/**
 * 主动沉淀：把「对话中得出的结论」写进记忆。
 *
 * 为什么需要它：错误捕获只覆盖「工具失败」，而像「禁用带客户端半的插件后必须重启」
 * 这种平台行为知识、以及用户的偏好/决策结论，都不是工具错误，靠自动捕获永远进不了库
 * （2026-10-25 真实使用反馈的 P1-3）。
 */
export function memoryRememberTool(store: MemoryStore): ToolDefinitionLike {
  return {
    name: 'memory_remember',
    description: 'Persist one conclusion as a memory (platform behaviour, troubleshooting conclusion, user preference or decision). Use this for knowledge that did NOT come from a tool failure — those are captured automatically. Returns { ok, id, item } or { ok: false, reason }.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The conclusion to remember, 1-2000 characters.' },
        type: { type: 'string', description: 'Memory type; defaults to fact. One of: fact / preference / skill_error_fix / mental_model / meta_insight / extraction_strategy.' },
        context: { type: 'string', description: 'Evidence or provenance: how it was verified, where it came from.' },
        errorSignature: { type: 'string', description: 'For skill_error_fix: the error signature (≤300 chars). Required for the memory to be recalled as a skill.' },
        resolution: { type: 'string', description: 'For skill_error_fix: the fix that worked (≤1000 chars). Without it the memory can be searched but never recalled as a skill.' },
        approved: { type: 'boolean', description: 'true when already verified (reproduced, confirmed by tests); defaults to false (suggested, waiting for human decision).' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderJson,
    },
    async execute(args: unknown): Promise<unknown> {
      const record = (args ?? {}) as {
        content?: unknown
        type?: unknown
        context?: unknown
        approved?: unknown
        errorSignature?: unknown
        resolution?: unknown
      }
      const content = typeof record.content === 'string' ? record.content.trim().slice(0, 2000) : ''
      if (content === '') throw new Error('memory_remember requires non-empty content')
      const requested = typeof record.type === 'string' ? record.type.trim() : ''
      const known: readonly MemoryType[] = ['fact', 'preference', 'skill_error_fix', 'mental_model', 'meta_insight', 'extraction_strategy']
      const type: MemoryType = (known as readonly string[]).includes(requested) ? requested as MemoryType : 'fact'
      const context = typeof record.context === 'string' ? record.context.trim().slice(0, 500) : ''
      // 结构化字段：没有 resolution 的 skill_error_fix 永远不会进技能召回（只能被搜到）。
      const errorSignature = typeof record.errorSignature === 'string' ? record.errorSignature.trim().slice(0, 300) : ''
      const resolution = typeof record.resolution === 'string' ? record.resolution.trim().slice(0, 1000) : ''
      const created = await store.appendSuggested(content, type)
      if (created === undefined) {
        return { ok: false, reason: 'duplicate', message: '内容已存在（完全相同），未重复写入' }
      }
      const item = await store.update(created.id, {
        ...(context === '' ? {} : { context }),
        ...(errorSignature === '' ? {} : { errorSignature }),
        ...(resolution === '' ? {} : { resolution }),
        ...(record.approved === true ? { status: 'approved' as const } : {}),
        origin: 'manual',
        originDetail: '主动沉淀',
      })
      const warning = type === 'skill_error_fix' && resolution === ''
        ? 'skill_error_fix 缺少 resolution：这条只能被搜到，不会进入技能召回'
        : undefined
      return { ok: true, id: created.id, item: item ?? created, ...(warning === undefined ? {} : { warning }) }
    },
  }
}
/** 注册工具；任一失败只写日志，不阻断其他工具。 */
export function registerMemoryTools(ctx: MemoryToolContext, store: MemoryStore): void {
  for (const definition of [
    memoryListTool(store),
    memorySearchTool(store),
    memoryDeleteTool(store),
    memoryApproveTool(store),
    memoryUpdateResolutionTool(store),
    memoryRememberTool(store),
    memoryProbeTool(store),
  ]) {
    try {
      ctx.effect(() => {
        const dispose = ctx.tools.register(definition)
        return () => {
          dispose()
        }
      })
    } catch (error) {
      console.error(`[dsh-evolution-flywheel] ${definition.name} registration failed:`, error)
    }
  }
}

/**
 * 记忆浏览器的 Host 工具：memory_list / memory_delete。
 *
 * 工具与 HTTP API 共用同一个 MemoryStore；工具供模型调用，HTTP API 供
 * Web UI 调用。两者都只操作插件自己的 JSONL 文件。
 */
import type { ToolDefinitionLike } from '../index.js'
import type { MemoryRecord, MemoryStore } from './store.js'

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
    description: 'Search local dsh-evolution-flywheel memories by text. Read-only; returns matching memory records.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        limit: { type: 'number', description: 'Maximum results, 1-50; defaults to 10.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'array', items: MEMORY_ITEM_SCHEMA },
      render: renderJson,
    },
    async execute(args: unknown): Promise<MemoryRecord[]> {
      const record = (args ?? {}) as { query?: unknown; limit?: unknown }
      const query = typeof record.query === 'string' ? record.query : ''
      const limit = typeof record.limit === 'number' && Number.isFinite(record.limit) ? record.limit : 10
      return store.search(query, limit)
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
      },
      required: ['id', 'resolution'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderJson,
    },
    async execute(args: unknown): Promise<{ ok: true; id: string; item: unknown }> {
      const record = (args ?? {}) as { id?: unknown; resolution?: unknown }
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      const resolution = typeof record.resolution === 'string' ? record.resolution : ''
      if (id === '') throw new Error('memory_update_resolution requires a non-empty id')
      const item = await store.setResolution(id, resolution)
      if (item === undefined) throw new Error('memory_update_resolution: memory not found')
      return { ok: true, id, item }
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

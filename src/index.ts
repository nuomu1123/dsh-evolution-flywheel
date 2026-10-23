/**
 * dsh-evolution-flywheel —— 最小可运行的记忆/澄清插件骨架。
 *
 * 本文件做三件事：
 * 1. 导出一个合法的 Cordis Host 插件入口（name / inject / apply）；
 * 2. 在 apply 内注册 `memory_ping` 工具，用于证明插件可加载、工具可被模型调用；
 * 3. 在 apply 内调用 registerClarify，注册 `/clarify` 命令。
 *
 * 骨架阶段约束：
 * - Host 入口不 import 任何外部运行时包，避免干净环境或 profile 中包解析差异导致加载失败；
 * - 初始化逻辑全部包在 try/catch 中，失败只写 stderr，不 throw 到宿主。
 *
 * 这里的 `PluginContext` / `ToolDefinitionLike` 是对 Cordis 4.0.5 与
 * `@deepseek-ai/dsh-tools` 公开契约的最小结构化声明。使用结构化类型而不是
 * `@deepseek-ai/cordis` 的具名类型，是为了让骨架在没有 DSH 源码 checkout 的
 * 干净环境里也能独立构建（详见 README「已知限制」）。
 */

import { registerClarify } from './clarify/index.js'
import { registerMemoryFeatures, type MemoryHostContext } from './memory/index.js'

export const name = 'dsh-evolution-flywheel'

/** 依赖 DSH 的工具与命令服务；服务缺失时 Cordis 会等待，不会让宿主启动失败。 */
export const inject = ['tools', 'commands', 'systemPrompt']

export const PLUGIN_ID = 'dsh-evolution-flywheel'

/** `memory_ping` 的固定返回结构。 */
export interface MemoryPingResult {
  ok: true
  plugin: typeof PLUGIN_ID
  ts: string
}

/** 工具注册器的最小结构，对应 `@deepseek-ai/dsh-tools` 的 `ToolDefinition`。 */
export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: unknown, exec: unknown): Promise<unknown>
}

/** 插件实际使用的 Cordis 上下文结构。 */
export interface PluginContext extends MemoryHostContext {
  commands: {
    register(definition: {
      name: string
      description: string
      input?: { hint: string }
      handler: (invocation: { rawInput: string }) => { kind: 'success' | 'error'; text: string } | Promise<{ kind: 'success' | 'error'; text: string }>
    }): () => void
  }
}

/**
 * 唯一的探测工具：无参数，返回固定结构的 JSON。
 * 该工具不读写任何记忆数据，只用于验证插件加载与工具调用链路。
 */
export const MEMORY_PING_TOOL: ToolDefinitionLike = {
  name: 'memory_ping',
  description:
    'Probe whether the dsh-evolution-flywheel plugin is loaded and its tool is callable. '
    + 'Takes no arguments. Returns { ok: true, plugin: "dsh-evolution-flywheel", ts: <ISO-8601 timestamp> }. '
    + 'This skeleton performs no memory reads or writes.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
    },
    render(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
  },
  async execute(): Promise<MemoryPingResult> {
    return {
      ok: true,
      plugin: PLUGIN_ID,
      ts: new Date().toISOString(),
    }
  },
}

/**
 * Cordis Host 插件入口。
 * 所有副作用都通过 `ctx.effect` 注册，disposer 会在卸载或热重载时注销工具；
 * 注册失败只记录日志，不让宿主启动失败。
 */
export function apply(ctx: PluginContext): void {
  try {
    ctx.effect(() => {
      const unregister = ctx.tools.register(MEMORY_PING_TOOL)
      return () => {
        unregister()
      }
    })
  } catch (error) {
    console.error(`[${PLUGIN_ID}] initialization failed; plugin stays inert:`, error)
  }

  try {
    registerClarify(ctx)
  } catch (error) {
    // registerClarify 内部已兜底；这里再包一层，确保任何意外都不拖垮宿主。
    console.error(`[${PLUGIN_ID}] clarify initialization failed; plugin stays usable:`, error)
  }

  try {
    registerMemoryFeatures(ctx)
  } catch (error) {
    console.error(`[${PLUGIN_ID}] memory explorer initialization failed; plugin stays usable:`, error)
  }
}

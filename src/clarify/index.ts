/**
 * clarify 的 Host 半：注册 `/clarify` 命令。
 *
 * 命令只做纯规则分析与文本输出；它不写回浏览器输入框（Host 无法操作
 * composer），写回与撤回由 Client 半的【澄清】/【写回输入框】/【撤回】按钮完成。
 *
 * 所有注册都通过 `ctx.effect` 的 disposer 清理；任何异常只写日志，不 throw。
 */
import { PLUGIN_ID } from '../constants.js'
import { buildQuestions } from './questions.js'
import { detectSignals } from './rules.js'
import type { ClarifyAnalysis } from './types.js'

/** 命令结果的最小结构，对应 `@deepseek-ai/dsh-commands` 的 CommandResult。 */
export interface ClarifyCommandResult {
  kind: 'success' | 'error'
  text: string
}

/** 命令 handler 收到的调用信息（只用到 rawInput）。 */
export interface ClarifyCommandInvocation {
  readonly rawInput: string
}

/** 命令定义的最小结构。 */
export interface ClarifyCommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: ClarifyCommandInvocation) => ClarifyCommandResult | Promise<ClarifyCommandResult>
}

/** clarify 所需的最小 Cordis Host 上下文结构。 */
export interface ClarifyHostContext {
  effect(callback: () => () => void): unknown
  commands: {
    register(definition: ClarifyCommandDefinition): () => void
  }
}

/**
 * 纯规则分析：检测信号并生成最多 3 个封闭问题。
 * @param input 原始提示词。
 */
export function analyzePrompt(input: string): ClarifyAnalysis {
  const original = input.trim()
  const signals = detectSignals(original)
  const questions = buildQuestions(signals)
  return {
    original,
    signals,
    questions,
    needsClarification: questions.length > 0,
    suggestedPreferenceKeys: [...new Set(questions.map(question => question.preferenceKey))],
  }
}

function formatAnalysis(analysis: ClarifyAnalysis): string {
  if (!analysis.needsClarification) {
    return '无需澄清：需求已包含明确对象或验收标准，直接执行即可。'
  }
  const lines = analysis.questions.map((question, index) =>
    `${index + 1}. ${question.prompt}\n   选项：${question.options.map(option => option.label).join(' / ')}`,
  )
  return [
    `检测到 ${analysis.signals.length} 个模糊信号，建议先确认以下 ${analysis.questions.length} 个问题：`,
    lines.join('\n'),
    '',
    '提示：在输入框上方点击【澄清】可以用按钮回答并写回输入框（不会自动发送）；本命令只输出文本。',
  ].join('\n')
}

/**
 * `/clarify` 命令的纯函数实现，便于单测。
 * @param rawInput 命令名之后的原始文本。
 */
export function handleClarifyCommand(rawInput: string): ClarifyCommandResult {
  const input = rawInput.trim()

  if (input === '') {
    return {
      kind: 'success',
      text: '用法：/clarify <提示词>，或直接点击输入框上方的【澄清】按钮。第一版只做规则检测，不调用模型。',
    }
  }

  if (input === 'undo' || input === '撤回') {
    return {
      kind: 'success',
      text: '撤回请在输入框上方点击【撤回】按钮；Host 命令无法直接操作浏览器输入框。',
    }
  }

  try {
    return { kind: 'success', text: formatAnalysis(analyzePrompt(input)) }
  } catch (error) {
    console.error(`[${PLUGIN_ID}] clarify command failed:`, error)
    return { kind: 'error', text: '澄清检测失败，已忽略本次请求。' }
  }
}

/**
 * 在 Host 上下文注册 `/clarify` 命令。
 * 所有副作用都由 `ctx.effect` 管理；初始化失败只写 stderr。
 */
export function registerClarify(ctx: ClarifyHostContext): void {
  try {
    ctx.effect(() => {
      const dispose = ctx.commands.register({
        name: 'clarify',
        description: '检测提示词中的模糊指代、缺失验收标准与多义改动范围，生成最多 3 个封闭问题（纯规则，不调用模型）',
        input: { hint: '可选：要澄清的原始提示词；或 undo' },
        handler: invocation => handleClarifyCommand(invocation.rawInput),
      })
      return () => {
        dispose()
      }
    })
  } catch (error) {
    console.error(`[${PLUGIN_ID}] clarify command registration failed; plugin stays usable:`, error)
  }
}

/**
 * 把用户回答合并回原提示词，生成新的提示词文本。
 *
 * 第一版只做保守追加：保留原文，在末尾追加“补充约束”列表。
 * 不删除、不改写原文，便于用户撤回后完整恢复。
 */
import type { ClarifyAnswers, ClarifyQuestion } from './types.js'

/**
 * @param original 原始提示词。
 * @param questions 本次提问的问题列表。
 * @param answers question.id -> option.value。
 * @returns 合并后的提示词；没有有效回答时原样返回。
 */
export function mergeAnswers(
  original: string,
  questions: readonly ClarifyQuestion[],
  answers: ClarifyAnswers,
): string {
  const lines: string[] = []

  for (const question of questions) {
    const value = answers[question.id]
    if (value === undefined || value === '') continue
    const option = question.options.find(item => item.value === value)
    lines.push(`- ${question.prompt} → ${option?.label ?? value}`)
  }

  if (lines.length === 0) return original

  return `${original.trimEnd()}\n\n补充约束：\n${lines.join('\n')}`
}

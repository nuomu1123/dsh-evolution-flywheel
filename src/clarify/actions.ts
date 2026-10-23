/**
 * clarify 的写回/撤回动作，与 React 组件分离，便于单测“不自动发送”约束。
 *
 * 这里只调用 `setDraft`，永远不调用 `submit`；撤回同样只恢复草稿。
 */
import { mergeAnswers } from './merge.js'
import type { ClarifyAnswers, ClarifyQuestion } from './types.js'

/** 最小草稿写入面；`submit` 故意不声明，防止误调用。 */
export interface ClarifyDraftSink {
  setDraft(text: string): void
}

export interface ClarifyWriteBack {
  original: string
  merged: string
}

/**
 * 合并回答并写回草稿；不发送、不提交。
 * @param sink 输入框动作面。
 * @param original 分析时的原始草稿。
 * @param questions 本次问题。
 * @param answers 用户回答。
 */
export function writeBackClarify(
  sink: ClarifyDraftSink,
  original: string,
  questions: readonly ClarifyQuestion[],
  answers: ClarifyAnswers,
): ClarifyWriteBack {
  const merged = mergeAnswers(original, questions, answers)
  sink.setDraft(merged)
  return { original, merged }
}

/**
 * 撤回：把草稿恢复为原文。
 * @param sink 输入框动作面。
 * @param original 写回前的原始草稿。
 */
export function undoClarify(sink: ClarifyDraftSink, original: string): void {
  sink.setDraft(original)
}

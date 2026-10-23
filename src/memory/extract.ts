/**
 * 轻量规则提取：只根据关键词决定是否把用户原话作为候选记忆。
 * 第一版不调用模型、不做语义理解。
 */
import type { MemoryType } from './store.js'

export const MEMORY_TRIGGER_WORDS = [
  '记住',
  '我是',
  '以后',
  '我的朋友',
  '设定',
  '请使用',
] as const

export interface ExtractedMemory {
  content: string
  type: MemoryType
}

/**
 * 判断一句话是否具有长期记忆价值，并给出简单类型。
 * @param text 用户消息的纯文本。
 * @returns 候选记忆；不命中关键词或为空时返回 undefined。
 */
export function extractMemoryCandidate(text: string): ExtractedMemory | undefined {
  const content = text.trim().slice(0, 2000)
  if (content === '') return undefined
  if (!MEMORY_TRIGGER_WORDS.some(word => content.includes(word))) return undefined
  const type: MemoryType = /(我是|以后|请使用|设定|朋友|偏好)/u.test(content) ? 'preference' : 'fact'
  return { content, type }
}

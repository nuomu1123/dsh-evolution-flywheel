/** clarify 模块共享的纯数据类型，无运行时副作用。 */

/** 第一版只识别的三类模糊信号。 */
export type ClarifySignalType = 'reference' | 'vague' | 'ambiguous'

/** 一条命中的模糊信号。 */
export interface ClarifySignal {
  type: ClarifySignalType
  /** 命中的原始词，例如“这个”“优化一下”。 */
  matched: string
  /** 命中词所在的句子，便于问题生成与调试。 */
  sentence: string
}

/** 一个封闭式问题的选项。 */
export interface ClarifyOption {
  label: string
  value: string
}

/** 一个封闭式问题：固定选项；偏好存在时附带默认值。 */
export interface ClarifyQuestion {
  id: string
  type: ClarifySignalType
  prompt: string
  options: ClarifyOption[]
  /** 来自 getPreference 的默认值；第一版实际恒为不存在。 */
  defaultValue?: string
  /** 未来接入记忆后建议写入的偏好 key；本版不写回。 */
  preferenceKey: string
}

/** 一次澄清分析的结果。 */
export interface ClarifyAnalysis {
  original: string
  signals: ClarifySignal[]
  questions: ClarifyQuestion[]
  needsClarification: boolean
  /** 未来可写回记忆的偏好 key 列表；本版只返回，不写入。 */
  suggestedPreferenceKeys: string[]
}

/** 用户对各问题的回答：question.id -> option.value。 */
export type ClarifyAnswers = Record<string, string>

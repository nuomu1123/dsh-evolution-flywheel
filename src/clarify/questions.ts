/**
 * 按模糊信号生成封闭式问题：每个信号类型最多一个问题，总数最多 3 个。
 *
 * 生成每个问题前都会调用记忆模块的只读接口 `getPreference(key)`：
 * - 取到值：问题改为“这次还是用 X 吗？”，并附带默认值；
 * - 取不到：使用通用封闭问题。
 * 第一版 `getPreference` 恒返回 undefined，因此偏好分支实际不可达；
 * 这里保留调用点，后续接记忆时无需改调用方。
 */
import { getPreference as readPreference } from '../memory/preferences.js'
import type { ClarifyQuestion, ClarifySignal, ClarifySignalType } from './types.js'

/** 只读偏好读取器；测试可注入替身。 */
export type PreferenceReader = (key: string) => string | undefined

const TEMPLATES: Record<ClarifySignalType, Omit<ClarifyQuestion, 'type' | 'defaultValue'>> = {
  reference: {
    id: 'reference',
    prompt: '你指的是当前打开的文件，还是整个项目？',
    options: [
      { label: '当前打开的文件', value: 'current-file' },
      { label: '整个项目', value: 'whole-project' },
    ],
    preferenceKey: 'clarify_reference_scope',
  },
  vague: {
    id: 'vague',
    prompt: '验收标准是能跑通即可，还是需要包含测试？',
    options: [
      { label: '能跑通即可', value: 'runs-only' },
      { label: '需要包含测试', value: 'with-tests' },
    ],
    preferenceKey: 'clarify_acceptance',
  },
  ambiguous: {
    id: 'ambiguous',
    prompt: '这次改动范围是只改前端，还是前后端都动？',
    options: [
      { label: '只改前端', value: 'frontend-only' },
      { label: '前后端都动', value: 'full-stack' },
    ],
    preferenceKey: 'clarify_change_scope',
  },
}

const PRIORITY: readonly ClarifySignalType[] = ['reference', 'vague', 'ambiguous']

function preferenceOf(reader: PreferenceReader, key: string): string | undefined {
  try {
    const value = reader(key)
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  } catch {
    // 偏好读取失败不能影响问题生成，退化为通用问题。
    return undefined
  }
}

/**
 * 生成最多 3 个封闭式问题，按 A、B、C 优先级排列。
 * @param signals 规则检测结果。
 * @param getPreference 只读偏好读取器；默认使用记忆模块占位实现。
 */
export function buildQuestions(
  signals: readonly ClarifySignal[],
  getPreference: PreferenceReader = readPreference,
): ClarifyQuestion[] {
  const present = new Set(signals.map(signal => signal.type))
  const questions: ClarifyQuestion[] = []

  for (const type of PRIORITY) {
    if (!present.has(type)) continue
    const template = TEMPLATES[type]
    const preference = preferenceOf(getPreference, template.preferenceKey)
    if (preference !== undefined) {
      questions.push({
        ...template,
        type,
        prompt: `这次还是用 ${preference} 吗？`,
        options: [
          { label: `是，用 ${preference}`, value: preference },
          { label: '否，这次要改', value: '否' },
        ],
        defaultValue: preference,
      })
    } else {
      questions.push({ ...template, type })
    }
    if (questions.length >= 3) break
  }

  return questions
}

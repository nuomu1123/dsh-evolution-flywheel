/**
 * clarify 第一版规则：只做纯文本启发式检测，不调用模型、不读文件、不联网。
 *
 * 只识别三类信号：
 * A. 指代词（这个/那个/它/继续/接着弄），且同句没有明确名词或对象；
 * B. 缺约束的程度词（优化一下/弄好看点/改一下/处理一下），且同句缺具体对象或验收标准；
 * C. 多义动词（改一下/调整/处理），且没有指明范围（前端/后端/文档/配置等）。
 *
 * “前后文”在第一版被限定为当前输入的句子：调用方只传入原始提示词，
 * 没有对话历史可读（见 README 已知限制）。
 */
import type { ClarifySignal, ClarifySignalType } from './types.js'

const REFERENCE_TOKEN = /(这个|那个|它|继续|接着弄)/u
const VAGUE_TOKEN = /(优化一下|弄好看点|改一下|处理一下)/u
const AMBIGUOUS_TOKEN = /(改一下|调整|处理)/u

/** 明确对象：路径、文件名、反引号标识、调用形式、点号标识。 */
const EXPLICIT_OBJECT_PATTERNS: readonly RegExp[] = [
  /[A-Za-z]:[\\/][^\s，。！？；、]+/u,
  /(?:^|[\s（(])(?:\.{0,2}\/)?[\w.-]+\/[\w./-]+/u,
  /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|go|rs|java|kt|yml|yaml|toml|xml|sql)\b/iu,
  /`[^`]+`/u,
  /[A-Za-z_$][\w$]*\([^)]*\)/u,
  /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*/u,
]

/** 明确名词：出现这些词时，指代词不再视为“无明确名词”。 */
const OBJECT_NOUNS =
  /(文件|项目|函数|方法|类|模块|接口|页面|组件|配置|文档|数据库|脚本|仓库|目录|路径|测试|用例|样式|前端|后端|首页|登录页|按钮|表格|表单|服务|客户端|服务端)/u

/** 验收标准线索：出现这些词时，程度词不再视为“缺约束”。 */
const ACCEPTANCE =
  /(测试|验收|退出码|通过|兼容|性能|覆盖|用例|UTC|时间戳|返回|输入|输出|格式|长度|大小|必须|要求|不要|至少|最多|精确|一致)/iu

/** 改动范围线索。 */
const SCOPE =
  /(前端|后端|全栈|文档|配置|样式|UI|CSS|API|数据库|接口|服务端|客户端|测试|部署|脚本|页面|组件)/iu

function hasExplicitObject(text: string): boolean {
  return EXPLICIT_OBJECT_PATTERNS.some(pattern => pattern.test(text)) || OBJECT_NOUNS.test(text)
}

/** 取命中位置所在的句子；找不到时退化为整段文本。 */
function sentenceOf(text: string, matched: string): string {
  for (const sentence of text.split(/[。！？!?\n]+/u)) {
    if (sentence.includes(matched)) return sentence.trim()
  }
  return text.trim()
}

function firstSignal(
  text: string,
  type: ClarifySignalType,
  token: RegExp,
  accept: (sentence: string) => boolean,
): ClarifySignal | undefined {
  const match = token.exec(text)
  if (match === null) return undefined
  const matched = match[0]
  const sentence = sentenceOf(text, matched)
  if (!accept(sentence)) return undefined
  return { type, matched, sentence }
}

/**
 * 检测原始提示词中的模糊信号。
 * @param input 原始提示词。
 * @returns 按 A、B、C 优先级排序的信号；每类最多一条。
 */
export function detectSignals(input: string): ClarifySignal[] {
  const text = input.trim()
  if (text === '') return []

  const signals: ClarifySignal[] = []

  const reference = firstSignal(text, 'reference', REFERENCE_TOKEN, sentence => !hasExplicitObject(sentence))
  if (reference !== undefined) signals.push(reference)

  const vague = firstSignal(text, 'vague', VAGUE_TOKEN, sentence => !hasExplicitObject(sentence) || !ACCEPTANCE.test(sentence))
  if (vague !== undefined) signals.push(vague)

  const ambiguous = firstSignal(text, 'ambiguous', AMBIGUOUS_TOKEN, sentence => !SCOPE.test(sentence))
  if (ambiguous !== undefined) signals.push(ambiguous)

  return signals
}

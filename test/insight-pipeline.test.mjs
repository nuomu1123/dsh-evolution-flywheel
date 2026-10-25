/**
 * 认知飞轮六部曲 × 跨学科小提炼（DMA）的契约测试。
 *
 * 这里锁死两件事：
 * 1. Host 端提示必须强制五步推导（原貌 → 概括 → 迁移 → 代价 → 人类启示），顺序不可漂移；
 * 2. Client 端解析必须能把同一份输出还原成五步卡片，旧数据要能优雅回退。
 *
 * 提示与解析分属两个包的两个文件，唯一契约就是那五个【标签】。
 * 因此最后一条用例做端到端焊接：直接取提示里的 JSON 模板 → JSON.parse → parseMetaInsight。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDmaInsightPrompt,
  DMA_DISCIPLINES,
  DMA_FLYWHEEL_STAGES,
  DMA_INSIGHT_STEP_LABELS,
} from '../lib/memory/dma.js'
import { parseMetaInsight } from '../src/client/logic.ts'

const prompt = buildDmaInsightPrompt({
  discipline: DMA_DISCIPLINES[0],
  query: 'immune memory multi-agent',
  tokenLimit: 800,
  memoryLines: ['1. 例子记忆'],
  evidenceLines: ['1. 例子证据: 摘要'],
})

test('六部曲顺序固定：寻找→理解→概括→迁移→实践→反馈', () => {
  assert.deepEqual(
    [...DMA_FLYWHEEL_STAGES],
    ['search', 'comprehend', 'abstract', 'transfer', 'practice', 'feedback'],
  )
})

test('DMA 提示强制五步推导：五个【标签】按序出现且不可省略', () => {
  let cursor = -1
  for (const label of DMA_INSIGHT_STEP_LABELS) {
    const at = prompt.indexOf(label)
    assert.ok(at > cursor, `缺少或顺序错位的标签：${label}`)
    cursor = at
  }
  assert.match(prompt, /认知飞轮六部曲/u)
  assert.match(prompt, /作用与代价（Trade-off）/u)
  // 旧三段式不得再出现在提示里，否则模型会退回生硬格式。
  assert.equal(prompt.includes('【底层逻辑】'), false)
  assert.equal(prompt.includes('【对进化插件的代码建议】'), false)
})

test('契约闭环：提示里的 JSON 模板可被解析成五步卡片', () => {
  const jsonLine = prompt.split('\n').find(line => line.trim().startsWith('{"title"'))
  assert.ok(jsonLine !== undefined, '提示里必须保留 JSON 模板行')
  const parsed = JSON.parse(jsonLine)
  assert.ok(Array.isArray(parsed.insights))
  const breakdown = parseMetaInsight(parsed.insights[0])
  assert.equal(breakdown.structured, true)
  assert.equal(breakdown.matched, 5)
  assert.deepEqual(
    breakdown.steps.map(step => step.key),
    ['origin', 'structure', 'mapping', 'tradeoff', 'human'],
  )
  assert.deepEqual(
    breakdown.steps.map(step => step.label),
    ['学科知识原貌', '结构概括', '映射与套用', '作用与代价', '人类启示'],
  )
})

const FULL_INSIGHT = [
  '[DMA 元认知] 生物学 · 免疫记忆',
  '1. 【学科知识原貌】免疫系统用记忆细胞识别同类病毒。',
  '2. 【结构概括】先验模式识别 + 命中后快速克隆扩增。',
  '3. 【映射与套用】把报错签名当抗原，命中历史解法直接复用。',
  '4. 【作用与代价（Trade-off）】作用是复用快；代价是误报会放大错误。',
  '5. 【人类启示】把重复问题沉淀成清单，别每次从零推理。',
  '来源：https://example.com/a | https://example.com/b',
].join('\n')

test('解析：五步齐全时切成卡片，标题进 preamble、来源 footer 不进最后一步', () => {
  const breakdown = parseMetaInsight(FULL_INSIGHT)
  assert.equal(breakdown.matched, 5)
  assert.equal(breakdown.structured, true)
  assert.match(breakdown.preamble, /生物学/u)
  assert.equal(breakdown.steps[3].text.includes('https://example.com'), false)
  assert.match(breakdown.steps[3].text, /误报会放大错误/u)
  assert.equal(breakdown.steps[4].text, '把重复问题沉淀成清单，别每次从零推理。')
  // 切段会带上「5. 」这种序号尾巴，必须清干净，界面才不出现孤立序号。
  assert.equal(breakdown.steps.every(step => !/^[\d一二三四五六七八九十]+[.、)）]$/u.test(step.text)), true)
})

test('解析：没有换行、五步挤在一行也能切段', () => {
  const oneLine = '【学科知识原貌】甲【结构概括】乙【映射与套用】丙【作用与代价】丁【人类启示】戊'
  const breakdown = parseMetaInsight(oneLine)
  assert.equal(breakdown.matched, 5)
  assert.deepEqual(breakdown.steps.map(step => step.text), ['甲', '乙', '丙', '丁', '戊'])
})

test('解析：字面 \\n 会被还原成真换行（模型双重转义时不再丢结构）', () => {
  const escaped = '【学科知识原貌】甲\\n【结构概括】乙\\n【映射与套用】丙'
  const breakdown = parseMetaInsight(escaped)
  assert.equal(breakdown.matched, 3)
  assert.deepEqual(breakdown.steps.map(step => step.text), ['甲', '乙', '丙'])
})

test('解析：旧三段式数据仍可读（映射到前三步），历史记忆不丢', () => {
  const legacy = '【学科视角】生物学\n【底层逻辑】记忆细胞先验识别\n【对进化插件的代码建议】缓存报错签名'
  const breakdown = parseMetaInsight(legacy)
  assert.equal(breakdown.matched, 3)
  assert.equal(breakdown.structured, true)
  assert.deepEqual(breakdown.steps.map(step => step.key), ['origin', 'structure', 'mapping'])
})

test('解析：不达三步时回退纯文本（structured=false），内容不丢', () => {
  const plain = '一段没有任何标签的结论。'
  const breakdown = parseMetaInsight(plain)
  assert.equal(breakdown.structured, false)
  assert.equal(breakdown.steps.length, 0)
  assert.equal(breakdown.preamble, plain)
})

test('解析：重复标签只计一次，模型复读时卡片不重复', () => {
  const duplicated = '【学科知识原貌】甲\n【学科知识原貌】乙\n【结构概括】丙\n【映射与套用】丁'
  const breakdown = parseMetaInsight(duplicated)
  assert.equal(breakdown.matched, 3)
})

test('解析：Markdown 加粗包裹的标签也能识别', () => {
  const bold = '**【学科知识原貌】**：甲\n**【结构概括】**：乙\n**【映射与套用】**：丙'
  const breakdown = parseMetaInsight(bold)
  assert.equal(breakdown.matched, 3)
  assert.deepEqual(breakdown.steps.map(step => step.text), ['甲', '乙', '丙'])
})

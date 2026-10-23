import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzePrompt, handleClarifyCommand } from '../lib/clarify/index.js'
import { undoClarify, writeBackClarify } from '../lib/clarify/actions.js'
import { mergeAnswers } from '../lib/clarify/merge.js'
import { buildQuestions } from '../lib/clarify/questions.js'
import { detectSignals } from '../lib/clarify/rules.js'
import { getPreference } from '../lib/memory/preferences.js'

test('明确需求不产生任何澄清问题', () => {
  const analysis = analyzePrompt('把 src/utils.ts 里的 parseDate 改成返回 UTC 时间戳')
  assert.deepEqual(analysis.signals, [])
  assert.equal(analysis.needsClarification, false)
  assert.deepEqual(analysis.questions, [])

  const command = handleClarifyCommand('把 src/utils.ts 里的 parseDate 改成返回 UTC 时间戳')
  assert.equal(command.kind, 'success')
  assert.match(command.text, /无需澄清/)
})

test('“把这个优化一下”命中指代与程度模糊，最多 3 个封闭问题', () => {
  const analysis = analyzePrompt('把这个优化一下')
  const types = analysis.signals.map(signal => signal.type)
  assert.ok(types.includes('reference'))
  assert.ok(types.includes('vague'))
  assert.ok(analysis.questions.length <= 3)
  assert.equal(analysis.questions.length, 2)

  for (const question of analysis.questions) {
    assert.ok(question.options.length >= 2, `${question.id} 缺少选项`)
    assert.match(question.prompt, /？$/)
  }
})

test('“改一下”命中程度模糊与多义动词，问题带选项', () => {
  const analysis = analyzePrompt('改一下')
  const types = analysis.signals.map(signal => signal.type)
  assert.ok(types.includes('vague'))
  assert.ok(types.includes('ambiguous'))
  assert.ok(analysis.questions.length <= 3)
  for (const question of analysis.questions) {
    assert.ok(question.options.length >= 2)
  }
})

test('“把它处理一下”最多生成 3 个封闭问题', () => {
  const analysis = analyzePrompt('把它处理一下')
  assert.ok(analysis.signals.length >= 3)
  assert.equal(analysis.questions.length, 3)
  const ids = analysis.questions.map(question => question.id)
  assert.deepEqual(ids, ['reference', 'vague', 'ambiguous'])
  for (const question of analysis.questions) {
    assert.match(question.prompt, /？$/)
    assert.ok(question.options.length >= 2)
  }
})

test('明确范围时不报多义动词', () => {
  const analysis = analyzePrompt('调整一下配置')
  assert.equal(analysis.needsClarification, false)
})

test('生成问题前调用 getPreference；有值时问题改为偏好确认', () => {
  const reads = []
  const signals = detectSignals('把这个优化一下')
  const questions = buildQuestions(signals, (key) => {
    reads.push(key)
    return key === 'clarify_acceptance' ? 'pnpm' : undefined
  })

  assert.ok(reads.includes('clarify_acceptance'))
  const vague = questions.find(question => question.id === 'vague')
  assert.ok(vague)
  assert.match(vague.prompt, /pnpm/)
  assert.equal(vague.defaultValue, 'pnpm')
  assert.ok(vague.options.length >= 2)
})

test('第一版 getPreference 恒返回 undefined', () => {
  assert.equal(getPreference('package_manager'), undefined)
  assert.equal(getPreference('clarify_acceptance'), undefined)
})

test('mergeAnswers 保留原文并追加所选答案', () => {
  const analysis = analyzePrompt('把这个优化一下')
  const answers = {
    reference: 'current-file',
    vague: 'with-tests',
  }
  const merged = mergeAnswers(analysis.original, analysis.questions, answers)

  assert.ok(merged.startsWith('把这个优化一下'))
  assert.match(merged, /补充约束/)
  assert.match(merged, /当前打开的文件/)
  assert.match(merged, /需要包含测试/)
})

test('写回只调用 setDraft 不调用 submit；撤回恢复原文', () => {
  const analysis = analyzePrompt('把这个优化一下')
  const answers = {
    reference: 'current-file',
    vague: 'with-tests',
  }
  const calls = []
  const sink = {
    setDraft(text) {
      calls.push(text)
    },
    submit() {
      throw new Error('clarify must never submit')
    },
  }

  const result = writeBackClarify(sink, analysis.original, analysis.questions, answers)
  assert.equal(calls.length, 1)
  assert.equal(calls[0], result.merged)
  assert.equal(result.original, analysis.original)
  assert.match(result.merged, /补充约束/)

  undoClarify(sink, result.original)
  assert.equal(calls.length, 2)
  assert.equal(calls[1], analysis.original)
})

test('结论只附带 suggestedPreferenceKeys，不写回记忆', () => {
  const analysis = analyzePrompt('把这个优化一下')
  assert.deepEqual(analysis.suggestedPreferenceKeys.sort(), ['clarify_acceptance', 'clarify_reference_scope'])
})

test('/clarify 命令输出问题选项与撤回提示', () => {
  const questions = handleClarifyCommand('把这个优化一下')
  assert.equal(questions.kind, 'success')
  assert.match(questions.text, /选项/)
  assert.match(questions.text, /不会自动发送/)

  const undo = handleClarifyCommand('undo')
  assert.equal(undo.kind, 'success')
  assert.match(undo.text, /撤回/)
  assert.match(undo.text, /输入框上方/)

  const usage = handleClarifyCommand('')
  assert.equal(usage.kind, 'success')
  assert.match(usage.text, /用法/)
})

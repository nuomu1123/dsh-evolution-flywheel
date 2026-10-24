/**
 * 整理 Agent 的规则内核测试：报告分类、阈值、解析。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCurationReport, parseCurationPayload, shouldRunCuration, summarizeCurationQuality, summarizeCurationWithLlm } from '../lib/memory/curator.js'
import { MemoryStore } from '../lib/memory/store.js'

const NOW = Date.parse('2026-10-24T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function item(id, extra = {}) {
  return {
    id,
    content: `记忆-${id}`,
    type: 'skill_error_fix',
    status: 'approved',
    createdAt: new Date(NOW).toISOString(),
    ...extra,
  }
}

test('整理报告：褪色进归档、显著进高价值、重复分组', () => {
  const items = [
    item('fresh'),
    item('faded', { createdAt: new Date(NOW - 60 * DAY).toISOString() }),
    item('hot', { humanInterventions: 3 }),
    item('dup1', { content: '完全重复的内容' }),
    item('dup2', { content: '完全重复的内容' }),
  ]
  const report = buildCurationReport(items, NOW, 'manual')
  assert.equal(report.total, 5)
  assert.ok(report.archive.some(entry => entry.id === 'faded'))
  assert.ok(report.highValue.some(entry => entry.id === 'hot'))
  assert.equal(report.merge.length, 1)
  assert.deepEqual(report.merge[0].ids.sort(), ['dup1', 'dup2'])
  assert.equal(report.stats.duplicates, 1)
  assert.match(report.summary, /共 5 条/)
  assert.ok(report.risks.length >= 1)
})

test('整理报告：高价值优先于归档，不重复分类', () => {
  const items = [
    item('faded-hot', {
      createdAt: new Date(NOW - 60 * DAY).toISOString(),
      humanInterventions: 3,
      count: 6,
    }),
  ]
  const report = buildCurationReport(items, NOW, 'manual')
  assert.ok(report.highValue.some(entry => entry.id === 'faded-hot'))
  assert.equal(report.archive.some(entry => entry.id === 'faded-hot'), false)
})

test('整理报告：相似但不完全相同的内容只作为合并候选', () => {
  const items = [
    item('sim1', { content: '修正路径后重试，并检查文件权限' }),
    item('sim2', { content: '修正路径后重试，检查文件权限' }),
  ]
  const report = buildCurationReport(items, NOW, 'manual')
  assert.ok(report.merge.some(entry => entry.ids.includes('sim1') && entry.ids.includes('sim2')))
  assert.ok(report.merge.some(entry => entry.reason.includes('高度相似')))
  // 只提议，不改动记忆本身
  assert.equal(report.total, 2)
})

test('阈值触发：首次需 20 条，24 小时内不重复，新增 20 条才再跑', () => {
  const many = Array.from({ length: 20 }, (_, index) => item(`m${index}`))
  assert.equal(shouldRunCuration(many, undefined, NOW), true)
  assert.equal(shouldRunCuration(many.slice(0, 19), undefined, NOW), false)
  assert.equal(shouldRunCuration(many, NOW - 60 * 60 * 1000, NOW), false)
  const recent = many.map(entry => ({ ...entry, createdAt: new Date(NOW - DAY).toISOString() }))
  assert.equal(shouldRunCuration(recent, NOW - 2 * DAY, NOW), true)
})

test('整理质量：采纳率与最近否决理由可统计', () => {
  const approved = { ...item('r1'), type: 'curation_report', status: 'approved', trace: ['人类裁决：批准'] }
  const rejected = {
    ...item('r2'),
    type: 'curation_report',
    status: 'rejected',
    trace: ['人类裁决：否决；理由：误判了仍有用的记忆'],
  }
  const pending = { ...item('r3'), type: 'curation_report', status: 'suggested' }
  const quality = summarizeCurationQuality([approved, rejected, pending])
  assert.equal(quality.approved, 1)
  assert.equal(quality.rejected, 1)
  assert.equal(quality.pending, 1)
  assert.equal(quality.total, 3)
  assert.equal(quality.approvalRate, 0.5)
  assert.match(quality.rejectionReasons[0], /误判/)
})

test('报告 JSON 解析：损坏时安全返回 undefined', () => {
  const report = buildCurationReport([item('a')], NOW, 'manual')
  assert.ok(parseCurationPayload(JSON.stringify(report)))
  assert.equal(parseCurationPayload('{坏 JSON'), undefined)
  assert.equal(parseCurationPayload(''), undefined)
})

test('LLM 摘要：有模型时返回建议，无模型时回退 undefined', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-curator-llm-'))
  const store = new MemoryStore(dir)
  try {
    const llm = {
      listProviders: () => [{ id: 'mock' }],
      listModels: async () => [{ id: 'mock-model' }],
      async *stream() {
        yield { type: 'text-delta', text: '建议保留高价值记忆，归档褪色项，裁决时先看否决理由。' }
        yield { type: 'finish' }
      },
    }
    const ctx = { get: name => name === 'llm' ? llm : undefined }
    const payload = buildCurationReport([item('x')], Date.now(), 'manual')
    const result = await summarizeCurationWithLlm(ctx, store, payload)
    assert.ok(result)
    assert.match(result.text, /保留/)
    assert.ok(result.tokensUsed >= 0)
    assert.equal(await summarizeCurationWithLlm({ get: () => undefined }, store, payload), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

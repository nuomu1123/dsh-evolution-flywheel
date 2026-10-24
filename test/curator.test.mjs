/**
 * 整理 Agent 的规则内核测试：报告分类、阈值、解析。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCurationReport, parseCurationPayload, shouldRunCuration } from '../lib/memory/curator.js'

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

test('阈值触发：首次需 20 条，24 小时内不重复，新增 20 条才再跑', () => {
  const many = Array.from({ length: 20 }, (_, index) => item(`m${index}`))
  assert.equal(shouldRunCuration(many, undefined, NOW), true)
  assert.equal(shouldRunCuration(many.slice(0, 19), undefined, NOW), false)
  assert.equal(shouldRunCuration(many, NOW - 60 * 60 * 1000, NOW), false)
  const recent = many.map(entry => ({ ...entry, createdAt: new Date(NOW - DAY).toISOString() }))
  assert.equal(shouldRunCuration(recent, NOW - 2 * DAY, NOW), true)
})

test('报告 JSON 解析：损坏时安全返回 undefined', () => {
  const report = buildCurationReport([item('a')], NOW, 'manual')
  assert.ok(parseCurationPayload(JSON.stringify(report)))
  assert.equal(parseCurationPayload('{坏 JSON'), undefined)
  assert.equal(parseCurationPayload(''), undefined)
})

/**
 * 记忆的呼吸感：遗忘曲线、显著性、时间感知与主动探针。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isFaded, memoryAgeDays, memoryFreshness, memorySalience, perceptionLabel } from '../lib/memory/decay.js'
import { buildDigest } from '../lib/memory/recall.js'
import { memoryProbeTool } from '../lib/memory/tools.js'
import { MemoryStore } from '../lib/memory/store.js'

const NOW = Date.parse('2026-10-24T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function record(extra = {}) {
  return {
    id: 'mem-test',
    content: '测试记忆',
    type: 'skill_error_fix',
    status: 'approved',
    createdAt: new Date(NOW - 1 * DAY).toISOString(),
    resolution: '修正路径后重试',
    errorSignature: 'Error: 测试',
    ...extra,
  }
}

test('遗忘曲线：旧经验褪色，显著记忆衰减更慢', () => {
  const fresh = record()
  const old = record({ createdAt: new Date(NOW - 60 * DAY).toISOString() })
  assert.ok(memoryFreshness(fresh, NOW) > 0.8)
  assert.ok(memoryFreshness(old, NOW) < 0.2)
  assert.equal(isFaded(old, NOW), true)

  const hotOld = record({
    createdAt: new Date(NOW - 60 * DAY).toISOString(),
    humanInterventions: 3,
    count: 6,
  })
  assert.ok(memoryFreshness(hotOld, NOW) > memoryFreshness(old, NOW))
})

test('显著性：人类干预与连续报错放大权重', () => {
  const quiet = record({ humanInterventions: 0, count: 1 })
  const red = record({ humanInterventions: 3, count: 6 })
  assert.ok(memorySalience(quiet) < 0.3)
  assert.ok(memorySalience(red) >= 0.9)
  assert.match(perceptionLabel(red, NOW), /致命红线/)
  assert.match(perceptionLabel(old(), NOW), /建议重新验证/)
})

function old() {
  return record({ createdAt: new Date(NOW - 60 * DAY).toISOString() })
}

test('时间感知：注入文本带年龄与保留率', () => {
  const label = perceptionLabel(record({ createdAt: new Date(NOW - 7 * DAY).toISOString() }), NOW)
  assert.match(label, /7 天前/)
  assert.match(label, /保留/)
  assert.ok(memoryAgeDays(record({ createdAt: new Date(NOW - 7 * DAY).toISOString() }), NOW) >= 6.9)
})

test('摘要过滤褪色记忆，显著红线带警示', () => {
  const faded = old()
  const hot = record({
    id: 'mem-hot',
    humanInterventions: 3,
    count: 6,
    // 用真实当前时间：buildDigest 内部用的是 Date.now()，固定 NOW 会随日期漂移成「1 天前」。
    createdAt: new Date().toISOString(),
  })
  const digest = buildDigest([faded, hot])
  assert.doesNotMatch(digest, /测试记忆/)
  assert.match(digest, /致命红线/)
  assert.match(digest, /今天/)
})

test('主动探针：验证结果写回记忆并调整置信度', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-probe-'))
  const store = new MemoryStore(dir)
  try {
    const created = await store.appendSuggested('路径可能失效', 'skill_error_fix')
    assert.ok(created)
    await store.update(created.id, { confidence: 0.5 })
    const tool = memoryProbeTool(store)
    const result = await tool.execute({
      id: created.id,
      hypothesis: '路径在新环境仍存在',
      evidence: 'Test-Path 返回 True',
      verified: true,
    }, {})
    assert.equal(result.ok, true)
    assert.ok(result.item.verifiedAt)
    assert.ok(result.item.confidence > 0.5)
    assert.ok((result.item.trace ?? []).some(step => step.includes('探针')))

    const refuted = await tool.execute({
      id: created.id,
      hypothesis: '路径在新环境仍存在',
      evidence: 'Test-Path 返回 False',
      verified: false,
    }, {})
    assert.ok(refuted.item.confidence < result.item.confidence)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

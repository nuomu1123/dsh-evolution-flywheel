/**
 * 认知探针：提问、回答、跳过、每周简报。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  answerProbe,
  appendCognitiveBrief,
  buildCognitiveBrief,
  createProbe,
  ignoreProbe,
  isServiceToneQuestion,
  markProbeSearching,
} from '../lib/memory/probes.js'
import { MemoryStore } from '../lib/memory/store.js'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-probes-'))
  try {
    await fn(new MemoryStore(dir), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('认知探针：创建、去重、回答、跳过', async () => {
  await withStore(async store => {
    const probe = await createProbe(store, {
      question: '这个模型在哪些场景会失效？',
      reason: '新提炼的思维模型缺少反例',
      source: 'model-distill',
      sourceId: 'mem-model',
    })
    assert.ok(probe)
    assert.equal(probe.type, 'cognitive_probe')
    assert.equal(probe.probeState, 'open')
    assert.equal(probe.probeReason, '新提炼的思维模型缺少反例')
    assert.equal(probe.origin, 'probe')

    const duplicate = await createProbe(store, {
      question: '这个模型在哪些场景会失效？',
      reason: '重复触发',
      source: 'model-distill',
    })
    assert.equal(duplicate?.id, probe.id)
    assert.equal((await store.list()).filter(item => item.type === 'cognitive_probe').length, 1)

    const searching = await markProbeSearching(store, probe.id)
    assert.equal(searching?.probeState, 'searching')

    const answered = await answerProbe(store, probe.id, '在一次性脚本里失效，因为不需要复用。')
    assert.equal(answered?.probeState, 'answered')
    assert.equal(answered?.status, 'approved')
    assert.match(answered?.answer ?? '', /一次性脚本/)
    assert.ok(answered?.answeredAt)

    const another = await createProbe(store, {
      question: '两条法则是否矛盾？',
      reason: '大提炼发现逻辑冲突',
      source: 'dma',
    })
    assert.ok(another)
    const ignored = await ignoreProbe(store, another.id)
    assert.equal(ignored?.probeState, 'ignored')
    assert.equal(ignored?.status, 'rejected')
  })
})

test('主体性守卫：客服式提问不落库，带新信息的跨学科问题照常创建', async () => {
  await withStore(async store => {
    const rejected = await createProbe(store, {
      question: '需要我帮你整理一下这些记忆吗？',
      reason: '模型只是想征求许可',
      source: 'dma',
    })
    assert.equal(rejected, undefined)
    assert.equal((await store.list()).filter(item => item.type === 'cognitive_probe').length, 0)

    const kept = await createProbe(store, {
      question: '博弈论里的纳什均衡，能否解释我们的对抗机制为什么缺少随机扰动？',
      reason: '跨学科类比，携带具体新信息',
      source: 'dma',
    })
    assert.ok(kept, '带具体新信息的问题必须保留')
  })
})

test('客服式判定不误伤带具体信息的疑问', () => {
  assert.equal(isServiceToneQuestion('需要我帮你整理吗？'), true)
  assert.equal(isServiceToneQuestion('是否需要我继续？'), true)
  assert.equal(isServiceToneQuestion('要不要我帮你跑一遍测试？'), true)
  assert.equal(isServiceToneQuestion('你希望我先归档还是先合并？'), true)
  assert.equal(isServiceToneQuestion('这条分歧是否来自前提假设不同？'), false)
  assert.equal(isServiceToneQuestion('模型在哪些场景会失效？'), false)
  assert.equal(isServiceToneQuestion(''), false)
})

test('认知简报：统计待回答、已回答与盲区', async () => {
  await withStore(async store => {
    const openA = await createProbe(store, {
      question: '探针 A：缺少前提',
      reason: '原因 A',
      source: 'model-distill',
    })
    const openB = await createProbe(store, {
      question: '探针 B：证据分歧',
      reason: '原因 B',
      source: 'dma',
    })
    assert.ok(openA && openB)
    const items = await store.list()
    const brief = buildCognitiveBrief(items)
    assert.equal(brief.total, 2)
    assert.equal(brief.open, 2)
    assert.equal(brief.openQuestions.length, 2)
    assert.ok(brief.blindSpots.length >= 1)
    assert.match(brief.summary, /待回答 2/)

    const stored = await appendCognitiveBrief(store, items)
    assert.ok(stored)
    assert.equal(stored.type, 'cognitive_brief')
    const again = await appendCognitiveBrief(store, await store.list())
    assert.equal(again?.id, stored.id)
  })
})

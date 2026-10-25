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

test('主体性守卫：客服式提问不落库、留审计，带新信息的跨学科问题照常创建', async () => {
  await withStore(async store => {
    const rejected = await createProbe(store, {
      question: '需要我帮你整理一下这些记忆吗？',
      reason: '模型只是想征求许可',
      source: 'dma',
    })
    assert.equal(rejected, undefined)
    assert.equal((await store.list()).filter(item => item.type === 'cognitive_probe').length, 0)

    // 丢弃必须留痕：否则没人知道"为什么这次没探针"。
    const { readAudit } = await import('../lib/audit.js')
    const audits = readAudit(200).filter(entry => entry.event === 'memory.probe.rejected')
    assert.ok(
      audits.some(entry => String(entry.payload.question).includes('需要我')),
      '客服式探针被拒后必须写入 memory.probe.rejected 审计',
    )

    const kept = await createProbe(store, {
      question: '博弈论里的纳什均衡，能否解释我们的对抗机制为什么缺少随机扰动？',
      reason: '跨学科类比，携带具体新信息',
      source: 'dma',
    })
    assert.ok(kept, '带具体新信息的问题必须保留')
  })
})

test('客服式判定：文档反例必须命中，带实质信息的问句必须放行', () => {
  // THE_GENESIS 7.4 明确列为禁止的句式（含无"我"前缀的变体，审查实测曾漏判）
  for (const banned of [
    '需要我帮你整理吗？',
    '是否需要我继续？',
    '要不要我帮你跑一遍测试？',
    '要不要继续？',
    '继续吗？',
    '我帮你把这条整理成卡片？',
    '要我把两条前提都列出来吗？',
    '你希望我先归档还是先合并？',
  ]) {
    assert.equal(isServiceToneQuestion(banned), true, `应判为客服式：${banned}`)
  }
  // 带具体对象/前提/引用的问句不能误伤（审查实测过的 4 个误伤反例）
  for (const allowed of [
    '这条分歧是否来自前提假设不同？',
    '模型在哪些场景会失效？',
    '你希望「分歧」保持开放，还是必须收敛成一个结论？',
    '请告诉我需要哪种前提，这条规律才能成立？',
    '如果前提 A 成立，我可以继续沿用这条策略——但它的边界在哪？',
    '你上次说「你希望系统自己判断」，那这里的边界在哪？',
    '',
  ]) {
    assert.equal(isServiceToneQuestion(allowed), false, `不应误伤：${allowed}`)
  }
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

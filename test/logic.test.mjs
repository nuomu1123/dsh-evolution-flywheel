import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDebateBubbles,
  buildTimeline,
  debateVerdictText,
  hasDebateRecord,
  matchesFilter,
  auditItem,
  formatMemoryTime,
  memoryStatusLabel,
  originLabel,
  memoryTypeLabel,
  normalizeMemoryStatus,
  tabCounts,
} from '../lib/client/logic.js'

function item(overrides = {}) {
  return {
    id: 'mem-1',
    content: 'ModuleNotFoundError: No module named requests',
    type: 'skill_error_fix',
    status: 'human_intervention',
    createdAt: '2026-10-23T12:00:00.000Z',
    ...overrides,
  }
}

test('buildTimeline 生成四段式时间轴并还原对抗内容', () => {
  const nodes = buildTimeline(item({
    reviewReason: '未锁定版本',
    challenge: '已在虚拟环境安装',
    debateSummary: '仍缺回滚方案',
  }))
  assert.deepEqual(nodes.map(node => node.key), ['submit', 'review', 'challenge', 'verdict'])
  assert.match(nodes[0].text, /ModuleNotFoundError/u)
  assert.equal(nodes[1].text, '未锁定版本')
  assert.equal(nodes[2].text, '已在虚拟环境安装')
  assert.equal(nodes[3].text, '等待人类圣裁')
  assert.equal(nodes[3].tone, '#d92d20')
})

test('buildTimeline 对初审通过与旧摘要如实标注', () => {
  const approved = buildTimeline(item({
    status: 'approved',
    reviewReason: undefined,
    debateSummary: undefined,
    challenge: undefined,
  }))
  assert.equal(approved[1].text, '初审通过，未进入辩论')
  assert.equal(approved[2].text, '未进入辩论')
  assert.equal(approved[3].text, '裁决通过，已生效')

  const legacy = buildTimeline(item({
    status: 'rejected',
    challenge: undefined,
    debateSummary: '旧摘要',
  }))
  assert.match(legacy[2].text, /旧摘要/u)
  assert.equal(legacy[3].text, '裁决驳回，已丢弃')
})

test('buildDebateBubbles 优先逐轮记录，旧数据降级到 challenge', () => {
  const rounds = [{ role: 'child', content: 'a' }, { role: 'mother', content: 'b' }]
  assert.deepEqual(buildDebateBubbles(item({ debateRounds: rounds })), rounds)
  assert.deepEqual(buildDebateBubbles(item({ challenge: '只有顶嘴' })), [
    { role: 'child', content: '只有顶嘴' },
  ])
  assert.deepEqual(buildDebateBubbles(item({})), [])
})

test('hasDebateRecord 与 debateVerdictText 覆盖各状态', () => {
  assert.equal(hasDebateRecord(item({})), true)
  assert.equal(hasDebateRecord(item({ status: 'debating' })), true)
  assert.equal(hasDebateRecord(item({ status: 'approved', challenge: 'x' })), true)
  assert.equal(hasDebateRecord(item({ status: 'approved' })), false)

  assert.equal(debateVerdictText(item({})), '未收敛 · 等待人类圣裁')
  assert.equal(debateVerdictText(item({ status: 'debating' })), '辩论进行中 · 等待母 Agent 回应')
  assert.equal(debateVerdictText(item({ status: 'approved' })), '辩论收敛 · 裁决通过')
  assert.equal(debateVerdictText(item({ status: 'approved', humanDecision: 'adopt' })), '人类强制采纳 · 已生效')
  assert.equal(debateVerdictText(item({ status: 'rejected' })), '辩论收敛 · 裁决驳回')
  assert.equal(debateVerdictText(item({ status: 'rejected', humanDecision: 'discard' })), '人类强制驳回 · 已丢弃')
})

test('matchesFilter 覆盖各 Tab 与关键词', () => {
  const fact = item({ type: 'fact', status: 'approved', content: '记忆条目 A' })
  const skill = item({ type: 'skill_error_fix', status: 'approved', content: '模块缺失' })
  const meta = item({ type: 'speculative', status: 'speculative', content: '生物学洞察' })
  const human = item({ content: '待裁决条目' })
  const debate = item({ status: 'approved', debateSummary: '辩论摘要' })

  assert.equal(matchesFilter(fact, 'basic', ''), true)
  assert.equal(matchesFilter(skill, 'basic', ''), false)
  assert.equal(matchesFilter(skill, 'skill', ''), true)
  assert.equal(matchesFilter(meta, 'dma', ''), true)
  assert.equal(matchesFilter(human, 'human', ''), true)
  assert.equal(matchesFilter(debate, 'debate', ''), true)
  assert.equal(matchesFilter(fact, 'debate', ''), false)

  assert.equal(matchesFilter(skill, 'skill', '排错'), true)
  assert.equal(matchesFilter(human, 'human', '待裁决'), true)
  assert.equal(matchesFilter(fact, 'basic', '不存在的词'), false)
})

test('tabCounts 统计各分区卡片数量', () => {
  const fact = item({ type: 'fact', status: 'approved', content: '事实' })
  const meta = item({ type: 'speculative', status: 'speculative', content: '漫游' })
  const human = item({ content: '待裁决' })
  const debate = item({ status: 'approved', debateSummary: '摘要' })
  const counts = tabCounts([fact, meta, human, debate])
  assert.equal(counts.all, 4)
  assert.equal(counts.basic, 1)
  assert.equal(counts.dma, 1)
  assert.equal(counts.human, 1)
  assert.equal(counts.debate, 2)
  assert.equal(counts.skill, 2)
  assert.equal(counts.audit, 4)
})

test('auditItem 区分长期/临时与需要/可清理', () => {
  assert.equal(auditItem(item({ type: 'preference', status: 'approved' })).durability, 'long-term')
  assert.equal(auditItem(item({ type: 'preference', status: 'approved' })).necessity, 'needed')
  assert.equal(auditItem(item({})).durability, 'temporary')
  assert.equal(auditItem(item({})).necessity, 'uncertain')
  assert.equal(auditItem(item({ status: 'approved', resolution: '修复' })).durability, 'long-term')
  assert.equal(auditItem(item({ status: 'approved', resolution: '修复' })).necessity, 'needed')
  assert.equal(auditItem(item({ status: 'approved', errorSignature: 'vitest failed', resolution: 'x' })).necessity, 'unneeded')
  assert.equal(auditItem(item({ status: 'rejected' })).necessity, 'unneeded')
})

test('思维模型类型、筛选与审计', () => {
  const model = item({ type: 'mental_model', status: 'approved', content: '反馈回路' })
  assert.equal(memoryTypeLabel('mental_model'), '思维模型')
  assert.equal(matchesFilter(model, 'model', ''), true)
  assert.equal(auditItem(model).durability, 'long-term')
  assert.equal(auditItem(item({ type: 'mental_model', status: 'suggested' })).necessity, 'uncertain')
  assert.equal(tabCounts([model]).model, 1)
})

test('状态标签与未知状态兜底', () => {
  assert.equal(memoryStatusLabel('approved'), '已生效')
  assert.equal(memoryStatusLabel('human_intervention'), '请求人类圣裁')
  assert.equal(memoryStatusLabel('mystery'), 'mystery')
  assert.equal(normalizeMemoryStatus('debating'), 'debating')
  assert.equal(normalizeMemoryStatus(''), 'suggested')
  assert.equal(normalizeMemoryStatus(42), 'suggested')
})

test('时间与来源标签可被搜索', () => {
  const traced = item({
    type: 'mental_model',
    status: 'approved',
    content: '反馈回路',
    origin: 'model-distill',
    discipline: '生物学',
    createdAt: '2026-10-24T10:30:00.000Z',
  })
  assert.equal(originLabel('model-distill'), '模型提炼')
  assert.match(formatMemoryTime(traced.createdAt), /^2026-10-24/u)
  assert.equal(matchesFilter(traced, 'all', '模型提炼'), true)
  assert.equal(matchesFilter(traced, 'all', '2026-10-24'), true)
  assert.equal(matchesFilter(traced, 'all', '生物学'), true)
})

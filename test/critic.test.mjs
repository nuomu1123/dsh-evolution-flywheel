/**
 * 异构批评者（模板）测试：不依赖真实 Ollama，全部用 fetchImpl 桩。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { criticize, criticEnabled, criticRoutes, criticSummary } from '../lib/memory/critic.js'
import { computeCriticAdoption } from '../lib/memory/adoption.js'

const okResponse = content => ({
  ok: true,
  status: 200,
  json: async () => ({ message: { content } }),
})

test('批评者：解析合法 JSON 并规范化 issues（丢弃无 why 的项）', async () => {
  const result = await criticize({ kind: 'code', content: 'x' }, {
    fetchImpl: async () => okResponse('{"issues":[{"severity":"high","where":"f()","why":"返回值与声明不符"},{"severity":"weird","why":""}]}'),
  })
  assert.equal(result.ok, true)
  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0].severity, 'high')
  assert.equal(result.issues[0].where, 'f()')
})

test('批评者：HTTP 失败静默降级', async () => {
  const result = await criticize({ kind: 'code', content: 'x' }, {
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  })
  assert.equal(result.ok, false)
  assert.match(result.degraded, /HTTP 503/u)
})

test('批评者：输出不是 JSON 时降级而不是抛错', async () => {
  const result = await criticize({ kind: 'text', content: 'x' }, {
    fetchImpl: async () => okResponse('我觉得没什么大问题。'),
  })
  assert.equal(result.ok, false)
  assert.match(result.degraded, /无法解析/u)
})

test('批评者：网络异常不抛错，只降级', async () => {
  const result = await criticize({ kind: 'memory', content: 'x' }, {
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434') },
  })
  assert.equal(result.ok, false)
  assert.match(result.degraded, /ECONNREFUSED/u)
})

test('批评者路由可由环境变量替换（模板可换家族/更大模型）', () => {
  process.env.DSH_MEMORY_CRITIC_CODE_MODEL = 'my-other-family:32b'
  try {
    assert.equal(criticRoutes().code, 'my-other-family:32b')
    assert.equal(criticRoutes().text, 'qwen2.5:14b', '未覆盖的类别保持默认')
  } finally {
    delete process.env.DSH_MEMORY_CRITIC_CODE_MODEL
  }
})

test('批评者开关默认关闭，on/1/true 才启用', () => {
  delete process.env.DSH_MEMORY_CRITIC
  assert.equal(criticEnabled(), false)
  process.env.DSH_MEMORY_CRITIC = 'on'
  assert.equal(criticEnabled(), true)
  delete process.env.DSH_MEMORY_CRITIC
})

test('criticSummary 只给摘要，不带批评全文', () => {
  assert.equal(criticSummary({ ok: true, critic: 'qwen2.5:14b', issues: [] }), 'qwen2.5:14b 无异议')
  assert.match(criticSummary({ ok: false, critic: 'qwen2.5:14b', issues: [], degraded: 'HTTP 500' }), /降级/u)
  assert.match(
    criticSummary({ ok: true, critic: 'm', issues: [{ severity: 'high', where: 'a', why: 'b' }] }),
    /1 条（high 1）/u,
  )
})

// ---- 批评者采纳率（b665bf2 引入、此前无测试；2026-10-26 抽取为纯函数后补测） ----

const auditEntry = (event, payload) => ({
  ts: '2026-10-26T00:00:00.000Z',
  plugin: 'dsh-evolution-flywheel',
  event,
  payload,
})

test('采纳率：批评有意见 + 审阅驳回 = 采纳', () => {
  const result = computeCriticAdoption([
    auditEntry('memory.critic', { source: 'review', id: 'a', issues: 2 }),
    auditEntry('memory.review.verdict', { id: 'a', decision: 'reject' }),
  ])
  assert.deepEqual(result, { tracked: 1, aligned: 1, misaligned: 0, rate: 1 })
})

test('采纳率：批评有意见但审阅通过 = 未采纳', () => {
  const result = computeCriticAdoption([
    auditEntry('memory.critic', { source: 'review', id: 'b', issues: 1 }),
    auditEntry('memory.review.verdict', { id: 'b', decision: 'approve' }),
  ])
  assert.equal(result.tracked, 1)
  assert.equal(result.aligned, 0)
  assert.equal(result.rate, 0)
})

test('采纳率：无意见 / 手动触发 / 缺裁决 都不计入', () => {
  const result = computeCriticAdoption([
    auditEntry('memory.critic', { source: 'review', id: 'c', issues: 0 }),
    auditEntry('memory.critic', { source: 'api', id: 'd', issues: 3 }),
    auditEntry('memory.review.verdict', { id: 'e', decision: 'reject' }),
  ])
  assert.deepEqual(result, { tracked: 0, aligned: 0, misaligned: 0, rate: null })
})

test('采纳率：同一 id 多次审阅只取最新一条（输入按最新在前）', () => {
  const result = computeCriticAdoption([
    auditEntry('memory.review.verdict', { id: 'f', decision: 'approve' }),
    auditEntry('memory.review.verdict', { id: 'f', decision: 'reject' }),
    auditEntry('memory.critic', { source: 'review', id: 'f', issues: 1 }),
  ])
  assert.equal(result.tracked, 1)
  assert.equal(result.aligned, 0, '最新结论是 approve，不应拿旧 reject 充数')
})

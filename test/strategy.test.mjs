/**
 * 提炼方法论自记录与自进化（元-元认知）测试。
 *
 * 覆盖四条链路：
 * 1. 策略排序 / 注入 / 计数；
 * 2. 小提炼后置反思，且第二次提炼自动读取第一次策略；
 * 3. 大提炼的策略融合与法则入库；
 * 4. 前端“方法论库”的筛选、计数与审计。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryEventHub } from '../lib/memory/events.js'
import { distillModel } from '../lib/memory/model-distill.js'
import { buildDigest } from '../lib/memory/recall.js'
import { SkillReviewEngine } from '../lib/memory/state-machine.js'
import {
  buildStrategyPrompt,
  createStrategyHooks,
  mergeStrategyLibrary,
  parseStrategyMerge,
  parseStrategyReflection,
  prepareStrategyInjection,
  rankStrategies,
  reflectAndStore,
} from '../lib/memory/strategy.js'
import { MemoryStore } from '../lib/memory/store.js'
import { auditItem, matchesFilter, memoryTypeLabel, originLabel, tabCounts } from '../lib/client/logic.js'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-flywheel-strategy-'))
  try {
    await fn(new MemoryStore(dir), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function addStrategy(store, name, extra = {}) {
  const created = await store.appendSuggested(name, 'extraction_strategy')
  assert.ok(created)
  const updated = await store.update(created.id, {
    thinkingModel: '系统韧性',
    analogyReason: '把错误视为压力源',
    effectiveFor: '工具报错类材料',
    strategyStage: 'small',
    confidence: 0.8,
    ...extra,
  })
  assert.ok(updated)
  return updated
}

function strategyItem(id, extra = {}) {
  return {
    id,
    content: `策略-${id}`,
    type: 'extraction_strategy',
    status: 'suggested',
    createdAt: new Date().toISOString(),
    ...extra,
  }
}

test('rankStrategies：已裁决优先、成功次数排序，排除融合法则与已驳回', () => {
  const items = [
    strategyItem('a', { successCount: 0 }),
    strategyItem('b', { status: 'approved', successCount: 2 }),
    strategyItem('c', { status: 'approved', successCount: 5 }),
    strategyItem('d', { successCount: 9 }),
    strategyItem('rule', { status: 'approved', rule: true }),
    strategyItem('rejected', { status: 'rejected' }),
  ]
  const ranked = rankStrategies(items, 2)
  assert.deepEqual(ranked.map(item => item.id), ['c', 'b'])
  assert.deepEqual(rankStrategies(items, 0), [])
  assert.ok(rankStrategies(items, 10).every(item => item.id !== 'rule' && item.id !== 'rejected'))
})

test('buildStrategyPrompt 标注候选/已裁决，并保留思维模型与适用材料', () => {
  const approved = strategyItem('ok', {
    status: 'approved',
    content: '先抽象为系统韧性再映射',
    thinkingModel: '系统韧性',
    analogyReason: '错误是压力源',
    effectiveFor: '工具报错',
    successCount: 3,
    appliedCount: 2,
  })
  const candidate = strategyItem('cand', {
    content: '先找反例再归纳',
    thinkingModel: '反例驱动',
    effectiveFor: '需求文档',
  })
  const prompt = buildStrategyPrompt([approved, candidate])
  assert.match(prompt, /提炼方法论自注入/)
  assert.match(prompt, /先抽象为系统韧性再映射/)
  assert.match(prompt, /已裁决/)
  assert.match(prompt, /候选（未经人类裁决，仅供试用）/)
  assert.match(prompt, /系统韧性/)
  assert.match(prompt, /工具报错/)
  assert.equal(buildStrategyPrompt([]), '')
})

test('prepareStrategyInjection 把“被注入”写回策略计数', async () => {
  await withStore(async store => {
    const strategy = await addStrategy(store, '先抽象后映射')
    const first = await prepareStrategyInjection(store, 3)
    assert.deepEqual(first.ids, [strategy.id])
    assert.match(first.text, /先抽象后映射/)
    assert.match(first.text, /候选（未经人类裁决/)
    const afterFirst = (await store.list()).find(item => item.id === strategy.id)
    assert.equal(afterFirst?.appliedCount, 1)
    assert.ok(typeof afterFirst?.lastAppliedAt === 'string')

    await prepareStrategyInjection(store, 3)
    const afterSecond = (await store.list()).find(item => item.id === strategy.id)
    assert.equal(afterSecond?.appliedCount, 2)
    assert.ok((afterSecond?.trace ?? []).some(step => step.includes('第 2 次被注入')))
  })
})

test('反思解析：容忍 Markdown 围栏与字符串置信度', () => {
  const reflection = parseStrategyReflection(
    '好的：\n```json\n{"name":"先抽象后映射","thinkingModel":"系统韧性","analogyReason":"错误是压力源","effectiveFor":"工具报错","confidence":"0.7"}\n```',
  )
  assert.equal(reflection?.name, '先抽象后映射')
  assert.equal(reflection?.confidence, 0.7)
  assert.equal(parseStrategyReflection('{}'), undefined)
  assert.equal(parseStrategyReflection('不是 JSON'), undefined)
})

test('融合解析：把序号映射回策略 id', () => {
  const strategies = [strategyItem('s1'), strategyItem('s2'), strategyItem('s3')]
  const merged = parseStrategyMerge(
    '```json\n{"rule":"先抽象为系统韧性，再跨域映射","rationale":"错误是压力源","appliesTo":"工具报错","sourceIds":[1,3,99]}\n```',
    strategies,
  )
  assert.equal(merged?.rule, '先抽象为系统韧性，再跨域映射')
  assert.deepEqual(merged?.sourceIds, ['s1', 's3'])
  assert.equal(parseStrategyMerge('{"rationale":"没有法则"}', strategies), undefined)
})

test('reflectAndStore：后置反思入库为 suggested 策略，保留四要素', async () => {
  await withStore(async store => {
    const reflector = {
      reflect: async () => ({
        name: '先抽象为系统韧性再映射',
        thinkingModel: '系统韧性',
        analogyReason: '错误是压力源，系统会吸收或崩溃',
        effectiveFor: '工具报错与测试失败类材料',
        confidence: 0.82,
        tokensUsed: 7,
      }),
      merge: async () => undefined,
    }
    const created = await reflectAndStore(store, reflector, {
      stage: 'small',
      task: '排错经验：ModuleNotFoundError',
      outcome: '初审通过',
    })
    assert.equal(created?.type, 'extraction_strategy')
    assert.equal(created?.status, 'suggested')
    assert.equal(created?.strategyStage, 'small')
    assert.equal(created?.origin, 'strategy-reflection')
    assert.equal(created?.thinkingModel, '系统韧性')
    assert.match(created?.analogyReason ?? '', /压力源/)
    assert.match(created?.effectiveFor ?? '', /工具报错/)
    assert.equal(created?.confidence, 0.82)
    assert.equal(created?.reviewTokens, 7)
    assert.ok((created?.trace ?? []).some(step => step.includes('思维模型')))

    // 同名策略不重复写入。
    const again = await reflectAndStore(store, reflector, {
      stage: 'small',
      task: '排错经验：另一个',
      outcome: '初审通过',
    })
    assert.equal(again?.id, created?.id)
    assert.equal((await store.list()).filter(item => item.type === 'extraction_strategy').length, 1)
  })
})

test('小提炼连续性：第二次任务自动读取第一次沉淀的策略', async () => {
  await withStore(async store => {
    const hints = []
    const reflector = {
      reflect: async () => ({
        name: '先抽象系统韧性再映射',
        thinkingModel: '系统韧性',
        analogyReason: '错误是压力源',
        effectiveFor: '工具报错类材料',
        confidence: 0.8,
      }),
      merge: async () => undefined,
    }
    const hooks = {
      injection: limit => prepareStrategyInjection(store, limit),
      reflect: input => reflectAndStore(store, reflector, input),
    }
    const driver = {
      review: async (record, hint) => {
        hints.push(hint ?? '')
        return { decision: 'approve', reason: '安全可复现', resolution: '修正路径后重试', tokensUsed: 3 }
      },
      debate: async () => assert.fail('初审通过，不应进入辩论'),
    }
    const engine = new SkillReviewEngine(store, new MemoryEventHub(), driver, undefined, hooks)

    const first = await store.captureSkillError({
      errorSignature: 'Error: 第一次失败',
      context: '第一个任务',
      resolution: '修复一',
      fingerprint: 'fp-first',
    })
    assert.ok(first)
    await engine.review(first.item.id)
    const afterFirst = (await store.list()).filter(item => item.type === 'extraction_strategy')
    assert.equal(afterFirst.length, 1)
    assert.equal(afterFirst[0].status, 'suggested')
    assert.equal(hints[0], '')

    const second = await store.captureSkillError({
      errorSignature: 'Error: 第二次失败',
      context: '第二个任务',
      resolution: '修复二',
      fingerprint: 'fp-second',
    })
    assert.ok(second)
    const reviewed = await engine.review(second.item.id)
    assert.equal(reviewed?.status, 'approved')

    // 验证标准：第二次提炼的提示词里出现了第一次生成的策略。
    assert.match(hints[1], /先抽象系统韧性再映射/)
    const secondRecord = (await store.list()).find(item => item.id === second.item.id)
    assert.ok((secondRecord?.trace ?? []).some(step => step.includes('提炼前注入 1 条策略')))
    const strategy = (await store.list()).find(item => item.type === 'extraction_strategy')
    assert.equal(strategy?.appliedCount, 1)
  })
})

test('大提炼的策略融合：3 条策略融合为法则候选，裁决后进入最高优先级摘要', async () => {
  await withStore(async store => {
    const sources = [
      await addStrategy(store, '策略一：先抽象后映射', { strategyStage: 'small' }),
      await addStrategy(store, '策略二：先找反例', { strategyStage: 'large' }),
      await addStrategy(store, '策略三：用系统韧性作桥', { strategyStage: 'small' }),
    ]
    assert.equal(sources.length, 3)
    const reflector = {
      reflect: async () => undefined,
      merge: async strategies => ({
        rule: '先把问题抽象为系统韧性，再跨域映射到代码',
        rationale: '压力源与容错结构在生物和软件中同构',
        appliesTo: '架构评审与故障复盘',
        sourceIds: strategies.map(item => item.id).slice(0, 3),
        tokensUsed: 12,
      }),
    }
    const rule = await mergeStrategyLibrary(store, reflector)
    assert.equal(rule?.type, 'extraction_strategy')
    assert.equal(rule?.rule, true)
    assert.equal(rule?.strategyStage, 'merge')
    assert.equal(rule?.status, 'suggested')
    assert.equal(rule?.mergedFrom?.length, 3)
    assert.equal(rule?.reviewTokens, 12)
    assert.equal(originLabel(rule?.origin ?? ''), '策略融合')

    // 少于 3 条时不再融合。
    const emptyDir = await mkdtemp(join(tmpdir(), 'dsh-flywheel-empty-'))
    try {
      const empty = new MemoryStore(emptyDir)
      assert.equal(await mergeStrategyLibrary(empty, reflector), undefined)
    } finally {
      await rm(emptyDir, { recursive: true, force: true })
    }

    // 人类裁决前：候选法则不进入最高优先级段落。
    const before = buildDigest(await store.list())
    assert.doesNotMatch(before, /跨域映射法则（人类已裁决，最高优先级）/)

    assert.ok(rule)
    await store.approve(rule.id)
    const after = buildDigest(await store.list())
    assert.match(after, /跨域映射法则（人类已裁决，最高优先级）/)
    assert.match(after, /先把问题抽象为系统韧性/)
    assert.match(after, /提炼方法论（最近最成功，供当前任务参考）/)
    const approvedRule = (await store.list()).find(item => item.id === rule.id)
    assert.equal(approvedRule?.successCount, 1)
  })
})

test('大提炼：生成思维模型 + 后置反思 + 融合法则候选', async () => {
  await withStore(async store => {
    const llm = {
      listProviders: () => [{ id: 'mock' }],
      listModels: async () => [{ id: 'mock-model' }],
      async *stream(options) {
        const system = String(options.system ?? '')
        let text = '{}'
        if (system.includes('元认知提炼方法反思器')) {
          text = '{"name":"先抽象后映射","thinkingModel":"系统韧性","analogyReason":"错误是压力源","effectiveFor":"工具报错","confidence":0.8}'
        } else if (system.includes('跨域映射法则')) {
          text = '{"rule":"先抽象为系统韧性，再跨域映射","rationale":"压力源同构","appliesTo":"架构评审","sourceIds":[1,2,3]}'
        } else {
          text = '{"name":"韧性回路","pattern":"把错误当作压力源并设计吸收结构","appliesTo":"架构评审","counterexample":"一次性脚本不适用","sourceDisciplines":"生物学 / 生态学"}'
        }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const ctx = {
      get(name) {
        return name === 'llm' ? llm : undefined
      },
    }
    await store.appendSpeculative({ title: '韧性之一', insight: '免疫系统用冗余吸收扰动' })
    await store.appendSpeculative({ title: '韧性之二', insight: '生态系统的反馈回路维持稳态' })
    await addStrategy(store, '策略一')
    await addStrategy(store, '策略二')
    await addStrategy(store, '策略三')

    const hooks = createStrategyHooks(ctx, store)
    const result = await distillModel(ctx, store, 500, hooks)
    assert.ok(result)
    assert.equal(result.item.type, 'mental_model')
    assert.equal(result.item.status, 'suggested')
    assert.equal(result.strategy?.type, 'extraction_strategy')
    assert.equal(result.strategy?.strategyStage, 'large')
    assert.equal(result.strategy?.status, 'suggested')
    assert.equal(result.rule?.rule, true)
    assert.equal(result.rule?.strategyStage, 'merge')

    const all = await store.list()
    assert.ok(all.some(item => item.type === 'extraction_strategy' && item.rule === true))
  })
})

test('前端方法论库：筛选、计数、标签与审计', () => {
  const strategy = strategyItem('s1', {
    status: 'suggested',
    strategyStage: 'small',
    thinkingModel: '系统韧性',
  })
  const rule = strategyItem('s2', { status: 'approved', rule: true })
  assert.equal(memoryTypeLabel('extraction_strategy'), '提炼策略')
  assert.equal(originLabel('strategy-reflection'), '提炼反思')
  assert.equal(originLabel('strategy-merge'), '策略融合')
  assert.equal(matchesFilter(strategy, 'strategy', ''), true)
  assert.equal(matchesFilter(strategy, 'strategy', '系统韧性'), true)
  assert.equal(matchesFilter(strategy, 'model', ''), false)

  const counts = tabCounts([strategy, rule])
  assert.equal(counts.strategy, 2)
  assert.equal(counts.all, 2)

  assert.equal(auditItem(strategy).necessity, 'uncertain')
  assert.equal(auditItem(rule).durability, 'long-term')
  assert.equal(auditItem({ ...rule, rule: true }).necessity, 'needed')
})

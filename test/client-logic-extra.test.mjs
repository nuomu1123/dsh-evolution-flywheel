/**
 * client/logic.ts 纯函数补充测试（与 test/logic.test.mjs 互补）。
 *
 * 导入方式：直接加载 TS 源码（Node ≥22.18 原生类型擦除）。
 * 这样测的是 src/client/logic.ts 本身，而不是可能过期的 lib/ 构建产物；
 * 本轮已抽样比对 lib/client/logic.js 与源码行为一致（见报告）。
 *
 * 断言原则：给定输入 → 精确输出；每条断言上方用中文写明它防什么回归。
 * 文件末尾有一组「已知缺陷见证」用例：断言的是当前实际输出，用于在修复时提醒同步更新期望，
 * 不代表认可该行为；缺陷详情见 reports/flywheel-client-logic-findings.md。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  auditItem,
  auditSummary,
  buildDebateBubbles,
  buildTimeline,
  debateVerdictText,
  formatMemoryTime,
  hasDebateRecord,
  isMetaItem,
  matchesFilter,
  memoryStatusLabel,
  memoryTypeLabel,
  normalizeMemoryStatus,
  originLabel,
  tabCounts,
} from '../src/client/logic.ts'

/** 构造最小合法条目；单个用例只覆盖关心的字段。 */
function item(overrides = {}) {
  return {
    id: 'mem-1',
    content: '示例内容',
    type: 'skill_error_fix',
    status: 'suggested',
    createdAt: '2026-10-24T10:30:00',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 标签与归一化
// ---------------------------------------------------------------------------

test('memoryTypeLabel：11 种类型逐一精确映射（防标签串位或分支丢失）', () => {
  // 防回归：任一 if 分支被删/顺序被改，卡片与筛选徽标会显示错误类型名。
  assert.equal(memoryTypeLabel('skill_error_fix'), '排错经验')
  assert.equal(memoryTypeLabel('conflict'), '冲突提醒')
  assert.equal(memoryTypeLabel('speculative'), '漫游假想')
  assert.equal(memoryTypeLabel('meta_insight'), '元认知洞察')
  assert.equal(memoryTypeLabel('mental_model'), '思维模型')
  assert.equal(memoryTypeLabel('extraction_strategy'), '提炼策略')
  assert.equal(memoryTypeLabel('curation_report'), '整理报告')
  assert.equal(memoryTypeLabel('cognitive_probe'), '认知探针')
  assert.equal(memoryTypeLabel('cognitive_brief'), '认知简报')
  // 防回归：fact/preference 走最后的三元兜底，不能被前面的分支吞掉。
  assert.equal(memoryTypeLabel('fact'), '事实')
  assert.equal(memoryTypeLabel('preference'), '偏好')
  // 现状：JSONL 被手改或未来新增类型时回退「偏好」（报告观察 O1，非本轮缺陷结论）。
  assert.equal(memoryTypeLabel('future_type'), '偏好')
})

test('formatMemoryTime：本地时间补零与年月日顺序（防月/日错位、防单数字不补零）', () => {
  // 无偏移的 ISO 按本地时间解析，这两个断言不依赖运行机器时区。
  assert.equal(formatMemoryTime('2026-01-05T04:07:00'), '2026-01-05 04:07')
  assert.equal(formatMemoryTime('2026-12-31T23:59:00'), '2026-12-31 23:59')
})

test('formatMemoryTime：无法解析时原样返回，日历越界日期存在已知缺陷（F5）', () => {
  // 防回归：非法时间不能被渲染成 "NaN"、"Invalid Date" 或空串。
  assert.equal(formatMemoryTime('not-a-date'), 'not-a-date')
  assert.equal(formatMemoryTime(''), '')
  // 月份越界会被 Date 判为 Invalid Date，走原样兜底。
  assert.equal(formatMemoryTime('2026-13-01T00:00:00'), '2026-13-01T00:00:00')
  // 已知缺陷 F5：6 月 31 日被 V8 归一化成 7 月 1 日，没有走非法兜底（见报告）。
  assert.equal(formatMemoryTime('2026-06-31T00:00:00'), '2026-07-01 00:00')
})

test('originLabel：9 种来源精确映射，缺省与未知来源回退本地记忆', () => {
  const expected = {
    'error-capture': '错误捕获',
    dma: '跨学科漫游',
    'model-distill': '模型提炼',
    'strategy-reflection': '提炼反思',
    'strategy-merge': '策略融合',
    curation: '整理 Agent',
    probe: '认知探针',
    // 2026-10-24 补：浏览器审计是新来源，不映射会显示成「本地记忆」（溯源失真）。
    'browser-observer': '浏览器动作',
    manual: '手动记录',
  }
  // 防回归：来源标签错位会让「模型提炼」被误标成「本地记忆」，溯源失真。
  for (const [origin, label] of Object.entries(expected)) {
    assert.equal(originLabel(origin), label, `来源 ${origin} 应显示 ${label}`)
  }
  // 防回归：旧数据没有 origin 字段（undefined）时必须回退，而不是显示 undefined。
  assert.equal(originLabel(undefined), '本地记忆')
  assert.equal(originLabel('unknown-origin'), '本地记忆')
})

test('memoryStatusLabel：8 种状态精确映射，未知状态原样返回', () => {
  const expected = {
    under_review: '审核中',
    debating: '对抗辩论中',
    human_intervention: '请求人类圣裁',
    rejected: '已丢弃',
    speculative: '离线漫游',
    staged: '待审核',
    suggested: '待确认',
    approved: '已生效',
  }
  // 防回归：状态文案决定用户对条目命运的判断，不能互换或漏翻。
  for (const [status, label] of Object.entries(expected)) {
    assert.equal(memoryStatusLabel(status), label, `状态 ${status} 应显示 ${label}`)
  }
  // 防回归：未知状态必须原样暴露，不能被吞成空串或「偏好」。
  assert.equal(memoryStatusLabel('mystery'), 'mystery')
})

test('isMetaItem：只有元认知洞察与漫游假想算元条目', () => {
  // 防回归：误把思维模型/整理报告算进 dma（跨学科漫游）分区。
  assert.equal(isMetaItem(item({ type: 'meta_insight' })), true)
  assert.equal(isMetaItem(item({ type: 'speculative' })), true)
  assert.equal(isMetaItem(item({ type: 'fact' })), false)
  assert.equal(isMetaItem(item({ type: 'mental_model' })), false)
  assert.equal(isMetaItem(item({ type: 'curation_report' })), false)
})

test('normalizeMemoryStatus：空白与非字符串回退 suggested，合法值 trim 后原样穿透', () => {
  // 防回归：合法状态必须原样穿透，不能被归一化改写。
  assert.equal(normalizeMemoryStatus('debating'), 'debating')
  // 防回归：持久化数据缺失/损坏时回退 suggested，防止卡片状态变成 undefined。
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(normalizeMemoryStatus(bad), 'suggested')
  }
  // 已修复 F3：带空白的合法状态被 trim，下游精确比较不再失配。
  assert.equal(normalizeMemoryStatus(' approved '), 'approved')
})

// ---------------------------------------------------------------------------
// 四段式时间轴
// ---------------------------------------------------------------------------

test('buildTimeline：提交段优先错误特征并拼接上下文（防丢失上下文）', () => {
  // 防回归：有 errorSignature 时不能只显示 content，否则检索线索丢失。
  assert.equal(
    buildTimeline(item({ errorSignature: 'ModuleNotFoundError', context: 'Python 3.11' }))[0].text,
    '错误：ModuleNotFoundError\n上下文：Python 3.11',
  )
  // 防回归：没有 context 时不能拼出「上下文：undefined」。
  assert.equal(buildTimeline(item({ errorSignature: 'EPERM' }))[0].text, '错误：EPERM')
  // 防回归：没有 errorSignature 时提交段必须退回正文，不能为空。
  assert.equal(buildTimeline(item({ content: '纯正文', errorSignature: undefined }))[0].text, '纯正文')
})

test('buildTimeline：四段键与标题固定有序（防时间轴顺序/标题回归）', () => {
  const nodes = buildTimeline(item({ status: 'approved' }))
  // 防回归：四段少一段或多一段都会让详情面板错位。
  assert.equal(nodes.length, 4)
  assert.deepEqual(nodes.map(node => node.key), ['submit', 'review', 'challenge', 'verdict'])
  // logic.ts 没有排序逻辑，这里用固定步骤顺序替代「排序稳定性」边界：相等节点也必须保持声明顺序。
  assert.deepEqual(nodes.map(node => node.title), ['① 子 Agent 提交', '② 母 Agent 初审', '③ 子 Agent 顶嘴', '④ 裁决'])
})

test('buildTimeline：未进入辩论时三段兜底文案与绿色裁决（防虚构辩论）', () => {
  const nodes = buildTimeline(item({ status: 'approved' }))
  // 防回归：没有辩论记录时不能凭空写出驳回理由或反驳内容。
  assert.equal(nodes[1].text, '初审通过，未进入辩论')
  assert.equal(nodes[2].text, '未进入辩论')
  // 防回归：裁决段不能退回状态枚举值（approved）而是可读文案。
  assert.equal(nodes[3].text, '裁决通过，已生效')
  assert.equal(nodes[3].tone, '#15803d')
})

test('buildTimeline：有辩论记录但缺字段时如实标注，不虚构内容', () => {
  // 旧数据只有摘要：初审理由与反驳都缺，必须标注缺失而不是编造。
  const summaryOnly = buildTimeline(item({ status: 'approved', debateSummary: '旧摘要' }))
  assert.equal(summaryOnly[1].text, '驳回理由未记录')
  assert.equal(summaryOnly[2].text, '本轮反驳未单独记录，以下为辩论摘要：\n旧摘要')
  // 只有顶嘴记录：初审理由缺失，但反驳原文必须完整保留。
  const challengeOnly = buildTimeline(item({ status: 'approved', challenge: '已装依赖' }))
  assert.equal(challengeOnly[1].text, '驳回理由未记录')
  assert.equal(challengeOnly[2].text, '已装依赖')
  // reviewReason 优先级最高，不能被兜底文案覆盖。
  const reviewWins = buildTimeline(item({
    status: 'approved',
    reviewReason: '未锁版本',
    challenge: '已装依赖',
    debateSummary: '摘要',
  }))
  assert.equal(reviewWins[1].text, '未锁版本')
  assert.equal(reviewWins[2].text, '已装依赖')
})

test('buildTimeline：裁决段覆盖人类圣裁/强制采纳/强制驳回与色调', () => {
  // 防回归：待圣裁必须是红色，不能被普通绿色裁决色覆盖。
  const human = buildTimeline(item({ status: 'human_intervention' }))
  assert.equal(human[3].text, '等待人类圣裁')
  assert.equal(human[3].tone, '#d92d20')
  // 防回归：驳回与通过必须可区分（灰色 vs 绿色）。
  const rejected = buildTimeline(item({ status: 'rejected' }))
  assert.equal(rejected[3].text, '裁决驳回，已丢弃')
  assert.equal(rejected[3].tone, '#6b7280')
  // 人类强制裁决必须覆盖普通裁决文案，保留人类最终裁量权。
  assert.equal(buildTimeline(item({ status: 'rejected', humanDecision: 'discard' }))[3].text, '人类强制驳回，已丢弃')
  assert.equal(buildTimeline(item({ status: 'approved', humanDecision: 'adopt' }))[3].text, '人类强制采纳，已生效')
  // 非终态（待审核）必须回落到状态标签，不能显示成已生效。
  assert.equal(buildTimeline(item({ status: 'staged' }))[3].text, '待审核')
})

// ---------------------------------------------------------------------------
// 辩论记录与气泡
// ---------------------------------------------------------------------------

test('hasDebateRecord：逐轮/顶嘴/摘要/状态五种来源均算记录', () => {
  // 防回归：任一来源被漏判，辩论 Tab 会少卡片。
  assert.equal(hasDebateRecord(item({ debateRounds: [{ role: 'child', content: 'a' }] })), true)
  assert.equal(hasDebateRecord(item({ challenge: '顶嘴' })), true)
  assert.equal(hasDebateRecord(item({ debateSummary: '摘要' })), true)
  assert.equal(hasDebateRecord(item({ status: 'debating' })), true)
  assert.equal(hasDebateRecord(item({ status: 'human_intervention' })), true)
  // 防回归：普通已生效条目不应被算作辩论记录。
  assert.equal(hasDebateRecord(item({ status: 'approved' })), false)
  // 已修复 F2：空数组不再算记录，与 buildDebateBubbles 的结论同源。
  assert.equal(hasDebateRecord(item({ debateRounds: [] })), false)
  assert.deepEqual(buildDebateBubbles(item({ debateRounds: [] })), [])
})

test('debateVerdictText：各状态精确文案（防辩论结论与状态脱节）', () => {
  assert.equal(debateVerdictText(item({ status: 'human_intervention' })), '未收敛 · 等待人类圣裁')
  assert.equal(debateVerdictText(item({ status: 'debating' })), '辩论进行中 · 等待母 Agent 回应')
  assert.equal(debateVerdictText(item({ status: 'approved' })), '辩论收敛 · 裁决通过')
  // 防回归：人类强制采纳/驳回必须与普通裁决文案区分。
  assert.equal(debateVerdictText(item({ status: 'approved', humanDecision: 'adopt' })), '人类强制采纳 · 已生效')
  assert.equal(debateVerdictText(item({ status: 'rejected' })), '辩论收敛 · 裁决驳回')
  assert.equal(debateVerdictText(item({ status: 'rejected', humanDecision: 'discard' })), '人类强制驳回 · 已丢弃')
  // 防回归：非辩论终态回落到状态标签，不能误写「辩论收敛」。
  assert.equal(debateVerdictText(item({ status: 'staged' })), '待审核')
  assert.equal(debateVerdictText(item({ status: 'suggested' })), '待确认')
})

test('buildDebateBubbles：逐轮优先、旧数据降级、空数组回退且顺序保真', () => {
  // 防回归：逐轮记录必须原样返回；内容相同的发言也要保持原顺序与条数（logic.ts 无排序逻辑，
  // 这里用「相等内容保序」替代排序稳定性边界）。
  const rounds = [
    { role: 'child', content: '同一句' },
    { role: 'mother', content: '同一句' },
    { role: 'child', content: '同一句' },
  ]
  assert.deepEqual(buildDebateBubbles(item({ debateRounds: rounds })), rounds)
  // 空逐轮数组应降级到旧字段 challenge，而不是渲染空白气泡。
  assert.deepEqual(
    buildDebateBubbles(item({ debateRounds: [], challenge: '只有顶嘴' })),
    [{ role: 'child', content: '只有顶嘴' }],
  )
  // 防回归：空逐轮 + 无 challenge 必须返回 []，不能返回 null/undefined 让 UI 崩溃。
  assert.deepEqual(buildDebateBubbles(item({ debateRounds: [], challenge: undefined })), [])
  assert.deepEqual(buildDebateBubbles(item({})), [])
})

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------

test('matchesFilter：Tab 命中矩阵（防分区串类与漏类）', () => {
  const fact = item({ id: 'fact', type: 'fact', status: 'approved' })
  const preference = item({ id: 'pref', type: 'preference', status: 'suggested' })
  const skill = item({ id: 'skill', type: 'skill_error_fix', status: 'approved' })
  const skillDebate = item({ id: 'skill-debate', type: 'skill_error_fix', status: 'approved', debateSummary: '摘要' })
  const model = item({ id: 'model', type: 'mental_model', status: 'approved' })
  const strategy = item({ id: 'strategy', type: 'extraction_strategy', status: 'approved' })
  const curation = item({ id: 'curation', type: 'curation_report', status: 'approved' })
  const probe = item({ id: 'probe', type: 'cognitive_probe' })
  const brief = item({ id: 'brief', type: 'cognitive_brief' })
  const meta = item({ id: 'meta', type: 'meta_insight' })
  const spec = item({ id: 'spec', type: 'speculative' })
  const human = item({ id: 'human', status: 'human_intervention' })
  const allItems = [fact, preference, skill, skillDebate, model, strategy, curation, probe, brief, meta, spec, human]

  // 防回归：all 与 audit 必须覆盖全部条目（audit 是人工复核视图，不是类型分区）。
  for (const entry of allItems) {
    assert.equal(matchesFilter(entry, 'all', ''), true, `all 应包含 ${entry.id}`)
    assert.equal(matchesFilter(entry, 'audit', ''), true, `audit 应包含 ${entry.id}`)
  }
  // basic 只收事实/偏好，排错经验不能混入。
  assert.equal(matchesFilter(fact, 'basic', ''), true)
  assert.equal(matchesFilter(preference, 'basic', ''), true)
  assert.equal(matchesFilter(skill, 'basic', ''), false)
  // skill 只收排错经验。
  assert.equal(matchesFilter(skill, 'skill', ''), true)
  assert.equal(matchesFilter(fact, 'skill', ''), false)
  assert.equal(matchesFilter(model, 'skill', ''), false)
  // dma 只收元认知洞察与漫游假想。
  assert.equal(matchesFilter(meta, 'dma', ''), true)
  assert.equal(matchesFilter(spec, 'dma', ''), true)
  assert.equal(matchesFilter(fact, 'dma', ''), false)
  // human 只收待人类圣裁。
  assert.equal(matchesFilter(human, 'human', ''), true)
  assert.equal(matchesFilter(fact, 'human', ''), false)
  // debate 必须是「排错经验 + 有辩论记录」双条件。
  assert.equal(matchesFilter(skillDebate, 'debate', ''), true)
  assert.equal(matchesFilter(skill, 'debate', ''), false)
  assert.equal(matchesFilter(fact, 'debate', ''), false)
  // 专项分区不可互相串类。
  assert.equal(matchesFilter(model, 'model', ''), true)
  assert.equal(matchesFilter(strategy, 'model', ''), false)
  assert.equal(matchesFilter(strategy, 'strategy', ''), true)
  assert.equal(matchesFilter(curation, 'curation', ''), true)
  assert.equal(matchesFilter(probe, 'probe', ''), true)
  assert.equal(matchesFilter(brief, 'probe', ''), true)
  assert.equal(matchesFilter(fact, 'probe', ''), false)
})

test('matchesFilter：关键词覆盖正文/标签/时间/来源与扩展字段（防字段漏搜）', () => {
  const base = { content: '基础内容' }
  const cases = [
    ['content', { content: 'content-token' }, 'content-token'],
    ['类型标签', { type: 'mental_model' }, '思维模型'],
    ['状态标签', { status: 'human_intervention' }, '请求人类圣裁'],
    ['创建时间', { createdAt: '2027-03-04T10:00:00' }, '2027-03-04'],
    ['来源标签', { origin: 'probe' }, '认知探针'],
    ['discipline', { discipline: '生物学' }, '生物学'],
    ['topic', { topic: 'topic-token' }, 'topic-token'],
    ['thinkingModel', { thinkingModel: 'thinking-token' }, 'thinking-token'],
    ['analogyReason', { analogyReason: 'analogy-token' }, 'analogy-token'],
    ['effectiveFor', { effectiveFor: 'effective-token' }, 'effective-token'],
    ['resolution', { resolution: 'resolution-token' }, 'resolution-token'],
    ['errorSignature', { errorSignature: 'signature-token' }, 'signature-token'],
    ['context', { context: 'context-token' }, 'context-token'],
    ['reviewReason', { reviewReason: 'review-token' }, 'review-token'],
    ['debateSummary', { debateSummary: 'debate-token' }, 'debate-token'],
    ['challenge', { challenge: 'challenge-token' }, 'challenge-token'],
    ['strategyStage', { strategyStage: 'merge' }, 'merge'],
    ['rule 标记', { rule: true }, '融合法则'],
    ['mergedFrom 拼接', { mergedFrom: ['alpha', 'beta'] }, 'alpha beta'],
    ['reportJson', { reportJson: 'report-token' }, 'report-token'],
    ['trace 数组', { trace: ['trace-a', 'trace-b'] }, 'trace-b'],
    ['sources 数组', { sources: ['https://example.com/source-token'] }, 'source-token'],
  ]
  // 防回归：任一可搜索字段被删出拼接数组，用户就搜不到对应记忆。
  for (const [field, overrides, keyword] of cases) {
    assert.equal(
      matchesFilter(item({ ...base, ...overrides }), 'all', keyword),
      true,
      `${field} 应能命中关键词 ${keyword}`,
    )
  }
  // 防回归：不存在的词必须返回 false，不能因空数组/空串误命中。
  assert.equal(matchesFilter(item({ content: '基础内容' }), 'all', '不存在的关键词'), false)
  // 大小写契约：正文侧统一小写；调用方 index.ts 已 query.trim().toLowerCase()（报告观察 O2）。
  assert.equal(matchesFilter(item({ content: 'EPERM exit code 1' }), 'all', 'eperm'), true)
})

test('matchesFilter：缺字段条目不抛错，空关键词在命中的 Tab 内恒真', () => {
  const minimal = { id: 'min', content: '裸条目', type: 'fact', status: 'suggested', createdAt: '2026-01-01T00:00:00' }
  // 防回归：没有 trace/sources/mergedFrom 等可选字段时不能因 undefined 崩溃。
  assert.equal(matchesFilter(minimal, 'all', ''), true)
  assert.equal(matchesFilter(minimal, 'basic', '裸条目'), true)
  assert.equal(matchesFilter(minimal, 'basic', '不存在的词'), false)
  // 防回归：显式 undefined 与缺字段等价，不能误判成可搜索文本 "undefined"。
  assert.equal(matchesFilter(
    { ...minimal, trace: undefined, sources: undefined, mergedFrom: undefined, rule: undefined },
    'all',
    '裸条目',
  ), true)
})

// ---------------------------------------------------------------------------
// 规则自审计
// ---------------------------------------------------------------------------

test('auditItem：驳回优先级最高，覆盖类型规则', () => {
  // 防回归：已驳回条目必须判为可清理，不能被「事实类长期有效」等类型规则覆盖。
  assert.deepEqual(auditItem(item({ type: 'fact', status: 'rejected' })), {
    durability: 'temporary',
    necessity: 'unneeded',
    reason: '已被驳回，可归档或删除',
  })
  assert.deepEqual(auditItem(item({ type: 'preference', status: 'rejected' })), {
    durability: 'temporary',
    necessity: 'unneeded',
    reason: '已被驳回，可归档或删除',
  })
})

test('auditItem：偏好/事实长期有效且与状态无关', () => {
  const expected = { durability: 'long-term', necessity: 'needed', reason: '偏好/事实类，长期有效' }
  // 防回归：偏好/事实即使用户还没确认（suggested）也应长期保留。
  assert.deepEqual(auditItem(item({ type: 'preference', status: 'approved' })), expected)
  assert.deepEqual(auditItem(item({ type: 'fact', status: 'suggested' })), expected)
})

test('auditItem：思维模型与提炼策略/融合法则的裁决分支', () => {
  // 防回归：未采纳的模型只能算临时候选，不能误标长期。
  assert.deepEqual(auditItem(item({ type: 'mental_model', status: 'approved' })), {
    durability: 'long-term',
    necessity: 'needed',
    reason: '已采纳的思维模型，可跨任务复用',
  })
  assert.deepEqual(auditItem(item({ type: 'mental_model', status: 'suggested' })), {
    durability: 'temporary',
    necessity: 'uncertain',
    reason: '模型候选，待人类采纳',
  })
  // 防回归：普通方法论与融合法则（rule=true）必须给出不同理由，避免审计误判层级。
  assert.deepEqual(auditItem(item({ type: 'extraction_strategy', status: 'approved' })), {
    durability: 'long-term',
    necessity: 'needed',
    reason: '已裁决的提炼方法论，可跨任务复用',
  })
  assert.deepEqual(auditItem(item({ type: 'extraction_strategy', status: 'suggested' })), {
    durability: 'temporary',
    necessity: 'uncertain',
    reason: '提炼方法论候选，仅试用注入，待人类裁决',
  })
  assert.deepEqual(auditItem(item({ type: 'extraction_strategy', status: 'approved', rule: true })), {
    durability: 'long-term',
    necessity: 'needed',
    reason: '人类已裁决的跨域映射法则，以最高优先级注入',
  })
  assert.deepEqual(auditItem(item({ type: 'extraction_strategy', status: 'suggested', rule: true })), {
    durability: 'temporary',
    necessity: 'uncertain',
    reason: '融合法则候选，等待人类裁决',
  })
})

test('auditItem：整理报告与排错经验的全部裁决分支', () => {
  // 防回归：整理报告即使已执行也只是归档备查，不能算长期知识。
  assert.deepEqual(auditItem(item({ type: 'curation_report', status: 'approved' })), {
    durability: 'temporary',
    necessity: 'uncertain',
    reason: '已执行的人类裁决报告，可归档备查',
  })
  assert.deepEqual(auditItem(item({ type: 'curation_report', status: 'suggested' })), {
    durability: 'temporary',
    necessity: 'uncertain',
    reason: '整理报告待人类裁决，未执行归档',
  })
  // 防回归：待圣裁 / 未确认的排错经验不得先按内容归类。
  assert.deepEqual(auditItem(item({ type: 'skill_error_fix', status: 'human_intervention' })), {
    durability: 'temporary',
    necessity: 'uncertain',
    reason: '待人类裁决，暂不归类',
  })
  assert.deepEqual(auditItem(item({ type: 'skill_error_fix', status: 'suggested' })), {
    durability: 'temporary',
    necessity: 'uncertain',
    reason: '尚未确认，暂不归类',
  })
  // 防回归：测试/环境副产物不能沉淀为长期经验（errorSignature 与 content 两条来源分别验证）。
  assert.deepEqual(auditItem(item({ type: 'skill_error_fix', status: 'approved', errorSignature: 'vitest failed', resolution: 'x' })), {
    durability: 'temporary',
    necessity: 'unneeded',
    reason: '测试/环境副产物，通常无需长期保留',
  })
  assert.deepEqual(auditItem(item({ type: 'skill_error_fix', status: 'approved', content: 'Cannot find module foo', resolution: '装依赖' })), {
    durability: 'temporary',
    necessity: 'unneeded',
    reason: '测试/环境副产物，通常无需长期保留',
  })
  // 防回归：纯空白解决办法等于没有解决办法。
  assert.deepEqual(auditItem(item({ type: 'skill_error_fix', status: 'approved', resolution: '   ' })), {
    durability: 'temporary',
    necessity: 'uncertain',
    reason: '缺少可执行解决办法',
  })
  // 防回归：已确认且给出解决办法的排错经验才可长期保留。
  assert.deepEqual(auditItem(item({ type: 'skill_error_fix', status: 'approved', resolution: '锁定版本' })), {
    durability: 'long-term',
    necessity: 'needed',
    reason: '已确认的排错经验，含解决办法',
  })
})

test('auditItem：漫游假想/元认知洞察需人工沉淀，未知类型兜底未分类', () => {
  const speculative = {
    durability: 'temporary',
    necessity: 'uncertain',
    reason: '漫游假想，需人工判断是否沉淀',
  }
  // 防回归：假想与洞察不能被自动判为长期知识。
  assert.deepEqual(auditItem(item({ type: 'speculative', status: 'speculative' })), speculative)
  assert.deepEqual(auditItem(item({ type: 'meta_insight', status: 'approved' })), speculative)
  // 防回归：损坏/未知类型必须明确标成「未分类」，不能默认长期有效。
  assert.deepEqual(auditItem(item({ type: 'future_type' })), {
    durability: 'temporary',
    necessity: 'uncertain',
    reason: '未分类',
  })
})

test('auditSummary：空数组全零（防空态徽标 NaN 或 undefined）', () => {
  assert.deepEqual(auditSummary([]), { longTerm: 0, temporary: 0, needed: 0, unneeded: 0, uncertain: 0 })
})

test('auditSummary：双维度计数精确且各自守恒', () => {
  const items = [
    item({ id: 'fact-ok', type: 'fact', status: 'approved' }),
    item({ id: 'fact-rejected', type: 'fact', status: 'rejected' }),
    item({ id: 'skill-resolved', type: 'skill_error_fix', status: 'approved', resolution: '修复' }),
    item({ id: 'skill-transient', type: 'skill_error_fix', status: 'approved', errorSignature: 'vitest failed', resolution: 'x' }),
    item({ id: 'model-candidate', type: 'mental_model', status: 'suggested' }),
    item({ id: 'curation-approved', type: 'curation_report', status: 'approved' }),
  ]
  const summary = auditSummary(items)
  // 防回归：每个分支的计数必须精确，不能互相串桶。
  assert.deepEqual(summary, { longTerm: 2, temporary: 4, needed: 2, unneeded: 2, uncertain: 2 })
  // 防回归：两个维度都必须恰好覆盖全部条目（不漏计/重复计）。
  assert.equal(summary.longTerm + summary.temporary, items.length)
  assert.equal(summary.needed + summary.unneeded + summary.uncertain, items.length)
})

// ---------------------------------------------------------------------------
// Tab 徽标计数
// ---------------------------------------------------------------------------

test('tabCounts：空数组返回完整零值键与固定顺序（防徽标缺键/顺序抖动）', () => {
  const counts = tabCounts([])
  // 防回归：11 个 Tab 缺一个就会在空态显示 undefined。
  assert.deepEqual(counts, {
    all: 0,
    basic: 0,
    skill: 0,
    dma: 0,
    human: 0,
    debate: 0,
    audit: 0,
    model: 0,
    strategy: 0,
    curation: 0,
    probe: 0,
  })
  // logic.ts 无排序逻辑，这里用对象键顺序替代排序稳定性边界：Tab 顺序必须稳定。
  assert.deepEqual(Object.keys(counts), ['all', 'basic', 'skill', 'dma', 'human', 'debate', 'audit', 'model', 'strategy', 'curation', 'probe'])
})

test('tabCounts：混合集合精确计数（同一卡片可命中多个 Tab）', () => {
  const items = [
    item({ id: 'fact', type: 'fact', status: 'approved' }),
    item({ id: 'pref', type: 'preference', status: 'suggested' }),
    item({ id: 'skill', type: 'skill_error_fix', status: 'approved' }),
    item({ id: 'skill-debate', type: 'skill_error_fix', status: 'approved', debateSummary: '摘要' }),
    item({ id: 'model', type: 'mental_model', status: 'approved' }),
    item({ id: 'strategy', type: 'extraction_strategy', status: 'approved', rule: true }),
    item({ id: 'curation', type: 'curation_report', status: 'approved' }),
    item({ id: 'probe', type: 'cognitive_probe' }),
    item({ id: 'brief', type: 'cognitive_brief' }),
    item({ id: 'spec', type: 'speculative' }),
    item({ id: 'meta', type: 'meta_insight' }),
    item({ id: 'human', type: 'fact', status: 'human_intervention' }),
    item({ id: 'skill-human', type: 'skill_error_fix', status: 'human_intervention' }),
  ]
  const counts = tabCounts(items)
  // 防回归：计数必须与筛选函数同源，不能出现「徽标 3 条、列表 2 条」。
  assert.deepEqual(counts, {
    all: 13,
    basic: 3,
    skill: 3,
    dma: 2,
    human: 2,
    debate: 2,
    audit: 13,
    model: 1,
    strategy: 1,
    curation: 1,
    probe: 2,
  })
  // 交叉校验重叠：第 12 条同时属于 basic 与 human，证明计数不是互斥分类。
  assert.equal(matchesFilter(items[11], 'basic', ''), true)
  assert.equal(matchesFilter(items[11], 'human', ''), true)
  // 防回归：任一单 Tab 计数超过总数，说明重复计数。
  for (const [tab, value] of Object.entries(counts)) {
    assert.ok(value <= items.length, `${tab} 计数不应超过总条目数 ${items.length}`)
  }
})

// ---------------------------------------------------------------------------
// 数字精度与超长文本（logic.ts 没有浮点运算/截断逻辑，改为锁定相邻保证）
// ---------------------------------------------------------------------------

test('auditSummary/tabCounts：1000 条整数计数不漂移（数字精度）', () => {
  // logic.ts 没有浮点算术，数字相关输出就是整数计数器；用大批量数据验证不漂移、不失精度。
  const items = Array.from({ length: 1000 }, (_, index) => item({
    id: `bulk-${index}`,
    type: 'fact',
    status: index < 400 ? 'approved' : 'rejected',
  }))
  assert.deepEqual(auditSummary(items), { longTerm: 400, temporary: 600, needed: 400, unneeded: 600, uncertain: 0 })
  const counts = tabCounts(items)
  assert.equal(counts.all, 1000)
  assert.equal(counts.audit, 1000)
  assert.equal(counts.basic, 1000)
  assert.equal(counts.human, 0)
  assert.equal(counts.debate, 0)
  assert.equal(counts.model, 0)
})

test('超长文本：buildTimeline 原文透传、matchesFilter 不截断（防隐式截断）', () => {
  // logic.ts 没有截断函数；这里锁定「纯函数不改写文本」这条契约，防止未来加入长度限制改变输出。
  const long = `${'长'.repeat(10000)}尾部标记`
  const submitted = buildTimeline(item({ content: long }))[0].text
  assert.equal(submitted, long)
  assert.equal(submitted.length, long.length)
  // 防回归：若未来截断，尾部关键词会搜不到；这里断言长文本末端的词仍可命中。
  assert.equal(matchesFilter(item({ content: long }), 'all', '尾部标记'), true)
  // 超长错误特征同样不能截断或改写。
  const signature = 'E'.repeat(5000)
  assert.equal(buildTimeline(item({ errorSignature: signature }))[0].text, `错误：${signature}`)
})

// ---------------------------------------------------------------------------
// 已知缺陷见证（F1–F5）
// 已修复（2026-10-24，见 reports/flywheel-client-logic-findings.md）：
// F1/F2/F3 已改实现，下面三条断言锁定的是修复后的契约；F4/F5 仍按当前实际输出见证。
// ---------------------------------------------------------------------------

test('已修复 F1：仅 debateRounds 时时间轴也承认进入过辩论，与气泡一致', () => {
  const rounds = [
    { role: 'child', content: '我已补依赖' },
    { role: 'mother', content: '仍缺回滚方案' },
  ]
  const onlyRounds = item({ status: 'approved', debateRounds: rounds })
  assert.equal(hasDebateRecord(onlyRounds), true)
  assert.deepEqual(buildDebateBubbles(onlyRounds), rounds)
  // 修复后：② 标注缺失原因，③ 指向逐轮记录，不再声称「未进入辩论」。
  const nodes = buildTimeline(onlyRounds)
  assert.equal(nodes[1].text, '驳回理由未记录')
  assert.equal(nodes[2].text, '本轮反驳未单独记录，以下为辩论摘要：\n（逐轮记录见下方辩论对话）')
})

test('已修复 F2：空 debateRounds 数组不再被当成有记录', () => {
  const emptyRounds = item({ debateRounds: [] })
  // 修复后：记录判定与气泡结论同源，均为「没有辩论」。
  assert.equal(hasDebateRecord(emptyRounds), false)
  assert.deepEqual(buildDebateBubbles(emptyRounds), [])
})

test('已修复 F3：normalizeMemoryStatus 返回值也 trim', () => {
  // 修复后：带空白的合法状态被归一化，状态标签可正确识别。
  assert.equal(normalizeMemoryStatus(' approved '), 'approved')
  assert.equal(memoryStatusLabel(normalizeMemoryStatus(' approved ')), '已生效')
})

test('已知缺陷 F4：空字符串 errorSignature 遮蔽 content 的瞬态检测', () => {
  const base = { status: 'approved', content: 'EPERM exit code 1', resolution: '清理临时文件' }
  // 正确行为（不应改动）：缺少 errorSignature 字段时，content 参与瞬态检测。
  assert.equal(auditItem(item(base)).necessity, 'unneeded')
  // 当前缺陷输出：errorSignature 为空串时 `??` 不回退到 content，导致同一条内容被判为长期知识。
  const emptySignature = auditItem(item({ ...base, errorSignature: '' }))
  assert.equal(emptySignature.durability, 'long-term')
  assert.equal(emptySignature.necessity, 'needed')
})

test('已知缺陷 F5：日历越界日期被归一化成另一天，未走非法时间兜底', () => {
  // 当前缺陷输出：6 月 31 日显示成 7 月 1 日；修复后应原样返回输入（或不伪造日期）。
  assert.equal(formatMemoryTime('2026-06-31T00:00:00'), '2026-07-01 00:00')
})

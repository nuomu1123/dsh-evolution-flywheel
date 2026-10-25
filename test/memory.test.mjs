import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleMemoryApi } from '../lib/memory/api.js'
import { findDuplicateInsertIds, scanProfileConflicts } from '../lib/memory/conflict-scanner.js'
import { MemoryEventHub } from '../lib/memory/events.js'
import { extractMemoryCandidate } from '../lib/memory/extract.js'
import { registerMemoryExtraction } from '../lib/memory/extraction.js'
import { registerMemoryRecall } from '../lib/memory/recall.js'
import { buildSkillCandidate, FixedWindowSkillDebouncer, registerSkillExtraction } from '../lib/memory/skill-extractor.js'
import { MemoryStore } from '../lib/memory/store.js'
import {
  memoryApproveTool,
  memoryDeleteTool,
  memoryListTool,
  memoryUpdateResolutionTool,
  memoryRememberTool,
  memoryProbeTool,
} from '../lib/memory/tools.js'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-evolution-flywheel-'))
  try {
    await fn(new MemoryStore(dir), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function createResponse() {
  let status = 0
  let body = ''
  return {
    headersSent: false,
    writeHead(value) {
      status = value
      this.headersSent = true
    },
    end(chunk) {
      body += chunk ?? ''
    },
    get status() {
      return status
    },
    get body() {
      return body
    },
  }
}

function getRequest(url) {
  return { method: 'GET', url, headers: {} }
}

function postRequest(url, value, contentType = 'application/json') {
  return {
    method: 'POST',
    url,
    headers: { 'content-type': contentType },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(value))
    },
  }
}

test('memory_list 首次读取会写入种子数据', async () => {
  await withStore(async (store) => {
    const items = await store.list()
    assert.equal(items.length, 4)
    assert.ok(items.every(item => typeof item.id === 'string' && item.content.length > 0))
    assert.ok(items.every(item => item.status === 'approved'))
    assert.ok(items.some(item => item.type === 'fact'))
    assert.ok(items.some(item => item.type === 'preference'))
  })
})

test('appendSuggested 写入 suggested 且同内容不重复', async () => {
  await withStore(async (store) => {
    const first = await store.appendSuggested('记住，你是我的朋友', 'preference')
    assert.ok(first)
    assert.equal(first.status, 'suggested')
    const second = await store.appendSuggested('记住，你是我的朋友', 'preference')
    assert.equal(second, undefined)
    assert.equal((await store.list()).length, 5)
  })
})

test('approve 把 suggested 改为 approved 并持久化', async () => {
  await withStore(async (store, dir) => {
    const draft = await store.appendSuggested('以后请使用 pnpm', 'preference')
    assert.ok(draft)
    const approved = await store.approve(draft.id)
    assert.ok(approved)
    assert.equal(approved.status, 'approved')
    const reopened = new MemoryStore(dir)
    const items = await reopened.list()
    assert.equal(items.find(item => item.id === draft.id)?.status, 'approved')
  })
})

test('memory_delete 删除后会持久化，重新打开不再出现', async () => {
  await withStore(async (store, dir) => {
    const before = await store.list()
    const target = before[0]
    assert.ok(target)
    assert.equal(await store.delete(target.id), true)

    const reopened = new MemoryStore(dir)
    const after = await reopened.list()
    assert.equal(after.length, before.length - 1)
    assert.ok(after.every(item => item.id !== target.id))
  })
})

test('memory_delete 对未知 id 返回 false', async () => {
  await withStore(async (store) => {
    assert.equal(await store.delete('missing-id'), false)
  })
})

test('memory 工具共用同一存储并返回预期结构', async () => {
  await withStore(async (store) => {
    const listTool = memoryListTool(store)
    const deleteTool = memoryDeleteTool(store)
    const list = await listTool.execute({}, {})
    assert.equal(Array.isArray(list), true)
    assert.equal(list.length, 4)
    assert.ok(list.every(item => item.status === 'approved'))
    assert.equal(listTool.output.schema.items.additionalProperties, true)

    const target = list[0]
    assert.ok(target)
    const deleted = await deleteTool.execute({ id: target.id }, {})
    assert.deepEqual(deleted, { ok: true, id: target.id, deleted: true })
    assert.equal((await store.list()).length, 3)
  })
})

test('approve 只接受待确认状态，不能绕过人类裁决', async () => {
  await withStore(async (store) => {
    const human = await store.appendSuggested('等待人类裁决的记录', 'fact')
    assert.ok(human)
    await store.update(human.id, { status: 'human_intervention' })
    assert.equal(await store.approve(human.id), undefined)
    assert.equal((await store.list()).find(item => item.id === human.id)?.status, 'human_intervention')

    const staged = await store.appendSuggested('普通草稿', 'fact')
    assert.ok(staged)
    const approved = await store.approve(staged.id)
    assert.equal(approved?.status, 'approved')
  })
})

test('memory_approve 与 memory_update_resolution 工具', async () => {
  await withStore(async (store) => {
    const draft = await store.appendSuggested('需要审核的排错经验', 'skill_error_fix')
    assert.ok(draft)
    const updateTool = memoryUpdateResolutionTool(store)
    const approveTool = memoryApproveTool(store)

    const updated = await updateTool.execute({ id: draft.id, resolution: '检查路径是否存在，修正后重试' }, {})
    assert.equal(updated.ok, true)
    assert.equal(updated.item.resolution, '检查路径是否存在，修正后重试')

    const approved = await approveTool.execute({ id: draft.id }, {})
    assert.equal(approved.ok, true)
    assert.equal(approved.item.status, 'approved')
    assert.equal(approved.item.resolution, '检查路径是否存在，修正后重试')
  })
})

test('HTTP API 支持 list、resolution、approve 与 delete', async () => {
  await withStore(async (store) => {
    const events = new MemoryEventHub()
    const listRes = createResponse()
    await handleMemoryApi(getRequest('/memory-explorer/api/list'), listRes, store, events)
    assert.equal(listRes.status, 200)
    const listed = JSON.parse(listRes.body)
    assert.equal(listed.ok, true)
    assert.equal(listed.items.length, 4)

    const draft = await store.appendSuggested('记住，测试草稿', 'fact')
    assert.ok(draft)
    const resolutionRes = createResponse()
    await handleMemoryApi(
      postRequest('/memory-explorer/api/resolution', { id: draft.id, resolution: '先检查路径' }),
      resolutionRes,
      store,
      events,
    )
    assert.equal(resolutionRes.status, 200)
    assert.equal(JSON.parse(resolutionRes.body).item.resolution, '先检查路径')

    const approveRes = createResponse()
    await handleMemoryApi(postRequest('/memory-explorer/api/approve', { id: draft.id }), approveRes, store, events)
    assert.equal(approveRes.status, 200)
    assert.equal(JSON.parse(approveRes.body).item.status, 'approved')

    const deleteRes = createResponse()
    await handleMemoryApi(postRequest('/memory-explorer/api/delete', { id: draft.id }), deleteRes, store, events)
    assert.equal(deleteRes.status, 200)
    assert.equal(JSON.parse(deleteRes.body).deleted, true)
    assert.equal((await store.list()).some(item => item.id === draft.id), false)
  })
})

test('跨进程锁：两个 MemoryStore 实例并发写不丢数据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-'))
  const storeA = new MemoryStore(dir)
  const storeB = new MemoryStore(dir)
  try {
    await storeA.list()
    await Promise.all([
      storeA.appendSuggested('实例 A 的记忆', 'fact'),
      storeB.appendSuggested('实例 B 的记忆', 'fact'),
    ])
    const items = await storeA.list()
    assert.ok(items.some(item => item.content === '实例 A 的记忆'))
    assert.ok(items.some(item => item.content === '实例 B 的记忆'))
    assert.equal(items.filter(item => item.id.startsWith('seed-')).length, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('共享世界模型：写入即广播，scope 默认 global', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shared-world-'))
  const events = []
  const store = new MemoryStore(dir, event => events.push(event))
  try {
    const created = await store.appendSuggested('共享事实：母子看到同一个现实', 'fact')
    assert.ok(created)
    assert.equal(created.scope, 'global')
    assert.equal(events[0]?.type, 'memory:added')
    assert.equal(events[0]?.item.id, created.id)

    const approved = await store.approve(created.id)
    assert.equal(approved?.status, 'approved')
    assert.equal(events[1]?.type, 'memory:updated')
    assert.equal(events[1]?.item.status, 'approved')

    await store.delete(created.id)
    assert.equal(events[2]?.type, 'memory:removed')
    assert.equal(events[2]?.id, created.id)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('共享世界模型：子 Agent 写入的经验，母 Agent 立即能读到', async () => {
  await withStore(async (store) => {
    const captured = await store.captureSkillError({
      errorSignature: 'Error: 子 Agent 的局部探索',
      context: '离线漫游任务',
      resolution: '共享给母 Agent 的解决办法',
      fingerprint: 'fp-shared-world',
    })
    assert.ok(captured)
    const visible = (await store.list()).find(item => item.id === captured.item.id)
    assert.equal(visible?.resolution, '共享给母 Agent 的解决办法')
  })
})

test('HTTP API /reject 把策略置为 rejected 且保留记录', async () => {
  await withStore(async (store) => {
    const events = new MemoryEventHub()
    const strategy = await store.appendSuggested('先抽象后映射', 'extraction_strategy')
    assert.ok(strategy)
    const res = createResponse()
    await handleMemoryApi(
      postRequest('/memory-explorer/api/reject', { id: strategy.id }),
      res,
      store,
      events,
    )
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).item.status, 'rejected')
    const after = (await store.list()).find(item => item.id === strategy.id)
    assert.equal(after?.status, 'rejected')
    assert.equal(after?.content, '先抽象后映射')
  })
})

test('整理报告 API：生成、否决强制理由、批准后状态生效', async () => {
  await withStore(async (store) => {
    const events = new MemoryEventHub()

    const runRes = createResponse()
    await handleMemoryApi(postRequest('/memory-explorer/api/curation/run', {}), runRes, store, events)
    assert.equal(runRes.status, 200)
    const runBody = JSON.parse(runRes.body)
    assert.equal(runBody.ok, true)
    assert.equal(runBody.report.type, 'curation_report')
    assert.ok(runBody.payload.total >= 4)
    const reportId = runBody.report.id

    const shortRes = createResponse()
    await handleMemoryApi(
      postRequest('/memory-explorer/api/curation/decision', { id: reportId, decision: 'reject', reason: '太短' }),
      shortRes,
      store,
      events,
    )
    assert.equal(shortRes.status, 400)

    const rejectRes = createResponse()
    await handleMemoryApi(
      postRequest('/memory-explorer/api/curation/decision', {
        id: reportId,
        decision: 'reject',
        reason: '这份报告把仍有用的记忆误判为褪色，暂不采纳',
      }),
      rejectRes,
      store,
      events,
    )
    assert.equal(rejectRes.status, 200)
    assert.equal(JSON.parse(rejectRes.body).report.status, 'rejected')
    assert.ok((await store.list()).some(item =>
      item.type === 'fact' && item.content.includes('[整理否决]')))

    const extra = await store.appendSuggested('新增记忆改变报告摘要', 'fact')
    assert.ok(extra)
    const runRes2 = createResponse()
    await handleMemoryApi(postRequest('/memory-explorer/api/curation/run', {}), runRes2, store, events)
    assert.equal(runRes2.status, 200)
    const reportId2 = JSON.parse(runRes2.body).report.id
    const approveRes = createResponse()
    await handleMemoryApi(
      postRequest('/memory-explorer/api/curation/decision', { id: reportId2, decision: 'approve' }),
      approveRes,
      store,
      events,
    )
    assert.equal(approveRes.status, 200)
    assert.equal(JSON.parse(approveRes.body).report.status, 'approved')
  })
})

test('HTTP API 支持 human-decision 采纳与丢弃', async () => {
  await withStore(async (store) => {
    const events = new MemoryEventHub()
    const captured = await store.captureSkillError({
      errorSignature: 'ModuleNotFoundError: No module named requests',
      context: '工具 bash 执行失败',
      resolution: '安装 requests',
      fingerprint: 'fp-human-api',
    })
    assert.ok(captured)
    await store.update(captured.item.id, {
      status: 'human_intervention',
      metaInsight: '需要人类判断',
      debateSummary: '双方未收敛',
    })

    const engine = {
      async humanDecide(id, decision) {
        return store.update(id, {
          status: decision === 'adopt' ? 'approved' : 'rejected',
          humanDecision: decision,
        })
      },
    }

    const adoptRes = createResponse()
    await handleMemoryApi(
      postRequest('/memory-explorer/api/human-decision', { id: captured.item.id, decision: 'adopt' }),
      adoptRes,
      store,
      events,
      engine,
    )
    assert.equal(adoptRes.status, 200)
    const adopted = JSON.parse(adoptRes.body)
    assert.equal(adopted.item.status, 'approved')
    assert.equal(adopted.item.humanDecision, 'adopt')
  })
})

test('HTTP API 拒绝非 JSON 请求', async () => {
  await withStore(async (store) => {
    const events = new MemoryEventHub()
    const res = createResponse()
    await handleMemoryApi(postRequest('/memory-explorer/api/delete', { id: 'seed-1' }, 'text/plain'), res, store, events)
    assert.equal(res.status, 415)
  })
})

test('关键词规则识别长期价值句子', () => {
  const candidate = extractMemoryCandidate('记住，你是我的朋友')
  assert.deepEqual(candidate, { content: '记住，你是我的朋友', type: 'preference' })
  assert.equal(extractMemoryCandidate('今天天气不错'), undefined)
  assert.equal(extractMemoryCandidate('   '), undefined)
})

test('session/event 用户消息写入草稿并广播 memory:added', async () => {
  await withStore(async (store) => {
    let handler
    const ctx = {
      effect(callback) {
        return callback()
      },
      on(_event, listener) {
        handler = listener
        return () => {}
      },
    }
    const published = []
    const events = { publish: event => published.push(event) }
    registerMemoryExtraction(ctx, store, events)
    assert.equal(typeof handler, 'function')

    handler({}, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记住，你是我的朋友' }] },
    })
    await new Promise(resolve => setTimeout(resolve, 30))

    const items = await store.list()
    const draft = items.find(item => item.content === '记住，你是我的朋友')
    assert.ok(draft)
    assert.equal(draft.status, 'suggested')
    assert.equal(published.length, 1)
    assert.equal(published[0].type, 'memory:added')
    assert.equal(published[0].item.id, draft.id)
  })
})

test('SSE 事件总线广播 added/updated/removed', () => {
  const chunks = []
  const res = {
    writeHead() {},
    write(chunk) {
      chunks.push(String(chunk))
    },
    end() {},
    on() {},
  }
  const hub = new MemoryEventHub()
  hub.subscribe(res)
  hub.publish({ type: 'memory:added', item: { id: '1', content: 'x', type: 'fact', status: 'suggested', createdAt: new Date().toISOString() } })
  hub.publish({ type: 'memory:removed', id: '1' })
  hub.close()
  const text = chunks.join('')
  assert.match(text, /memory:added/)
  assert.match(text, /memory:removed/)
})

test('buildSkillCandidate 生成稳定签名与 fingerprint', () => {
  const first = buildSkillCandidate({
    error: { name: 'ModuleNotFoundError', message: 'No module named requests' },
    context: '工具 bash 执行失败',
  })
  const second = buildSkillCandidate({
    error: { name: 'ModuleNotFoundError', message: 'No module named requests' },
    context: '另一个任务',
  })
  assert.equal(first.errorSignature, 'ModuleNotFoundError: No module named requests')
  assert.equal(first.fingerprint, second.fingerprint)
})

test('5 分钟防抖在进程内生效', () => {
  const debouncer = new FixedWindowSkillDebouncer(5 * 60 * 1000)
  const at = 1_000_000
  assert.equal(debouncer.allow('fp', at), true)
  assert.equal(debouncer.allow('fp', at + 60_000), false)
  assert.equal(debouncer.allow('fp', at + 5 * 60 * 1000 + 1), true)
})

test('captureSkillError 持久化 5 分钟去重，approve 后保留结构化字段', async () => {
  await withStore(async (store, dir) => {
    const candidate = {
      errorSignature: 'ModuleNotFoundError: No module named requests',
      context: '工具 bash 执行失败',
      resolution: '请先安装 requests',
      fingerprint: 'fp-skill-1',
    }
    const first = await store.captureSkillError(candidate)
    assert.ok(first)
    assert.equal(first.created, true)
    assert.equal(first.item.status, 'staged')
    assert.equal(first.item.type, 'skill_error_fix')
    assert.equal(first.item.resolution, '请先安装 requests')

    const second = await store.captureSkillError(candidate)
    assert.equal(second, undefined)

    const approved = await store.approve(first.item.id)
    assert.equal(approved?.status, 'approved')
    const reopened = new MemoryStore(dir)
    const items = await reopened.list()
    const saved = items.find(item => item.id === first.item.id)
    assert.ok(saved)
    assert.equal(saved.status, 'approved')
    assert.equal(saved.fingerprint, candidate.fingerprint)
  })
})

test('只读扫描插入列表中的重复 loader entry id', async () => {
  const text = [
    '- insert:',
    '    - id: duplicate-entry',
    '      name: one',
    '    - id: duplicate-entry',
    '      name: two',
    '- id: legitimate-override',
    '  name: other',
    '',
  ].join('\n')
  assert.deepEqual(findDuplicateInsertIds(text), ['duplicate-entry'])

  await withStore(async (_store, dir) => {
    await writeFile(join(dir, 'cordis.patch.yml'), text, 'utf8')
    const result = await scanProfileConflicts(dir)
    assert.equal(result.checked, true)
    assert.deepEqual(result.duplicates, ['duplicate-entry'])
  })
})

test('tool/result 错误写入 staged skill 并广播 memory:added', async () => {
  await withStore(async (store) => {
    const handlers = {}
    const ctx = {
      effect(callback) {
        return callback()
      },
      on(event, listener) {
        handlers[event] = listener
        return () => {}
      },
    }
    const published = []
    const events = { publish: event => published.push(event) }
    registerSkillExtraction(ctx, store, events)
    assert.equal(typeof handlers['session/event'], 'function')
    assert.equal(typeof handlers['agent/error'], 'function')

    handlers['session/event']({ id: 'session-1' }, {
      type: 'tool/call',
      data: { callId: 'call-1', name: 'bash', arguments: '{"command":"python app.py"}' },
    })
    handlers['session/event']({ id: 'session-1' }, {
      type: 'tool/result',
      data: {
        message: {
          toolCallId: 'call-1',
          isError: true,
          content: [{ type: 'text', text: 'ModuleNotFoundError: No module named requests' }],
        },
        error: { name: 'ModuleNotFoundError', reason: 'No module named requests' },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 40))

    const items = await store.list()
    const skill = items.find(item => item.type === 'skill_error_fix')
    assert.ok(skill)
    assert.equal(skill.status, 'staged')
    assert.match(skill.content, /ModuleNotFoundError/)
    assert.equal(published.length, 1)
    assert.equal(published[0].type, 'memory:added')
  })
})

test('tool/result 通过 stderr 内容也能提炼有意义的签名', async () => {
  await withStore(async (store) => {
    const handlers = {}
    const ctx = {
      effect(callback) {
        return callback()
      },
      on(event, listener) {
        handlers[event] = listener
        return () => {}
      },
    }
    registerSkillExtraction(ctx, store, { publish() {} })
    handlers['session/event']({ id: 'session-2' }, {
      type: 'tool/call',
      data: { callId: 'call-2', name: 'pwsh', arguments: '{"command":"Get-Item missing"}' },
    })
    handlers['session/event']({ id: 'session-2' }, {
      type: 'tool/result',
      data: {
        message: {
          toolCallId: 'call-2',
          isError: false,
          content: [{
            type: 'text',
            text: '[stderr]\nGet-Item : Cannot find path C:\\missing because it does not exist.\n[exit code: 1]',
          }],
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 40))

    const skill = (await store.list()).find(item => item.type === 'skill_error_fix')
    assert.ok(skill)
    assert.match(skill.content, /Cannot find path/)
    assert.doesNotMatch(skill.content, /^错误：ToolError: \[stderr\]/)
  })
})

test('错误捕获调用轻量 LLM 生成 staged 解决方案草稿', async () => {
  await withStore(async (store) => {
    const handlers = {}
    const llm = {
      listProviders: () => [{ id: 'mock' }],
      listModels: async () => [{ id: 'mock-model' }],
      async *stream() {
        yield { type: 'text-delta', index: 0, text: '检查路径是否存在，修正路径后重试。' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const ctx = {
      effect(callback) {
        return callback()
      },
      on(event, listener) {
        handlers[event] = listener
        return () => {}
      },
      get(name) {
        return name === 'llm' ? llm : undefined
      },
    }
    registerSkillExtraction(ctx, store, { publish() {} })
    handlers['session/event']({ id: 'session-llm' }, {
      type: 'tool/call',
      data: { callId: 'call-llm', name: 'pwsh', arguments: '{"command":"Get-Item missing"}' },
    })
    handlers['session/event']({ id: 'session-llm' }, {
      type: 'tool/result',
      data: {
        message: {
          toolCallId: 'call-llm',
          isError: true,
          content: [{ type: 'text', text: 'Cannot find path C:\\missing' }],
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 80))

    const skill = (await store.list()).find(item => item.type === 'skill_error_fix')
    assert.ok(skill)
    assert.equal(skill.status, 'staged')
    assert.equal(skill.resolution, '检查路径是否存在，修正路径后重试。')
  })
})

test('agent/pre-step 命中 approved skill 时注入解决办法', async () => {
  await withStore(async (store) => {
    const captured = await store.captureSkillError({
      errorSignature: 'ModuleNotFoundError: No module named requests',
      context: '工具 bash 执行失败',
      resolution: '请先运行 pip install requests',
      fingerprint: 'fp-recall-1',
    })
    assert.ok(captured)
    await store.approve(captured.item.id)

    let handler
    const ctx = {
      effect(callback) {
        return callback()
      },
      on(event, listener) {
        if (event === 'agent/pre-step') handler = listener
        return () => {}
      },
    }
    registerMemoryRecall(ctx, store)
    assert.equal(typeof handler, 'function')

    const user = {
      id: 'user-1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '又遇到 ModuleNotFoundError: No module named requests，怎么办？' }],
    }
    const decision = await handler(
      { agent: {}, messages: [user], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 2)
    assert.match(decision.messages[1].content[0].text, /pip install requests/)
  })
})

test('有 systemPrompt 时召回写入系统上下文而不是 user 消息', async () => {
  await withStore(async (store) => {
    const captured = await store.captureSkillError({
      errorSignature: 'ModuleNotFoundError: No module named requests',
      context: '工具 bash 执行失败',
      resolution: '请先运行 pip install requests',
      fingerprint: 'fp-system-recall',
    })
    assert.ok(captured)
    await store.approve(captured.item.id)

    let handler
    const definitions = new Map()
    const ctx = {
      effect(callback) {
        return callback()
      },
      on(event, listener) {
        if (event === 'agent/pre-step') handler = listener
        return () => {}
      },
      systemPrompt: {
        context(value) {
          definitions.set(value.name, value)
          return () => {}
        },
      },
    }
    registerMemoryRecall(ctx, store)
    assert.equal(typeof handler, 'function')
    const skillDefinition = definitions.get('memory:skill-recall')
    assert.ok(skillDefinition)

    const agent = {}
    const user = {
      id: 'user-system',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'ModuleNotFoundError: No module named requests' }],
    }
    const decision = await handler(
      { agent, messages: [user], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 1)
    const systemText = skillDefinition.text({ agent })
    // 文案契约变更（P0-2）：默认 resolution 是模型推测，措辞必须如实说明。
    assert.match(systemText, /以下为模型推测的解法，尚未验证，仅供参考/)
    assert.match(systemText, /pip install requests/)
  })
})

test('systemPrompt 自动注入已确认的偏好与事实摘要', async () => {
  await withStore(async (store) => {
    const preference = await store.appendSuggested('你是我的朋友', 'preference')
    assert.ok(preference)
    await store.approve(preference.id)
    const fact = await store.appendSuggested('项目根目录是 D:\\workspace\\demo', 'fact')
    assert.ok(fact)
    await store.approve(fact.id)

    let handler
    const definitions = new Map()
    const ctx = {
      effect(callback) {
        return callback()
      },
      on(event, listener) {
        if (event === 'agent/pre-step') handler = listener
        return () => {}
      },
      systemPrompt: {
        context(value) {
          definitions.set(value.name, value)
          return () => {}
        },
      },
    }
    registerMemoryRecall(ctx, store)
    assert.equal(typeof handler, 'function')
    const digest = definitions.get('memory:digest')
    assert.ok(digest)
    assert.equal(digest.interpolate, false)

    const agent = {}
    const user = {
      id: 'user-digest',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '随便聊聊' }],
    }
    await handler(
      { agent, messages: [user], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    const text = digest.text({ agent })
    assert.match(text, /已确认的长期记忆/u)
    assert.match(text, /你是我的朋友/u)
    assert.match(text, /项目根目录是 D:\\workspace\\demo/u)
  })
})

test('mental_model 可持久化并保留反例', async () => {
  await withStore(async (store, dir) => {
    const created = await store.appendSuggested('反馈回路', 'mental_model')
    assert.ok(created)
    const updated = await store.update(created.id, {
      metaInsight: '输出回灌输入',
      counterexample: '不要把一切都说成反馈回路',
    })
    assert.equal(updated?.type, 'mental_model')
    assert.equal(updated?.counterexample, '不要把一切都说成反馈回路')
    const reopened = new MemoryStore(dir)
    const found = (await reopened.list()).find(item => item.id === created.id)
    assert.equal(found?.counterexample, '不要把一切都说成反馈回路')
  })
})

test('记忆可持久化来源与提炼过程', async () => {
  await withStore(async (store, dir) => {
    const created = await store.appendSuggested('来源测试', 'fact')
    assert.ok(created)
    const updated = await store.update(created.id, {
      origin: 'dma',
      originDetail: '生物学',
      trace: ['学科：生物学', '来源：example.org'],
    })
    assert.equal(updated?.origin, 'dma')
    const reopened = new MemoryStore(dir)
    const found = (await reopened.list()).find(item => item.id === created.id)
    assert.equal(found?.originDetail, '生物学')
    assert.deepEqual(found?.trace, ['学科：生物学', '来源：example.org'])
  })
})

// ---------------------------------------------------------------------------
// resolution 附着边界（2026-10-24 实测污染后补）：
// 一条长汇报只因含「修复」二字就被写进最近失败记忆的 resolution，面板变成汇报正文。
// ---------------------------------------------------------------------------

function createSkillHarness(store) {
  const handlers = {}
  const ctx = {
    effect(callback) {
      return callback()
    },
    on(event, listener) {
      handlers[event] = listener
      return () => {}
    },
  }
  registerSkillExtraction(ctx, store, { publish() {} })
  return handlers
}

async function seedFailure(handlers, session, callId, text) {
  handlers['session/event']({ id: session }, {
    type: 'tool/call',
    data: { callId, name: 'bash', arguments: '{"command":"npm test"}' },
  })
  handlers['session/event']({ id: session }, {
    type: 'tool/result',
    data: {
      message: {
        toolCallId: callId,
        isError: true,
        content: [{ type: 'text', text }],
      },
    },
  })
  // capture 是异步写库，等它落盘后再发 assistant/message。
  await new Promise(resolve => setTimeout(resolve, 50))
}

test('长篇汇报不会被写进错误记忆的 resolution', async () => {
  await withStore(async (store) => {
    const handlers = createSkillHarness(store)
    await seedFailure(handlers, 'session-report', 'call-r', 'Error: build failed')

    const report = [
      '已修复：构建失败。',
      '',
      '## 一、改动',
      'x'.repeat(400),
      '## 二、验证',
      'y'.repeat(400),
    ].join('\n')
    handlers['session/event']({ id: 'session-report' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: report }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    const skill = (await store.list()).find(item => item.type === 'skill_error_fix')
    assert.ok(skill)
    assert.equal(skill.resolution, undefined, '长篇汇报不应成为 resolution')
  })
})

test('简短的排错说明仍会写进 resolution', async () => {
  await withStore(async (store) => {
    const handlers = createSkillHarness(store)
    await seedFailure(handlers, 'session-short', 'call-s', 'Error: build failed')

    handlers['session/event']({ id: 'session-short' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '已修复：先执行 npm ci 再重跑即可。' }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    const skill = (await store.list()).find(item => item.type === 'skill_error_fix')
    assert.ok(skill)
    assert.match(skill.resolution ?? '', /npm ci/)
  })
})

// ---------------------------------------------------------------------------
// 跨插件兼容（2026-10-24 审计）：DSH 自带的 compaction-tool-result-pruner
// 在上下文压缩时会 append 一个剪枝后的 tool/result，内容带固定标记。
// 它不是新失败，飞轮必须跳过，否则同一错误会被记成截断版第二条。
// ---------------------------------------------------------------------------

test('压缩剪枝后的 tool/result 不会被当成新错误重复记录', async () => {
  await withStore(async (store) => {
    const handlers = createSkillHarness(store)
    await seedFailure(handlers, 'session-prune', 'call-p', 'Error: original failure')

    const before = (await store.list()).filter(item => item.type === 'skill_error_fix').length
    assert.equal(before, 1)

    // 模拟 pruner 的替换事件：仍是 isError，但内容被截断并插入 PRUNE_MARKER。
    handlers['session/event']({ id: 'session-prune' }, {
      type: 'tool/result',
      data: {
        message: {
          toolCallId: 'call-p',
          isError: true,
          content: [{
            type: 'text',
            text: 'Error: original\n\n[... tool result middle pruned ...]\n\ntail only',
          }],
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    const after = (await store.list()).filter(item => item.type === 'skill_error_fix').length
    assert.equal(after, before, '剪枝替换不应新增错误记录')
  })
})

// 批量重试的筛选口径（2026-10-25 真实使用反馈后补）。
// 只重试「因模型容量/瞬时故障卡住」的记录；真正需要人判断的收敛失败不碰。
test('批量重试只挑因模型故障卡住的 human_intervention 记录', async () => {
  const { isStuckReview } = await import('../lib/memory/api.js')
  assert.equal(isStuckReview({
    status: 'human_intervention',
    debateSummary: '辩论失败：审阅模型连接中断，已安全停止：模型把 maxTokens=900 全用在思考上（思考 3191 字，结束原因 max-tokens），未输出正文',
  }), true)
  assert.equal(isStuckReview({ status: 'human_intervention', debateSummary: '初审失败：LLM 未返回 JSON' }), true)
  // 辩论输出了 JSON 但格式不完整：同样属于模型故障，可重试
  assert.equal(isStuckReview({ status: 'human_intervention', debateSummary: "辩论失败：Expected ',' or ']' after array element in JSON at position 42" }), true)
  // 真正需要人判断的收敛失败：不应被批量重试碰
  assert.equal(isStuckReview({ status: 'human_intervention', debateSummary: '双方无法收敛，需要人类判断风险' }), false)
  // 非终态 / 无摘要
  assert.equal(isStuckReview({ status: 'approved', debateSummary: 'max-tokens' }), false)
  assert.equal(isStuckReview({ status: 'human_intervention' }), false)
})

// 审阅模型空正文的可诊断性（2026-10-25：25 条记录因「LLM 未返回 JSON」卡死，
// 根因是空正文被静默返回、最终在 JSON 解析处报了一个无法定位的错误）。
function fakeLlmCtx(chunks) {
  return {
    get(name) {
      if (name !== 'llm') return undefined
      return {
        async listProviders() { return [{ id: 'p1' }] },
        async listModels() { return [{ id: 'm1' }] },
        async *stream() { for (const chunk of chunks) yield chunk },
      }
    },
  }
}

test('模型返回空正文时抛出可诊断错误，而不是静默走到 JSON 解析失败', async () => {
  const { complete } = await import('../lib/memory/review-driver.js')
  await assert.rejects(
    () => complete(fakeLlmCtx([{ type: 'finish', reason: { kind: 'max-tokens' } }]), 'sys', 'prompt'),
    /未输出正文/,
  )
})

test('空正文但有 reasoning 时明确指出是思考吃光额度', async () => {
  const { complete } = await import('../lib/memory/review-driver.js')
  await assert.rejects(
    () => complete(fakeLlmCtx([
      { type: 'reasoning-delta', text: '思考'.repeat(80) },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]), 'sys', 'prompt'),
    /全用在思考上/,
  )
})

// memory_search 的类型过滤与相关性排序（2026-10-25 真实使用反馈后补）：
// 旧实现按文件顺序返回、无类型过滤，搜「插件」有用率只有 1/10。
test('memory_search 支持类型过滤，并按命中质量排序', async () => {
  await withStore(async (store) => {
    // 正文命中：高质量
    const fact = await store.appendSuggested('插件启动失败的排查经验', 'fact')
    // 只有上下文命中：低质量
    const meta = await store.appendSuggested('某个元认知结论', 'meta_insight')
    await store.update(meta.id, { context: '插件启动失败的排查经验' })
    await store.appendSuggested('完全无关的内容', 'fact')

    const all = await store.search('插件', 10)
    assert.ok(all.length >= 2)
    assert.equal(all[0].id, fact.id, '正文命中应排在只有上下文命中的前面')
    assert.ok(!all.some(item => item.content.includes('无关')))

    const onlyMeta = await store.search('插件', 10, { type: 'meta_insight' })
    assert.equal(onlyMeta.length, 1)
    assert.equal(onlyMeta[0].id, meta.id)

    const onlyFact = await store.search('插件', 10, { type: 'fact' })
    assert.ok(onlyFact.length >= 1)
    assert.ok(onlyFact.every(item => item.type === 'fact'))
    assert.ok(onlyFact.some(item => item.id === fact.id))
  })
})

test('memory_search 默认排除已归档记录', async () => {
  await withStore(async (store) => {
    const item = await store.appendSuggested('归档标记测试样例', 'fact')
    assert.ok(item)
    await store.update(item.id, { archived: true })
    assert.equal((await store.search('归档标记测试样例', 10)).length, 0)
    assert.equal((await store.search('归档标记测试样例', 10, { includeArchived: true })).length, 1)
  })
})

// 主动沉淀工具（2026-10-25 真实使用反馈的 P1-3）：错误捕获只覆盖工具失败，
// 「禁用插件必须重启」这类平台行为知识必须能手动写进记忆。
test('memory_remember 能沉淀结论，默认 suggested、可标记已验证、自动去重', async () => {
  await withStore(async (store) => {
    const tool = memoryRememberTool(store)
    const out = await tool.execute({
      content: '禁用带客户端半的插件后必须重启 DSH，刷新页面无效',
      context: '实测：composer-pro 禁用后刷新仍加载旧客户端模块图',
    })
    assert.equal(out.ok, true)
    assert.equal(out.item.type, 'fact')
    assert.equal(out.item.status, 'suggested')
    assert.equal(out.item.origin, 'manual')
    assert.match(out.item.context ?? '', /刷新仍加载旧客户端模块图/)

    // 完全相同的内容不重复写入
    const again = await tool.execute({ content: '禁用带客户端半的插件后必须重启 DSH，刷新页面无效' })
    assert.equal(again.ok, false)
    assert.equal(again.reason, 'duplicate')

    // 已验证的结论可以直接 approved
    const verified = await tool.execute({ content: '另一条已验证的结论', approved: true })
    assert.equal(verified.ok, true)
    assert.equal(verified.item.status, 'approved')

    // 写进去的能被搜到
    const found = await store.search('刷新页面无效', 5)
    assert.ok(found.some(item => item.content.includes('必须重启')))
  })
})

// resolution 来源标记（2026-10-25 反馈 P0-2）：把「模型推测」和「已验证解法」分开，
// 否则 recall 会把猜测标成「请优先参考」。
test('错误捕获的 resolution 默认 inferred，探针验证后变 verified', async () => {
  await withStore(async (store) => {
    const result = await store.captureSkillError({
      errorSignature: 'E: source-test',
      context: '工具 bash 执行失败',
      resolution: '先安装依赖再重试',
      fingerprint: 'fp-source-1',
    })
    assert.ok(result)
    assert.equal(result.item.resolutionSource, 'inferred')

    const probe = memoryProbeTool(store)
    const out = await probe.execute({
      id: result.item.id,
      hypothesis: '安装依赖后能否通过',
      evidence: '复现后确认通过',
      verified: true,
    })
    assert.equal(out.item.resolutionSource, 'verified')
  })
})

test('memory_update_resolution 默认 inferred，verified=true 时标 verified', async () => {
  await withStore(async (store) => {
    const created = await store.appendSuggested('错误：样例错误', 'skill_error_fix')
    assert.ok(created)
    const tool = memoryUpdateResolutionTool(store)

    const inferred = await tool.execute({ id: created.id, resolution: '试试重启服务' })
    assert.equal(inferred.item.resolutionSource, 'inferred')

    const verified = await tool.execute({ id: created.id, resolution: '重启后确认有效', verified: true })
    assert.equal(verified.item.resolutionSource, 'verified')
  })
})

// 探针原因兜底（2026-10-25 反馈 P2）：模型常输出空的【原因】，
// 旧逻辑 `?? 默认值` 对「匹配到空串」不生效，界面上就是空白。
test('整理探针的原因字段为空时会兜底为可读说明', async () => {
  const { parseCurationProbe } = await import('../lib/memory/curator.js')
  const probe = parseCurationProbe('【想问】这 4 条报错是否同源？\n【原因】')
  assert.ok(probe)
  assert.equal(probe.question, '这 4 条报错是否同源？')
  assert.ok(probe.reason.length > 0, '原因不应为空')
  assert.match(probe.reason, /整理记忆时产生的疑问/)
})

test('createProbe 对空原因给出可读说明，不留空白', async () => {
  await withStore(async (store) => {
    const { createProbe } = await import('../lib/memory/probes.js')
    const item = await createProbe(store, { question: '为什么会有这条记忆？', reason: '', source: 'test' })
    assert.ok(item)
    assert.equal(item.type, 'cognitive_probe')
    assert.ok((item.probeReason ?? '').length > 0, 'probeReason 不应为空')
    assert.match(item.probeReason ?? '', /未提供原因/)
  })
})

// 整理报告下钻（2026-10-25 反馈 P2）：只给「待裁决 N 条」没有可操作性，
// 必须拆成「待确认 / 待审阅 / 等圣裁（模型故障 vs 真需判断）」。
test('整理报告把待裁决拆成可行动的分布', async () => {
  const { buildCurationReport } = await import('../lib/memory/curator.js')
  const now = Date.now()
  const iso = new Date(now).toISOString()
  const items = [
    { id: 'a', content: '一条待确认的事实', type: 'fact', status: 'suggested', createdAt: iso },
    { id: 'b', content: '错误：X', type: 'skill_error_fix', status: 'human_intervention', createdAt: iso, debateSummary: '初审失败：LLM 未返回 JSON' },
    { id: 'c', content: '错误：Y', type: 'skill_error_fix', status: 'human_intervention', createdAt: iso, debateSummary: '证据不足，转人工补证' },
  ]
  const report = buildCurationReport(items, now, 'manual')
  const text = report.risks.join(' ')
  assert.match(text, /待确认 1 条/)
  assert.match(text, /等待人类圣裁|条等待人类圣裁/)
  assert.match(text, /模型故障遗留/)
  assert.match(text, /需要你亲自判断/)
})

// 相似错误聚类（2026-10-25 反馈 P1-1）：同一种错误、不同文件路径要能归到一组。
test('相似错误聚类：同一种错误的不同文件路径会归到一组', async () => {
  const { normalizeErrorSignature, similarErrorGroups } = await import('../lib/memory/curator.js')

  const one = 'ToolError: Error: ReplaceFileW EIO (Win32 1175): D:\\a\\b.mjs'
  const two = 'ToolError: Error: ReplaceFileW EIO (Win32 1175): D:\\c\\d.mjs'
  assert.match(normalizeErrorSignature(one), /<path>/)
  assert.equal(normalizeErrorSignature(one), normalizeErrorSignature(two), '路径与数字应被归一化')

  const now = new Date().toISOString()
  const items = [
    { id: 'a', content: 'x', type: 'skill_error_fix', status: 'approved', createdAt: now, errorSignature: one },
    { id: 'b', content: 'y', type: 'skill_error_fix', status: 'approved', createdAt: now, errorSignature: two },
    { id: 'c', content: 'z', type: 'fact', status: 'approved', createdAt: now },
    { id: 'd', content: 'w', type: 'skill_error_fix', status: 'approved', createdAt: now, errorSignature: '另一类完全不同的错误' },
  ]
  const groups = similarErrorGroups(items)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].ids.sort(), ['a', 'b'])
  assert.ok(groups[0].signature.includes('<path>'))
})

test('相似错误聚类会跳过「只剩占位符」的过泛签名', async () => {
  const { similarErrorGroups } = await import('../lib/memory/curator.js')
  const now = new Date().toISOString()
  const items = [
    { id: 'a', content: 'x', type: 'skill_error_fix', status: 'approved', createdAt: now, errorSignature: 'ToolError: "abc": 1,' },
    { id: 'b', content: 'y', type: 'skill_error_fix', status: 'approved', createdAt: now, errorSignature: 'ToolError: "def": 2,' },
  ]
  // 归一化后只剩 `ToolError: <str>: <n>,`，信息量不足，不应聚类
  assert.equal(similarErrorGroups(items).length, 0)
})

// 自诊断（2026-10-25 反馈收官）：让插件能回答「我现在健康吗」，
// 而不是等使用者翻源码才发现问题。
test('自诊断能算出模型故障、待裁决分布与建议动作', async () => {
  const { buildSelfDiagnosis } = await import('../lib/memory/diagnosis.js')
  const now = new Date().toISOString()
  const items = [
    { id: 'a', content: 'x', type: 'fact', status: 'suggested', createdAt: now },
    { id: 'b', content: 'y', type: 'skill_error_fix', status: 'human_intervention', createdAt: now, debateSummary: '初审失败：LLM 未返回 JSON' },
    { id: 'c', content: 'z', type: 'skill_error_fix', status: 'human_intervention', createdAt: now, debateSummary: '证据不足，转人工' },
    { id: 'd', content: 'w', type: 'skill_error_fix', status: 'human_intervention', createdAt: now, debateSummary: '模型把 maxTokens=500 全用在思考上（结束原因 max-tokens）' },
    { id: 'e', content: 'v', type: 'skill_error_fix', status: 'approved', createdAt: now, archived: true },
  ]
  const d = buildSelfDiagnosis(items)
  assert.equal(d.totals.all, 5)
  assert.equal(d.totals.active, 4, '归档记录不计入 active')
  assert.equal(d.pending.awaitingConfirm, 1)
  assert.equal(d.pending.needsHuman, 3)
  assert.equal(d.pending.modelFailure, 2)
  assert.equal(d.pending.realJudgement, 1)
  assert.equal(d.llmFailures.byKind['JSON 解析失败'], 1)
  assert.equal(d.llmFailures.byKind['reasoning 吃光 token'], 1)
  assert.ok(d.suggestions.some(s => s.includes('批量重试')))
  assert.ok(d.suggestions.some(s => s.includes('亲自判断')))
})

test('自诊断在没有问题时给出正常结论，而不是空数组', async () => {
  const { buildSelfDiagnosis } = await import('../lib/memory/diagnosis.js')
  const d = buildSelfDiagnosis([])
  assert.equal(d.totals.all, 0)
  assert.equal(d.suggestions.length, 1)
  assert.match(d.suggestions[0], /没有需要处理的问题/)
})

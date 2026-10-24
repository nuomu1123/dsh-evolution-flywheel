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
    assert.match(systemText, /系统检测到相似错误，历史解决方案如下，请优先参考/)
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

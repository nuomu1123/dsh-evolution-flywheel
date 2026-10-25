/**
 * 浏览器观察器的回归护栏（2026-10-24，P1 能力打通）。
 *
 * 契约：
 * - 只读浏览器工具不进记忆（噪音）；
 * - 普通副作用（点一个普通链接）不进记忆（噪音）；
 * - 不可逆动作（提交/发送/上传/执行代码/确认框）必须进记忆，带页面 URL；
 * - 失败不进记忆（交给 skill-extractor 统一捕获，避免双写）；
 * - 同一动作 5 分钟内不重复写（防抖）；
 * - ctx.on 缺失时静默跳过，不影响插件启动。
 *
 * 对应报告：reports/flywheel-verify-fixes.md 与 P1 数据流打通说明。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerBrowserObserver } from '../lib/memory/browser-observer.js'

function createHarness() {
  const handlers = []
  const created = []
  const updates = []
  const published = []
  const ctx = {
    effect(callback) {
      const dispose = callback()
      return dispose
    },
    on(_event, listener) {
      handlers.push(listener)
      return () => {}
    },
  }
  const store = {
    async appendSuggested(content, type) {
      if (created.some(item => item.content === content)) return undefined
      const record = { id: `mem-${created.length + 1}`, content, type, status: 'suggested' }
      created.push(record)
      return record
    },
    async update(id, patch) {
      const record = created.find(item => item.id === id)
      if (record === undefined) return undefined
      updates.push({ id, patch })
      Object.assign(record, patch)
      return record
    },
  }
  const events = {
    publish(event) {
      published.push(event)
    },
  }
  registerBrowserObserver(ctx, store, events)
  return {
    handlers,
    calls: {
      emit(session, event) {
        for (const handler of handlers) handler(session, event)
      },
    },
    created,
    updates,
    published,
  }
}

const BROWSER = 'mcp__playwright-mcp__'

test('navigate 之后点击「提交」：写入不可逆动作记忆，带页面 URL', async () => {
  const harness = createHarness()
  const session = { id: 's1' }

  harness.calls.emit(session, {
    type: 'tool/call',
    data: { callId: 'c1', name: `${BROWSER}browser_navigate`, arguments: JSON.stringify({ url: 'https://shop.example.com/checkout' }) },
  })
  harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } })

  harness.calls.emit(session, {
    type: 'tool/call',
    data: { callId: 'c2', name: `${BROWSER}browser_click`, arguments: JSON.stringify({ element: '提交订单按钮' }) },
  })
  harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: 'c2', isError: false } } })

  // record 是异步的，等一个微任务批次。
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(harness.created.length, 1, '只读导航不该写记忆，只有不可逆点击写一条')
  const content = harness.created[0].content
  assert.equal(harness.created[0].type, 'fact')
  assert.ok(content.includes('[浏览器审计]'), content)
  assert.ok(content.includes('不可逆动作'), content)
  assert.ok(content.includes('browser_click'), content)
  assert.ok(content.includes('https://shop.example.com/checkout'), content)
  assert.equal(harness.updates.length, 1)
  assert.equal(harness.updates[0].patch.origin, 'browser-observer')
  assert.equal(harness.updates[0].patch.originDetail, '浏览器副作用动作')
  assert.equal(harness.published.length, 1)
})

test('只读工具（snapshot/find/take_screenshot）一律不进记忆', async () => {
  const harness = createHarness()
  const session = { id: 's1' }
  for (const [index, tool] of ['browser_snapshot', 'browser_find', 'browser_take_screenshot'].entries()) {
    const callId = `r${index}`
    harness.calls.emit(session, { type: 'tool/call', data: { callId, name: `${BROWSER}${tool}`, arguments: '{}' } })
    harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: callId, isError: false } } })
  }
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(harness.created.length, 0)
})

test('普通点击（无不可逆词）不进记忆', async () => {
  const harness = createHarness()
  const session = { id: 's1' }
  harness.calls.emit(session, {
    type: 'tool/call',
    data: { callId: 'c1', name: `${BROWSER}browser_click`, arguments: JSON.stringify({ element: '查看更多' }) },
  })
  harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(harness.created.length, 0)
})

test('执行任意代码（run_code_unsafe）无条件留痕', async () => {
  const harness = createHarness()
  const session = { id: 's1' }
  harness.calls.emit(session, {
    type: 'tool/call',
    data: { callId: 'c1', name: `${BROWSER}browser_run_code_unsafe`, arguments: JSON.stringify({ code: 'await page.click("#buy")' }) },
  })
  harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(harness.created.length, 1)
  assert.ok(harness.created[0].content.includes('browser_run_code_unsafe'))
})

test('失败的动作不进记忆（交给 skill-extractor，避免双写）', async () => {
  const harness = createHarness()
  const session = { id: 's1' }
  harness.calls.emit(session, {
    type: 'tool/call',
    data: { callId: 'c1', name: `${BROWSER}browser_click`, arguments: JSON.stringify({ element: '提交' }) },
  })
  harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: true } } })
  harness.calls.emit(session, {
    type: 'tool/call',
    data: { callId: 'c2', name: `${BROWSER}browser_click`, arguments: JSON.stringify({ element: '发送' }) },
  })
  harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: 'c2', isError: false }, error: { name: 'ToolError' } } })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(harness.created.length, 0)
})

test('同一动作 5 分钟内防抖，只写一次', async () => {
  const harness = createHarness()
  const session = { id: 's1' }
  for (let index = 0; index < 3; index++) {
    const callId = `c${index}`
    harness.calls.emit(session, {
      type: 'tool/call',
      data: { callId, name: `${BROWSER}browser_click`, arguments: JSON.stringify({ element: '确认支付' }) },
    })
    harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: callId, isError: false } } })
  }
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(harness.created.length, 1)
})

test('没有导航过时页面标记为未记录', async () => {
  const harness = createHarness()
  const session = { id: 's1' }
  harness.calls.emit(session, {
    type: 'tool/call',
    data: { callId: 'c1', name: `${BROWSER}browser_file_upload`, arguments: JSON.stringify({ paths: ['C:/tmp/a.png'] }) },
  })
  harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(harness.created.length, 1)
  assert.ok(harness.created[0].content.includes('未记录'))
})

test('ctx.on 缺失时静默跳过，不抛错', () => {
  assert.doesNotThrow(() => {
    registerBrowserObserver({ effect: () => () => {} }, {}, { publish() {} })
  })
})

// ---------------------------------------------------------------------------
// 隐私边界（2026-10-24 补）：凭据绝不落盘
// ---------------------------------------------------------------------------

test('页面 URL 的 token 不落盘：query/hash 一律丢弃', async () => {
  const harness = createHarness()
  const session = { id: 's1' }
  harness.calls.emit(session, {
    type: 'tool/call',
    data: {
      callId: 'c1',
      name: `${BROWSER}browser_navigate`,
      arguments: JSON.stringify({ url: 'https://app.example.com/pay?token=secret-abc&user=1#x' }),
    },
  })
  harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } })
  harness.calls.emit(session, {
    type: 'tool/call',
    data: { callId: 'c2', name: `${BROWSER}browser_click`, arguments: JSON.stringify({ element: '确认支付' }) },
  })
  harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: 'c2', isError: false } } })
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(harness.created.length, 1)
  const content = harness.created[0].content
  assert.ok(!content.includes('secret-abc'), content)
  assert.ok(content.includes('https://app.example.com/pay'), content)
})

test('密码框的输入内容被打码，元素定位信息保留', async () => {
  const harness = createHarness()
  const session = { id: 's1' }
  harness.calls.emit(session, {
    type: 'tool/call',
    data: {
      callId: 'c1',
      name: `${BROWSER}browser_type`,
      // 元素同时含「密码」（触发打码）与「提交」（触发留痕）
      arguments: JSON.stringify({ element: '密码输入框并提交', text: 'hunter2' }),
    },
  })
  harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } })
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(harness.created.length, 1)
  const content = harness.created[0].content
  assert.ok(!content.includes('hunter2'), content)
  assert.ok(content.includes('密码输入框'), content)
  assert.ok(content.includes('text=***'), content)
})

test('run_code_unsafe 的代码进入摘要（高风险动作必须有证据）', async () => {
  const harness = createHarness()
  const session = { id: 's1' }
  harness.calls.emit(session, {
    type: 'tool/call',
    data: {
      callId: 'c1',
      name: `${BROWSER}browser_run_code_unsafe`,
      arguments: JSON.stringify({ code: 'await page.click("#pay")' }),
    },
  })
  harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } })
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(harness.created.length, 1)
  assert.ok(harness.created[0].content.includes('code='), harness.created[0].content)
  assert.ok(harness.created[0].content.includes('#pay'), harness.created[0].content)
})

test('browser_evaluate 只在代码带副作用时留痕（调试读 DOM 零噪音）', async () => {
  const harness = createHarness()
  const session = { id: 's1' }
  // 1) 纯读取：不应记录
  harness.calls.emit(session, {
    type: 'tool/call',
    data: { callId: 'c1', name: `${BROWSER}browser_evaluate`, arguments: JSON.stringify({ function: '() => document.title' }) },
  })
  harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } })
  // 2) 带 fetch：应记录
  harness.calls.emit(session, {
    type: 'tool/call',
    data: {
      callId: 'c2',
      name: `${BROWSER}browser_evaluate`,
      arguments: JSON.stringify({ function: '() => fetch("/api/delete", { method: "POST" })' }),
    },
  })
  harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: 'c2', isError: false } } })
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(harness.created.length, 1, '只有带 fetch 的 evaluate 应被记录')
  // 注意：browser_evaluate 的参数键是 function，不在摘要白名单里，
  // 因此命中的是兜底原文（已脱敏）。断言记录存在即可。
})

test('审计记录直接 approved，不污染「待裁决」', async () => {
  const harness = createHarness()
  const session = { id: 's1' }
  harness.calls.emit(session, {
    type: 'tool/call',
    data: { callId: 'c1', name: `${BROWSER}browser_click`, arguments: JSON.stringify({ element: '提交订单' }) },
  })
  harness.calls.emit(session, { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } })
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(harness.updates.length, 1)
  assert.equal(harness.updates[0].patch.status, 'approved')
  // 假 store 的 update 会合并 patch，最终记录应为 approved。
  assert.equal(harness.created[0].status, 'approved')
})

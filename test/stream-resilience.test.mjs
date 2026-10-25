/**
 * 事件流韧性：SSE 心跳帧、断连看门狗、状态文案与静默对账合并。
 *
 * 背景（2026-10-25 架构师要求）：前端曾把断连当成红色错误块，连接假活时界面静默停止更新。
 * 这里把"帧语义 / 何时重建 / 快照与帧如何合并 / 死连接如何摘除"焊死，防止回退。
 *
 * 注意：fakeRes 模拟的是"同步抛错"与"destroyed 标记"两条死链路径；
 * 真实 Node 中向已销毁 socket write 通常**返回 false 而不抛错**，所以 events.ts 先查
 * destroyed/writableEnded，再由 close 事件兜底——两条路径这里都有用例。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { MemoryEventHub } from '../lib/memory/events.js'
import {
  classifyStreamFrame,
  describeStreamLink,
  mergeSnapshotWithFrames,
  shouldReconnectStream,
  STREAM_STALE_MS,
  STREAM_WATCHDOG_MS,
} from '../src/client/logic.ts'

/** 最小 ServerResponse 替身：只实现事件总线用到的成员。 */
function fakeRes(options = {}) {
  const writes = []
  const res = {
    writes,
    writeAttempts: 0,
    status: 0,
    headers: undefined,
    ended: false,
    closeHandler: undefined,
    destroyed: options.destroyed ?? false,
    writableEnded: false,
    socket: { setNoDelay() {} },
    failAfter: options.failAfter ?? Number.POSITIVE_INFINITY,
    keepWritableAfterEnd: options.keepWritableAfterEnd === true,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    write(chunk) {
      // 先计数：即使这次写抛错，也说明"有没有再尝试写"。
      this.writeAttempts += 1
      if (writes.length >= this.failAfter) throw new Error('EPIPE')
      writes.push(String(chunk))
      return true
    },
    end() {
      this.ended = true
      if (!this.keepWritableAfterEnd) this.writableEnded = true
    },
    on(event, handler) {
      if (event === 'close') this.closeHandler = handler
    },
  }
  return res
}

const framesOf = res => res.writes.map(chunk => chunk.trim()).filter(chunk => chunk !== '')

const memoryItem = (id, content = id) => ({
  id,
  content,
  type: 'fact',
  status: 'approved',
  createdAt: '2026-10-25T00:00:00.000Z',
})

test('订阅后立刻收到心跳帧：前端不必等一个周期才知道链路是活的', () => {
  const hub = new MemoryEventHub(60_000)
  try {
    const res = fakeRes()
    hub.subscribe(res)
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /text\/event-stream/u)
    assert.equal(framesOf(res)[0], ': connected')
    const ping = framesOf(res).find(frame => frame.startsWith('data: '))
    assert.ok(ping !== undefined, '必须立即发一帧心跳')
    const payload = JSON.parse(ping.slice('data: '.length))
    assert.equal(payload.type, 'ping')
    assert.equal(typeof payload.at, 'string')
  } finally {
    hub.close()
  }
})

test('心跳按固定间隔持续发送，且能被 classifyStreamFrame 识别为 ping', async () => {
  const hub = new MemoryEventHub(10)
  try {
    const res = fakeRes()
    hub.subscribe(res)
    // 200ms / 10ms = 20 倍余量，避免 CI 抖动。
    await new Promise(resolve => setTimeout(resolve, 200))
    const pings = framesOf(res).filter(frame => frame.startsWith('data: '))
    assert.ok(pings.length >= 2, `200ms 内至少 2 帧心跳，实际 ${pings.length}`)
    for (const frame of pings) {
      assert.equal(classifyStreamFrame(frame.slice('data: '.length)).kind, 'ping')
    }
  } finally {
    hub.close()
  }
})

test('首帧写失败：连接被摘除、不再尝试写、连接被 end', () => {
  const hub = new MemoryEventHub(60_000)
  try {
    const alive = fakeRes()
    // keepWritableAfterEnd：证明"之后不再写"是摘除生效，而不是被 writableEnded 挡住。
    const dead = fakeRes({ failAfter: 0, keepWritableAfterEnd: true })
    hub.subscribe(alive)
    hub.subscribe(dead)
    assert.equal(dead.writeAttempts, 1, '首帧只应尝试一次')
    assert.equal(dead.ended, true, '首帧失败必须 end 连接')
    assert.equal(hub.clients.size, 1, '死连接必须从集合里摘掉')

    hub.publish({ type: 'memory:removed', id: 'mem-1' })
    assert.equal(dead.writeAttempts, 1, '已摘除的连接不应再被写')
    const eventFrame = framesOf(alive).find(frame => frame.includes('memory:removed'))
    assert.ok(eventFrame !== undefined)
    const parsed = classifyStreamFrame(eventFrame.slice('data: '.length))
    assert.equal(parsed.kind, 'event')
    assert.equal(parsed.payload.type, 'memory:removed')
  } finally {
    hub.close()
  }
})

test('真实死链：destroyed 的响应在下一帧被摘除（Node 写已销毁 socket 不抛错）', () => {
  const hub = new MemoryEventHub(60_000)
  try {
    const res = fakeRes()
    hub.subscribe(res)
    // 订阅成功会写两帧：`: connected` 与首帧心跳。
    const before = res.writeAttempts
    assert.equal(before, 2)
    res.destroyed = true
    hub.publish({ type: 'memory:removed', id: 'x' })
    assert.equal(res.writeAttempts, before, '发现 destroyed 后不应再调用 write')
    assert.equal(hub.clients.size, 0, 'destroyed 连接必须被摘除')
  } finally {
    hub.close()
  }
})

test('hub 关闭后拒绝新订阅：不会留下永不心跳也不会被关闭的连接', () => {
  const hub = new MemoryEventHub(60_000)
  hub.close()
  const res = fakeRes()
  hub.subscribe(res)
  assert.equal(res.status, 503)
  assert.equal(res.ended, true)
  assert.equal(hub.clients.size, 0)
})

test('close 会结束连接并停止心跳定时器', async () => {
  const hub = new MemoryEventHub(10)
  const res = fakeRes()
  hub.subscribe(res)
  await new Promise(resolve => setTimeout(resolve, 30))
  hub.close()
  assert.equal(res.ended, true)
  const frozen = res.writes.length
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(res.writes.length, frozen, 'close 之后不应再有心跳写入')
})

test('帧语义：坏帧丢弃但不断流，数组/标量都不算业务事件', () => {
  assert.deepEqual(classifyStreamFrame(''), { kind: 'invalid' })
  assert.deepEqual(classifyStreamFrame('not-json'), { kind: 'invalid' })
  assert.deepEqual(classifyStreamFrame('[1,2]'), { kind: 'invalid' })
  assert.deepEqual(classifyStreamFrame('123'), { kind: 'invalid' })
  assert.deepEqual(classifyStreamFrame('{"type":"ping","at":"2026-10-25T00:00:00Z"}'), { kind: 'ping' })
  const frame = classifyStreamFrame('{"type":"memory:added","item":{"id":"a"}}')
  assert.equal(frame.kind, 'event')
  assert.equal(frame.payload.type, 'memory:added')
})

test('看门狗：超过阈值才重建；时间戳坏掉按"该重建"处理，回拨不抖动', () => {
  const now = 1_000_000
  assert.equal(STREAM_STALE_MS > STREAM_WATCHDOG_MS, true, '阈值必须大于检查间隔，否则每轮都重建')
  assert.equal(shouldReconnectStream(now - 1_000, now), false)
  assert.equal(shouldReconnectStream(now - STREAM_STALE_MS, now), false, '刚好等于阈值不算超时')
  assert.equal(shouldReconnectStream(now - STREAM_STALE_MS - 1, now), true)
  // NaN 说明计时已坏：必须重建，不能静默失效。
  assert.equal(shouldReconnectStream(Number.NaN, now), true)
  assert.equal(shouldReconnectStream(now, Number.NaN), true)
  // NTP 回拨让 lastFrameAt 跑到未来：无法判断，保守不重建。
  assert.equal(shouldReconnectStream(now + 60_000, now), false)
})

test('连接状态文案：只有断连才提示，首连不闪黄条', () => {
  assert.equal(describeStreamLink('live'), '')
  assert.equal(describeStreamLink('connecting'), '')
  for (const state of ['reconnecting', 'offline']) {
    const text = describeStreamLink(state)
    assert.ok(text.length > 0, `${state} 必须有文案`)
    assert.match(text, /事件流/u)
  }
  assert.match(describeStreamLink('reconnecting'), /自动重连/u)
  assert.match(describeStreamLink('offline'), /重新连接/u)
})

test('静默对账：快照之后新增的条目不会被整表覆盖吞掉', () => {
  const merged = mergeSnapshotWithFrames(
    [memoryItem('a')],
    new Map([['b', { at: 200, item: memoryItem('b') }]]),
    100,
  )
  assert.deepEqual(merged.map(item => item.id), ['b', 'a'])
})

test('静默对账：快照之后删除的条目不会复活', () => {
  const merged = mergeSnapshotWithFrames(
    [memoryItem('a'), memoryItem('b')],
    new Map([['a', { at: 200, removed: true }]]),
    100,
  )
  assert.deepEqual(merged.map(item => item.id), ['b'])
})

test('静默对账：窗口之前收到的帧不参与合并（以快照为准）', () => {
  const merged = mergeSnapshotWithFrames(
    [memoryItem('a', '快照内容')],
    new Map([['a', { at: 50, item: memoryItem('a', '更旧内容') }]]),
    100,
  )
  assert.deepEqual(merged.map(item => item.content), ['快照内容'])
})

test('静默对账：快照之后更新的内容以帧为准', () => {
  const merged = mergeSnapshotWithFrames(
    [memoryItem('a', '旧')],
    new Map([['a', { at: 200, item: memoryItem('a', '新') }]]),
    100,
  )
  assert.equal(merged[0].content, '新')
})

/**
 * 记忆能力装配：一个 MemoryStore 同时供 Host 工具、Web API、SSE、
 * 错误感知、冲突自检与召回监听器使用。
 */
import { registerMemoryApi, type MemoryApiContext } from './api.js'
import { registerConflictScanner, type ConflictScannerContext } from './conflict-scanner.js'
import { createHostDmaExplorer, DmaRunner, registerDmaSchedule } from './dma.js'
import { createToolEvidenceSearch } from './evidence-search.js'
import { MemoryEventHub } from './events.js'
import { registerMemoryExtraction, type MemoryExtractionContext } from './extraction.js'
import { registerMemoryRecall, type MemoryRecallContext } from './recall.js'
import { createLlmReviewDriver } from './review-driver.js'
import { createStrategyHooks } from './strategy.js'
import { registerSkillExtraction, type SkillExtractionContext } from './skill-extractor.js'
import { SkillReviewEngine } from './state-machine.js'
import { registerMemoryTools, type MemoryToolContext } from './tools.js'
import { MemoryStore } from './store.js'

export interface MemoryHostContext
  extends MemoryToolContext,
  MemoryApiContext,
  MemoryExtractionContext,
  SkillExtractionContext,
  MemoryRecallContext,
  ConflictScannerContext {}

export { MemoryEventHub }
export { MemoryStore }
export type { MemoryRecord, MemoryStatus, MemoryType } from './store.js'

/** 注册工具、HTTP API、SSE、提取、错误感知、冲突自检与召回。 */
export function registerMemoryFeatures(ctx: MemoryHostContext): void {
  const events = new MemoryEventHub()
  // 共享世界模型：任何写入都立即广播，母子 Agent 与 Web 面板共享同一现实。
  const store = new MemoryStore(undefined, event => events.publish(event))
  const strategyHooks = createStrategyHooks(ctx, store)
  const reviewEngine = new SkillReviewEngine(
    store,
    events,
    createLlmReviewDriver(ctx),
    createToolEvidenceSearch(ctx),
    strategyHooks,
  )
  const dmaRunner = new DmaRunner(store, events, createHostDmaExplorer(ctx))
  registerDmaSchedule(ctx, dmaRunner)
  registerMemoryTools(ctx, store)
  registerMemoryApi(ctx, store, events, reviewEngine, dmaRunner)
  registerMemoryExtraction(ctx, store, events)
  registerSkillExtraction(ctx, store, events, record => {
    void reviewEngine.review(record.id)
  })
  registerConflictScanner(ctx, store, events)
  registerMemoryRecall(ctx, store)
}

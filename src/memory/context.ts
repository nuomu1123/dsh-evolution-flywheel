/**
 * 记忆模块共用的最小 Cordis 事件上下文。
 *
 * 这里故意只声明宽泛的 `on(event, listener)`：不同子系统监听不同事件，
 * 具体 payload 由各模块自己的结构类型在回调参数上收窄。
 */
export interface MemoryContextBase {
  effect(callback: () => () => void): unknown
  on(event: string, listener: (...args: any[]) => unknown): () => void
  get?(name: string): unknown
}

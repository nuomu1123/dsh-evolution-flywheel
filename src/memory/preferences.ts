/**
 * 记忆模块对外暴露的最小只读接口。
 *
 * 第一版不实现真实存储：`getPreference` 恒返回 `undefined`。clarify 只能
 * import 本模块，本模块不得反向 import clarify（单向依赖）。
 *
 * 后续接入真实记忆时，只需在这里读取已存储的偏好；调用方不需要改签名。
 */
export function getPreference(key: string): string | undefined {
  void key
  return undefined
}

/**
 * 只读冲突自检：扫描当前 profile 的 cordis.patch.yml，
 * 检查 insert 列表内是否存在重复的 loader entry id。
 *
 * 不修改任何 patch 文件；发现冲突时只生成一条 suggested 记忆。
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MemoryEventHub } from './events.js'
import type { MemoryStore } from './store.js'

export interface ConflictScanResult {
  checked: boolean
  file?: string
  duplicates: string[]
  error?: string
}

export interface ConflictScannerContext {
  effect(callback: () => () => void): unknown
}

/** 从 YAML 文本中提取 insert 列表内的重复 id；忽略注释与普通 override。 */
export function findDuplicateInsertIds(text: string): string[] {
  const counts = new Map<string, number>()
  let inInsert = false
  let insertIndent = 0

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/u, '')
    if (line.trim() === '') continue
    const indent = line.match(/^\s*/u)?.[0].length ?? 0

    if (/^\s*-\s*insert:\s*$/u.test(line) || /^\s*insert:\s*$/u.test(line)) {
      inInsert = true
      insertIndent = indent
      continue
    }

    if (!inInsert) continue
    if (indent <= insertIndent) {
      inInsert = false
      continue
    }

    const match = /^\s*-\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/u.exec(line)
    if (match?.[1] !== undefined) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort()
}

function defaultProfileDir(): string {
  const explicit = process.env.DSH_PROFILE_DIR?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'profiles', process.env.DSH_PROFILE?.trim() || 'web')
}

/** 只读扫描 profile patch；文件不存在或解析失败时返回 checked:false。 */
export async function scanProfileConflicts(profileDir: string = defaultProfileDir()): Promise<ConflictScanResult> {
  const file = join(profileDir, 'cordis.patch.yml')
  try {
    const text = await readFile(file, 'utf8')
    return { checked: true, file, duplicates: findDuplicateInsertIds(text) }
  } catch (error) {
    return {
      checked: false,
      file,
      duplicates: [],
      error: error instanceof Error ? error.message : 'unknown error',
    }
  }
}

/** 插件加载时执行一次只读扫描；结果作为 suggested 记忆广播到前端。 */
export function registerConflictScanner(
  ctx: ConflictScannerContext,
  store: MemoryStore,
  events: MemoryEventHub,
): void {
  try {
    ctx.effect(() => {
      let cancelled = false
      void scanProfileConflicts()
        .then(async result => {
          if (cancelled || !result.checked || result.duplicates.length === 0) return
          const summary = `检测到 profile 中重复的 loader entry：${result.duplicates.join('、')}。请检查 cordis.patch.yml；当前仅为只读提醒，未修改任何文件。`
          const item = await store.appendSuggested(summary, 'conflict')
          if (item !== undefined) events.publish({ type: 'memory:added', item })
        })
        .catch(error => {
          console.error('[dsh-memory-minimal] conflict scan failed:', error)
        })
      return () => {
        cancelled = true
      }
    })
  } catch (error) {
    console.error('[dsh-memory-minimal] conflict scanner registration failed:', error)
  }
}

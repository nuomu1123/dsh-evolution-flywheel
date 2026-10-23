/**
 * 审计日志：追加到 JSONL，供安全事件与人类操作追溯。
 *
 * 默认路径：`$DSH_HOME/storages/dsh-memory-minimal/audit.jsonl`。
 * 可用 `DSH_MEMORY_AUDIT_DIR` 覆盖目录，`DSH_MEMORY_AUDIT=off` 关闭写入，
 * `DSH_MEMORY_AUDIT_MAX_BYTES` 调整轮转阈值（默认 1 MiB）。
 * 超过阈值时把当前文件轮转为 `audit.jsonl.1`，只保留一代历史。
 * 所有失败只写 stderr，不影响主流程。
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { PLUGIN_ID } from './constants.js'

export interface AuditEntry {
  ts: string
  plugin: string
  event: string
  payload: Record<string, unknown>
}

const MAX_READ_BYTES = 256 * 1024
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024

function auditFile(): string {
  const configured = process.env.DSH_MEMORY_AUDIT_DIR?.trim()
  const dir = configured !== undefined && configured !== ''
    ? configured
    : join(
      process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'),
      'storages',
      'dsh-memory-minimal',
    )
  return join(dir, 'audit.jsonl')
}

function maxFileBytes(): number {
  const raw = Number(process.env.DSH_MEMORY_AUDIT_MAX_BYTES)
  return Number.isFinite(raw) && raw >= 128 ? Math.trunc(raw) : DEFAULT_MAX_FILE_BYTES
}

/** 文件达到阈值时轮转为 `.1`；只保留一代，避免无限增长。 */
function rotateIfNeeded(file: string): void {
  try {
    if (statSync(file).size < maxFileBytes()) return
    const rotated = `${file}.1`
    rmSync(rotated, { force: true })
    renameSync(file, rotated)
  } catch {
    // 文件不存在或不可读时不轮转，交给 append 创建。
  }
}

/**
 * 追加一条审计事件。
 * @param event 事件名，例如 `security.intercept`、`memory.approve`。
 * @param payload 可序列化的事件负载；不要放正文或密钥。
 */
export function appendAudit(event: string, payload: Record<string, unknown>): void {
  if (process.env.DSH_MEMORY_AUDIT === 'off') return
  try {
    const file = auditFile()
    mkdirSync(dirname(file), { recursive: true })
    rotateIfNeeded(file)
    appendFileSync(
      file,
      `${JSON.stringify({ ts: new Date().toISOString(), plugin: PLUGIN_ID, event, payload })}\n`,
      'utf8',
    )
  } catch (error) {
    console.error(`[${PLUGIN_ID}] audit append failed:`, error)
  }
}

/** 读取单个审计文件（旧到新）；文件过大时只读末尾。 */
function readAuditFile(file: string): AuditEntry[] {
  try {
    const text = readFileSync(file, 'utf8')
    const slice = text.length > MAX_READ_BYTES ? text.slice(-MAX_READ_BYTES) : text
    const entries: AuditEntry[] = []
    for (const line of slice.split('\n')) {
      if (line.trim() === '') continue
      try {
        const value = JSON.parse(line) as Partial<AuditEntry>
        if (typeof value.ts !== 'string' || typeof value.event !== 'string') continue
        entries.push({
          ts: value.ts,
          plugin: typeof value.plugin === 'string' ? value.plugin : PLUGIN_ID,
          event: value.event,
          payload: typeof value.payload === 'object' && value.payload !== null
            ? value.payload as Record<string, unknown>
            : {},
        })
      } catch {
        // 跳过损坏行，避免单行坏数据拖垮审计读取。
      }
    }
    return entries
  } catch {
    return []
  }
}

/**
 * 读取最近的审计事件（新到旧），合并轮转前的 `.1` 与当前文件。
 * @param limit 最多返回条数，内部限制 1-200。
 */
export function readAudit(limit = 50): AuditEntry[] {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 50))
  const file = auditFile()
  const entries = [...readAuditFile(`${file}.1`), ...readAuditFile(file)]
    .sort((left, right) => left.ts.localeCompare(right.ts))
  return entries.slice(-safeLimit).reverse()
}

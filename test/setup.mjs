/** 测试隔离：把审计写入系统临时目录，避免污染真实 DSH_HOME。 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_MEMORY_AUDIT_DIR = mkdtempSync(join(tmpdir(), 'dsh-memory-audit-'))

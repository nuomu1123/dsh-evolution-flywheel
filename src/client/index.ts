/**
 * Client 半：clarify dock + 记忆浏览器（设置页 / 侧边栏 / 主面板）。
 *
 * 行为约束：
 * - clarify 只有用户点击【澄清】才分析当前草稿，不监听输入、不自动打断；
 * - 记忆浏览器由设置页“记忆管理”或侧边栏显式入口打开，数据来自 Host HTTP API；
 * - 删除只调用 Host API，成功后更新本地列表；
 * - 所有注册由 `ctx.effect` 清理，初始化失败只写日志。
 *
 * 本文件是 ESM 源码；`scripts/build-client.mjs` 会把它打包成 DSH Client
 * 需要的 `window.__ModuleLoader__.load` 注册产物（源码不手写 loader 调用）。
 */
import { analyzePrompt } from '../clarify/index.js'
import { undoClarify, writeBackClarify } from '../clarify/actions.js'
import type { ClarifyAnalysis, ClarifyAnswers } from '../clarify/types.js'
import {
  buildDebateBubbles,
  buildTimeline,
  debateVerdictText,
  hasDebateRecord,
  isMetaItem,
  originLabel,
  matchesFilter,
  auditItem,
  auditSummary,
  memoryStatusLabel,
  memoryTypeLabel,
  tabCounts,
  normalizeMemoryStatus,
  type FilterTab,
  type MemoryItem,
} from './logic.js'
import { memorySalience, perceptionLabel } from '../memory/decay.js'

declare const require: (id: string) => any

const React = require('react')
const h = React.createElement

export const inject = ['slots']

const MEMORY_PANEL_ID = 'memory-explorer'
const MEMORY_SETTINGS_ID = 'memory'
const MEMORY_API = '/memory-explorer/api'

interface ClarifyDockProps {
  inputActions: {
    setDraft(text: string): void
  }
  useInput: <T>(selector: (state: { draft: string }) => T) => T
}

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '4px 8px 6px',
    fontSize: '12px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '6px',
  },
  button: {
    border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,.35))',
    background: 'transparent',
    color: 'inherit',
    borderRadius: '6px',
    padding: '2px 8px',
    cursor: 'pointer',
    font: 'inherit',
  },
  chosen: {
    border: '1px solid var(--dsw-alias-border-strong, rgba(64,128,255,.8))',
    background: 'transparent',
    color: 'inherit',
    borderRadius: '6px',
    padding: '2px 8px',
    cursor: 'pointer',
    font: 'inherit',
    fontWeight: 600,
  },
  muted: {
    opacity: 0.72,
  },
  questions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  question: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  prompt: {
    lineHeight: 1.5,
  },
} as const

function ClarifyDock(props: ClarifyDockProps) {
  const draft = props.useInput(state => state.draft)
  const [analysis, setAnalysis] = React.useState(null)
  const [answers, setAnswers] = React.useState({} as ClarifyAnswers)
  const [undo, setUndo] = React.useState(null)
  const [notice, setNotice] = React.useState('')

  const start = () => {
    try {
      if (draft.trim() === '') {
        setAnalysis(null)
        setNotice('请先输入提示词')
        return
      }
      const next: ClarifyAnalysis = analyzePrompt(draft)
      setAnswers({})
      setUndo(null)
      if (!next.needsClarification) {
        setAnalysis(null)
        setNotice('无需澄清')
        return
      }
      setAnalysis(next)
      setNotice('')
    } catch (error) {
      setAnalysis(null)
      setNotice('澄清检测失败，已忽略')
      console.error('[dsh-evolution-flywheel] clarify client analyze failed:', error)
    }
  }

  const choose = (id: string, value: string) => {
    setAnswers((previous: ClarifyAnswers) => ({ ...previous, [id]: value }))
  }

  const stale = analysis !== null && draft.trim() !== analysis.original
  const canApply = analysis !== null
    && !stale
    && analysis.questions.every((question: { id: string }) => answers[question.id] !== undefined)

  const apply = () => {
    if (analysis === null || !canApply) return
    try {
      const result = writeBackClarify(props.inputActions, analysis.original, analysis.questions, answers)
      setUndo({ original: result.original })
      setNotice('已写回输入框（未发送）')
      setAnalysis(null)
    } catch (error) {
      setNotice('写回失败，已忽略')
      console.error('[dsh-evolution-flywheel] clarify client apply failed:', error)
    }
  }

  const revert = () => {
    if (undo === null) return
    try {
      undoClarify(props.inputActions, undo.original)
      setUndo(null)
      setNotice('已撤回')
    } catch (error) {
      setNotice('撤回失败，已忽略')
      console.error('[dsh-evolution-flywheel] clarify client revert failed:', error)
    }
  }

  const bar = [
    h('button', { key: 'start', type: 'button', style: styles.button, onClick: start }, '澄清'),
    undo !== null
      ? h('button', { key: 'undo', type: 'button', style: styles.button, onClick: revert }, '撤回')
      : null,
    notice !== ''
      ? h('span', { key: 'notice', style: styles.muted }, notice)
      : null,
  ]

  return h('div', { style: styles.root }, [
    h('div', { key: 'bar', style: styles.row }, bar),
    analysis !== null
      ? h('div', { key: 'questions', style: styles.questions }, analysis.questions.map((question: {
        id: string
        prompt: string
        options: Array<{ label: string; value: string }>
      }) => h('div', { key: question.id, style: styles.question }, [
        h('div', { key: 'prompt', style: styles.prompt }, question.prompt),
        h('div', { key: 'options', style: styles.row }, question.options.map(option => h('button', {
          key: option.value,
          type: 'button',
          style: answers[question.id] === option.value ? styles.chosen : styles.button,
          onClick: () => choose(question.id, option.value),
        }, option.label))),
      ])))
      : null,
    analysis !== null
      ? h('div', { key: 'preferences', style: styles.muted },
        `偏好建议（本版不写入）：${analysis.suggestedPreferenceKeys.join(', ')}`)
      : null,
    stale
      ? h('div', { key: 'stale', style: styles.muted }, '草稿已变化，请重新点击【澄清】')
      : null,
    canApply
      ? h('button', { key: 'apply', type: 'button', style: styles.button, onClick: apply }, '写回输入框')
      : null,
  ])
}

interface SecurityIntercept {
  id: number
  time: string
  source: string
  pattern: string
  excerpt: string
}

interface AuditEntry {
  ts: string
  plugin: string
  event: string
  payload: Record<string, unknown>
}

interface Billing {
  todayTokens: number
  totalTokens: number
  dmaTodayTokens?: number
  dmaTotalTokens?: number
  reviewTodayTokens?: number
  reviewTotalTokens?: number
  debateTodayTokens?: number
  debateTotalTokens?: number
  dailyBudget?: number
  budgetRemaining?: number
  budgetExceeded?: boolean
  todayRuns: number
  totalRuns: number
  lastRunTokens: number
  tokenLimit: number
  maxTokensPerCall: number
  disciplineBreakdown: Array<{ discipline: string; tokens: number; runs: number }>
  fuseCount: number
  lastFuse?: { time: string; message: string }
  lastError: string
}

const memoryStyles = {
  page: {
    position: 'relative',
    height: '100%',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '24px',
    color: 'var(--dsw-alias-text-base, inherit)',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '12px',
  },
  title: {
    margin: 0,
    fontSize: '20px',
    lineHeight: 1.2,
    fontWeight: 600,
  },
  count: {
    fontSize: '12px',
    opacity: 0.65,
  },
  toolbar: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: '8px 10px',
    border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,.35))',
    borderRadius: '8px',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: '13px',
    outline: 'none',
  },
  button: {
    border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,.35))',
    background: 'transparent',
    color: 'inherit',
    borderRadius: '8px',
    padding: '6px 10px',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '13px',
  },
  list: {
    flex: 1,
    minHeight: 0,
    maxHeight: 'calc(100vh - 240px)',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    paddingRight: '4px',
  },
  card: {
    border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,.35))',
    borderRadius: '10px',
    padding: '12px 14px',
    display: 'flex',
    gap: '12px',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    overflow: 'auto',
    minWidth: '240px',
    minHeight: '96px',
    maxWidth: '100%',
  },
  itemMain: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  content: {
    fontSize: '14px',
    lineHeight: 1.5,
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap',
  },
  strategyBrief: {
    fontSize: '11px',
    lineHeight: 1.6,
    opacity: 0.72,
    padding: '2px 8px',
    border: '1px dashed var(--dsw-alias-border-base, rgba(128,128,128,.28))',
    borderRadius: '6px',
  },
  meta: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    flexWrap: 'wrap',
    fontSize: '12px',
    opacity: 0.7,
  },
  badge: {
    border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,.35))',
    borderRadius: '999px',
    padding: '1px 7px',
    fontSize: '11px',
  },
  statusSuggested: {
    border: '1px solid var(--dsw-alias-border-warning, #b45309)',
    color: 'var(--dsw-alias-text-warning, #b45309)',
    borderRadius: '999px',
    padding: '1px 7px',
    fontSize: '11px',
  },
  statusApproved: {
    border: '1px solid var(--dsw-alias-border-success, #15803d)',
    color: 'var(--dsw-alias-text-success, #15803d)',
    borderRadius: '999px',
    padding: '1px 7px',
    fontSize: '11px',
  },
  statusReview: {
    border: '1px solid #2563eb',
    color: '#1d4ed8',
    borderRadius: '999px',
    padding: '1px 7px',
    fontSize: '11px',
  },
  statusDanger: {
    border: '1px solid #dc2626',
    color: '#b91c1c',
    borderRadius: '999px',
    padding: '1px 7px',
    fontSize: '11px',
    fontWeight: 600,
  },
  statusRejected: {
    border: '1px solid rgba(128,128,128,.45)',
    color: 'inherit',
    opacity: 0.65,
    borderRadius: '999px',
    padding: '1px 7px',
    fontSize: '11px',
  },
  metaInsight: {
    border: '1px solid #a855f7',
    backgroundColor: 'rgba(147, 51, 234, 0.14)',
    borderRadius: '8px',
    padding: '8px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    fontSize: '12px',
    lineHeight: 1.55,
  },
  metaInsightTitle: {
    color: '#7e22ce',
    fontWeight: 700,
    fontSize: '11px',
    letterSpacing: '0.02em',
  },
  debate: {
    borderLeft: '3px solid #dc2626',
    backgroundColor: 'rgba(220, 38, 38, 0.07)',
    borderRadius: '0 8px 8px 0',
    padding: '7px 10px',
    fontSize: '12px',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
  },
  reviewNote: {
    fontSize: '12px',
    lineHeight: 1.5,
    opacity: 0.78,
    whiteSpace: 'pre-wrap',
  },
  debateTitle: {
    color: '#b91c1c',
    fontWeight: 700,
    fontSize: '11px',
    letterSpacing: '0.02em',
  },
  loader: {
    color: '#1d4ed8',
    fontSize: '11px',
  },
  approve: {
    flex: 'none',
    border: '1px solid var(--dsw-alias-border-success, #15803d)',
    background: 'transparent',
    color: 'var(--dsw-alias-text-success, #15803d)',
    borderRadius: '7px',
    padding: '4px 9px',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '12px',
  },
  actions: {
    flex: 'none',
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
  },
  delete: {
    flex: 'none',
    border: '1px solid var(--dsw-alias-border-danger, #d92d20)',
    background: 'transparent',
    color: 'var(--dsw-alias-text-danger, #d92d20)',
    borderRadius: '7px',
    padding: '4px 9px',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '12px',
  },
  humanAdopt: {
    flex: 'none',
    border: '1px solid #15803d',
    background: 'rgba(21, 128, 61, 0.10)',
    color: '#15803d',
    borderRadius: '7px',
    padding: '4px 9px',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '12px',
    fontWeight: 600,
  },
  humanDiscard: {
    flex: 'none',
    border: '1px solid #b91c1c',
    background: 'rgba(220, 38, 38, 0.10)',
    color: '#b91c1c',
    borderRadius: '7px',
    padding: '4px 9px',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '12px',
    fontWeight: 600,
  },
  error: {
    color: 'var(--dsw-alias-text-danger, #d92d20)',
    fontSize: '13px',
  },
  empty: {
    opacity: 0.6,
    fontSize: '13px',
    padding: '24px 0',
    textAlign: 'center',
  },
  detail: {
    fontSize: '12px',
    lineHeight: 1.5,
    opacity: 0.78,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  resolutionLabel: {
    fontSize: '12px',
    fontWeight: 600,
    marginTop: '2px',
  },
  resolutionInput: {
    width: '100%',
    minHeight: '52px',
    resize: 'vertical',
    boxSizing: 'border-box',
    padding: '8px 10px',
    border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,.35))',
    borderRadius: '8px',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: '12px',
    lineHeight: 1.5,
    outline: 'none',
  },
  helper: {
    color: 'var(--dsw-alias-text-warning, #b45309)',
    fontSize: '12px',
  },
  save: {
    flex: 'none',
    border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,.35))',
    background: 'transparent',
    color: 'inherit',
    borderRadius: '7px',
    padding: '4px 9px',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '12px',
  },
  dashboard: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
  },
  stat: {
    minWidth: '112px',
    border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,.35))',
    borderRadius: '9px',
    padding: '7px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    background: 'transparent',
  },
  statLabel: {
    fontSize: '10px',
    letterSpacing: '0.04em',
    opacity: 0.65,
    textTransform: 'uppercase',
  },
  statValue: {
    fontSize: '18px',
    fontWeight: 700,
    lineHeight: 1.1,
  },
  statDanger: {
    color: '#d92d20',
    borderColor: '#d92d20',
  },
  statInfo: {
    color: '#2563eb',
    borderColor: '#2563eb',
  },
  statOk: {
    color: '#15803d',
    borderColor: '#15803d',
  },
  tabs: {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap',
  },
  tab: {
    border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,.35))',
    background: 'transparent',
    color: 'inherit',
    borderRadius: '999px',
    padding: '4px 10px',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '12px',
  },
  tabActive: {
    borderColor: '#2563eb',
    color: '#2563eb',
    background: 'rgba(37, 99, 235, 0.10)',
  },
  contentClamp: {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  provenance: {
    fontSize: '10px',
    opacity: 0.6,
    lineHeight: 1.5,
    marginBottom: '4px',
    overflowWrap: 'anywhere',
  },
  traceBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    border: '1px dashed rgba(37, 99, 235, 0.35)',
    borderRadius: '8px',
    padding: '7px 9px',
    background: 'rgba(37, 99, 235, 0.04)',
    fontSize: '11px',
    lineHeight: 1.55,
  },
  traceTitle: {
    color: '#2563eb',
    fontWeight: 700,
    fontSize: '11px',
  },
  traceStep: {
    opacity: 0.78,
    overflowWrap: 'anywhere',
  },
  detailLink: {
    alignSelf: 'flex-start',
    border: 'none',
    background: 'none',
    padding: 0,
    color: '#2563eb',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  detailBack: {
    marginLeft: 'auto',
    border: 'none',
    background: 'none',
    padding: 0,
    color: '#2563eb',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  expand: {
    alignSelf: 'flex-start',
    border: 'none',
    background: 'transparent',
    color: '#2563eb',
    padding: '0',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '11px',
  },
  detailBox: {
    border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,.28))',
    borderRadius: '8px',
    padding: '7px 9px',
    fontSize: '12px',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  sources: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    fontSize: '11px',
  },
  sourceLink: {
    color: '#2563eb',
    textDecoration: 'none',
    overflowWrap: 'anywhere',
  },
  badgeSpeculative: {
    border: '1px solid #2563eb',
    color: '#2563eb',
    borderRadius: '999px',
    padding: '1px 7px',
    fontSize: '11px',
  },
  badgeMeta: {
    border: '1px solid #9333ea',
    color: '#9333ea',
    borderRadius: '999px',
    padding: '1px 7px',
    fontSize: '11px',
  },
  statWide: {
    flex: '1 1 240px',
    minWidth: '240px',
  },
  tokenMeta: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
    fontSize: '11px',
    opacity: 0.78,
  },
  tokenBar: {
    height: '6px',
    borderRadius: '999px',
    background: 'rgba(128,128,128,.22)',
    overflow: 'hidden',
  },
  tokenBarFill: {
    height: '100%',
    borderRadius: '999px',
    background: '#2563eb',
    transition: 'width .3s ease',
  },
  fuseBadge: {
    color: '#d92d20',
    fontWeight: 700,
    fontSize: '11px',
  },
  panelRow: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
  },
  panel: {
    flex: '1 1 320px',
    minWidth: '280px',
    border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,.35))',
    borderRadius: '9px',
    padding: '7px 10px',
    background: 'transparent',
  },
  panelSummary: {
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '12px',
    lineHeight: 1.5,
  },
  panelBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    paddingTop: '6px',
  },
  securityRow: {
    display: 'grid',
    gridTemplateColumns: '128px 72px minmax(0, 1fr)',
    gap: '8px',
    alignItems: 'start',
    padding: '4px 0',
    borderTop: '1px dashed var(--dsw-alias-border-base, rgba(128,128,128,.28))',
    fontSize: '11px',
  },
  securityTime: {
    opacity: 0.7,
    whiteSpace: 'nowrap',
  },
  securitySource: {
    color: '#2563eb',
    overflowWrap: 'anywhere',
  },
  securityExcerpt: {
    opacity: 0.78,
    overflowWrap: 'anywhere',
    lineHeight: 1.5,
  },
  securityEmpty: {
    fontSize: '11px',
    opacity: 0.62,
    lineHeight: 1.55,
    paddingTop: '4px',
  },
  billingRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '10px',
    fontSize: '11px',
    lineHeight: 1.6,
  },
  billingLabel: {
    opacity: 0.65,
    flex: 'none',
  },
  billingValue: {
    textAlign: 'right',
    overflowWrap: 'anywhere',
  },
  timeline: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
    paddingTop: '2px',
  },
  timelineRow: {
    display: 'grid',
    gridTemplateColumns: '10px minmax(0, 1fr)',
    gap: '8px',
    alignItems: 'start',
  },
  timelineRail: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    paddingTop: '5px',
  },
  timelineDot: {
    width: '7px',
    height: '7px',
    borderRadius: '999px',
    background: '#2563eb',
    flex: 'none',
  },
  timelineCopy: {
    borderLeft: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,.28))',
    padding: '0 0 9px 9px',
    marginLeft: '-5px',
  },
  timelineTitle: {
    fontSize: '11px',
    fontWeight: 700,
    lineHeight: 1.6,
  },
  timelineText: {
    fontSize: '12px',
    lineHeight: 1.55,
    opacity: 0.8,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  errorBox: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    border: '1px solid #d92d20',
    borderRadius: '8px',
    padding: '7px 10px',
  },
  errorText: {
    flex: '1 1 240px',
    color: '#d92d20',
    fontSize: '12px',
    lineHeight: 1.5,
  },
  auditHistory: {
    marginTop: '6px',
    borderTop: '1px dashed var(--dsw-alias-border-base, rgba(128,128,128,.28))',
    paddingTop: '6px',
  },
  debateBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexWrap: 'wrap',
    border: '1px solid #9333ea',
    borderRadius: '9px',
    padding: '7px 10px',
    background: 'rgba(147, 51, 234, 0.06)',
  },
  debateBannerTitle: {
    color: '#7e22ce',
    fontWeight: 700,
    fontSize: '13px',
  },
  debateBannerText: {
    flex: '1 1 240px',
    fontSize: '11px',
    opacity: 0.75,
  },
  debateSpace: {
    border: '1px solid rgba(147, 51, 234, 0.35)',
    borderRadius: '10px',
    padding: '10px 12px',
    background: 'rgba(147, 51, 234, 0.04)',
    display: 'flex',
    flexDirection: 'column',
    gap: '7px',
  },
  debateHead: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '8px',
  },
  debateSpaceTitle: {
    color: '#7e22ce',
    fontWeight: 700,
    fontSize: '12px',
    letterSpacing: '0.02em',
  },
  debateRoundTag: {
    fontSize: '10px',
    opacity: 0.6,
  },
  debateTopic: {
    fontSize: '12px',
    fontWeight: 600,
    lineHeight: 1.5,
    overflowWrap: 'anywhere',
  },
  whaleWrap: {
    position: 'absolute',
    right: '28px',
    bottom: '24px',
    zIndex: 30,
    display: 'flex',
    alignItems: 'flex-end',
    gap: '8px',
    pointerEvents: 'none',
  },
  whaleEmoji: {
    display: 'inline-block',
    fontSize: '42px',
    lineHeight: 1,
    animationDuration: '3.2s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
  },
  whaleBubble: {
    maxWidth: '150px',
    padding: '6px 10px',
    borderRadius: '12px 12px 2px 12px',
    border: '1px solid rgba(37, 99, 235, 0.35)',
    background: 'rgba(37, 99, 235, 0.08)',
    fontSize: '11px',
    lineHeight: 1.5,
    color: '#1d4ed8',
  },
  auditBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexWrap: 'wrap',
    border: '1px solid #0f766e',
    borderRadius: '9px',
    padding: '7px 10px',
    background: 'rgba(15, 118, 110, 0.06)',
  },
  auditBannerTitle: {
    color: '#0f766e',
    fontWeight: 700,
    fontSize: '13px',
  },
  auditBannerText: {
    flex: '1 1 260px',
    fontSize: '11px',
    opacity: 0.78,
  },
  auditBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    border: '1px dashed rgba(15, 118, 110, 0.35)',
    borderRadius: '8px',
    padding: '7px 9px',
    background: 'rgba(15, 118, 110, 0.04)',
  },
  auditBadges: {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap',
  },
  auditLong: {
    border: '1px solid #0f766e',
    color: '#0f766e',
    borderRadius: '999px',
    padding: '1px 7px',
    fontSize: '10px',
    fontWeight: 700,
  },
  auditTemp: {
    border: '1px solid #b45309',
    color: '#b45309',
    borderRadius: '999px',
    padding: '1px 7px',
    fontSize: '10px',
    fontWeight: 700,
  },
  auditNeeded: {
    border: '1px solid #15803d',
    color: '#15803d',
    borderRadius: '999px',
    padding: '1px 7px',
    fontSize: '10px',
    fontWeight: 700,
  },
  auditUnneeded: {
    border: '1px solid #d92d20',
    color: '#d92d20',
    borderRadius: '999px',
    padding: '1px 7px',
    fontSize: '10px',
    fontWeight: 700,
  },
  auditUncertain: {
    border: '1px solid #6b7280',
    color: '#6b7280',
    borderRadius: '999px',
    padding: '1px 7px',
    fontSize: '10px',
    fontWeight: 700,
  },
  auditReason: {
    fontSize: '11px',
    opacity: 0.72,
    lineHeight: 1.5,
  },
  debateOrigin: {
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    border: '1px dashed rgba(147, 51, 234, 0.35)',
    borderRadius: '8px',
    padding: '7px 9px',
    background: 'rgba(147, 51, 234, 0.04)',
    fontSize: '11px',
    lineHeight: 1.55,
    overflowWrap: 'anywhere',
  },
  debateReview: {
    fontSize: '11px',
    opacity: 0.72,
    lineHeight: 1.5,
    borderLeft: '2px solid #d92d20',
    paddingLeft: '7px',
    overflowWrap: 'anywhere',
  },
  debateRounds: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    paddingTop: '2px',
  },
  debateRowChild: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '3px',
    maxWidth: '92%',
  },
  debateRowMother: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '3px',
    maxWidth: '92%',
    alignSelf: 'flex-end',
  },
  debateSpeakerChild: {
    color: '#1d4ed8',
    fontSize: '10px',
    fontWeight: 700,
  },
  debateSpeakerMother: {
    color: '#7e22ce',
    fontSize: '10px',
    fontWeight: 700,
  },
  debateBubbleChild: {
    border: '1px solid #2563eb',
    background: 'rgba(37, 99, 235, 0.08)',
    borderRadius: '2px 10px 10px 10px',
    padding: '7px 10px',
    fontSize: '12px',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  debateBubbleMother: {
    border: '1px solid #9333ea',
    background: 'rgba(147, 51, 234, 0.10)',
    borderRadius: '10px 2px 10px 10px',
    padding: '7px 10px',
    fontSize: '12px',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  debateTyping: {
    color: '#2563eb',
    fontSize: '11px',
    paddingLeft: '2px',
    animationName: 'dshDebateTyping',
    animationDuration: '1.2s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
  },
  debateLegacy: {
    fontSize: '11px',
    opacity: 0.62,
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  debateVerdict: {
    border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,.28))',
    borderRadius: '8px',
    padding: '6px 9px',
    fontSize: '11px',
    fontWeight: 600,
    textAlign: 'center',
    background: 'rgba(128, 128, 128, 0.06)',
  },
} as const

const FILTER_TABS: Array<{ id: FilterTab; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'basic', label: '基础记忆' },
  { id: 'skill', label: '排错飞轮' },
  { id: 'dma', label: '跨学科漫游' },
  { id: 'human', label: '待人类裁决' },
  { id: 'debate', label: '辩论空间' },
  { id: 'audit', label: '自我审计' },
  { id: 'model', label: '思维模型' },
  { id: 'strategy', label: '方法论库' },
]

const MEMORY_PULSE_CSS = `
@keyframes dshMemoryBreathe {
  0%, 100% { box-shadow: 0 0 0 0 rgba(217, 45, 32, 0.18); }
  50% { box-shadow: 0 0 0 5px rgba(217, 45, 32, 0.04); }
}
@keyframes dshDebateTyping {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}
@keyframes dshWhaleFloat {
  0%, 100% { transform: translateY(0) rotate(-2deg); }
  50% { transform: translateY(-7px) rotate(2deg); }
}
@keyframes dshWhaleShake {
  0%, 100% { transform: translateX(0) rotate(0); }
  20% { transform: translateX(-2px) rotate(-3deg); }
  40% { transform: translateX(2px) rotate(3deg); }
  60% { transform: translateX(-2px) rotate(-2deg); }
  80% { transform: translateX(2px) rotate(2deg); }
}
`

const CARD_DENSITY = {
  compact: { padding: '8px 10px', gap: '8px', fontSize: '12px' },
  standard: { padding: '12px 14px', gap: '12px', fontSize: '13px' },
  large: { padding: '18px 20px', gap: '16px', fontSize: '14px' },
} as const

const WhaleMascot = React.memo(function WhaleMascot(props: { busy: boolean; error: boolean }) {
  const [tip, setTip] = React.useState('正在深度思考…')
  React.useEffect(() => {
    const tips = ['正在深度思考…', '已记录经验']
    const timer = setInterval(() => {
      setTip(tips[Math.floor(Math.random() * tips.length)] ?? tips[0])
    }, 9000)
    return () => clearInterval(timer)
  }, [])
  return h('div', { style: memoryStyles.whaleWrap, 'aria-hidden': true }, [
    h('span', {
      key: 'emoji',
      style: {
        ...memoryStyles.whaleEmoji,
        animationName: props.error ? 'dshWhaleShake' : 'dshWhaleFloat',
        ...(props.error ? { filter: 'saturate(2) drop-shadow(0 0 10px rgba(217, 45, 32, 0.85))' } : {}),
      },
    }, '🐳'),
    h('span', {
      key: 'bubble',
      style: props.error
        ? { ...memoryStyles.whaleBubble, borderColor: '#d92d20', color: '#b91c1c' }
        : memoryStyles.whaleBubble,
    }, props.error ? '遇到问题了…' : props.busy ? '正在深度思考…' : tip),
  ])
})

function isSafeHttpUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value)
}

function formatMemoryTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function MemoryExplorerIcon(props: { size?: number; active?: boolean }) {
  const size = typeof props.size === 'number' ? props.size : 18
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    style: { display: 'block', opacity: props.active ? 1 : 0.75 },
  }, [
    h('path', { key: 'a', d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }),
    h('path', { key: 'b', d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z' }),
    h('path', { key: 'c', d: 'M9 7h7M9 11h7' }),
  ])
}

function MemoryExplorerPage() {
  const [items, setItems] = React.useState([] as MemoryItem[])
  const [query, setQuery] = React.useState('')
  const [detailId, setDetailId] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [deleting, setDeleting] = React.useState(null)
  const [approving, setApproving] = React.useState(null)
  const [saving, setSaving] = React.useState(null)
  const [humanDeciding, setHumanDeciding] = React.useState(null)
  const [arbitrating, setArbitrating] = React.useState(null)
  const [drafts, setDrafts] = React.useState({} as Record<string, string>)
  const [activeTab, setActiveTab] = React.useState('all' as FilterTab)
  const [expanded, setExpanded] = React.useState({} as Record<string, boolean>)
  const [writeQueue, setWriteQueue] = React.useState('unknown')
  const [securityLog, setSecurityLog] = React.useState([] as SecurityIntercept[])
  const [billing, setBilling] = React.useState(null as Billing | null)
  const [auditEntries, setAuditEntries] = React.useState(null as AuditEntry[] | null)
  const [auditLoading, setAuditLoading] = React.useState(false)
  const [distilling, setDistilling] = React.useState(false)
  const [density, setDensity] = React.useState('standard')
  const pageRef = React.useRef(null)
  const loadSeqRef = React.useRef(0)
  const [pageVisible, setPageVisible] = React.useState(false)
  React.useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setPageVisible(true)
      return
    }
    const node = pageRef.current
    if (node === null) return
    const observer = new IntersectionObserver(entries => {
      setPageVisible(entries.some(entry => entry.isIntersecting))
    }, { threshold: 0.01 })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const loadTelemetry = async () => {
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      const [securityResponse, billingResponse] = await Promise.all([
        fetch(`${MEMORY_API}/security-log`, { cache: 'no-store' }),
        fetch(`${MEMORY_API}/billing`, { cache: 'no-store' }),
      ])
      const securityBody = await securityResponse.json()
      if (securityResponse.ok && securityBody?.ok === true && Array.isArray(securityBody.entries)) {
        const entries = securityBody.entries as SecurityIntercept[]
        setSecurityLog((previous: SecurityIntercept[]) => JSON.stringify(previous) === JSON.stringify(entries) ? previous : entries)
      }
      const billingBody = await billingResponse.json()
      if (billingResponse.ok && billingBody?.ok === true && billingBody.billing !== undefined) {
        const next = billingBody.billing as Billing
        setBilling((previous: Billing | null) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
      }
    } catch {
      // 遥测失败不阻塞主列表；保留上一次成功的数据。
    }
  }

  const loadAudit = async () => {
    setAuditLoading(true)
    try {
      const response = await fetch(`${MEMORY_API}/audit?limit=30`, { cache: 'no-store' })
      const body = await response.json()
      if (response.ok && body?.ok === true && Array.isArray(body.entries)) {
        setAuditEntries(body.entries as AuditEntry[])
      }
    } catch {
      // 历史审计加载失败不阻塞主列表。
    } finally {
      setAuditLoading(false)
    }
  }

  const load = async (signal?: AbortSignal) => {
    const sequence = ++loadSeqRef.current
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${MEMORY_API}/list`, { signal: signal ?? null, cache: 'no-store' })
      const body = await response.json()
      if (!response.ok || body?.ok !== true) {
        throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
      }
      const next = Array.isArray(body.items)
        ? body.items.map((item: MemoryItem) => ({
          ...item,
          status: normalizeMemoryStatus(item.status),
        }))
        : []
      if (sequence !== loadSeqRef.current) return
      setItems(next)
      if (typeof body.health?.writeQueue === 'string') {
        setWriteQueue(body.health.writeQueue)
      }
    } catch (caught) {
      if ((caught as Error)?.name === 'AbortError') return
      setError((caught as Error)?.message || '加载失败')
    } finally {
      if (signal?.aborted !== true) setLoading(false)
    }
  }

  React.useEffect(() => {
    if (!pageVisible) return
    const controller = new AbortController()
    void load(controller.signal)
    void loadTelemetry()
    return () => controller.abort()
  }, [pageVisible])

  React.useEffect(() => {
    if (!pageVisible) return
    const timer = setInterval(() => { void loadTelemetry() }, 30_000)
    return () => clearInterval(timer)
  }, [pageVisible])

  React.useEffect(() => {
    if (!pageVisible) return
    let cancelled = false
    const readHealth = async () => {
      if (typeof document !== 'undefined' && document.hidden) return
      try {
        const response = await fetch(`${MEMORY_API}/health`, { cache: 'no-store' })
        const body = await response.json()
        if (!cancelled && body?.ok === true && typeof body.health?.writeQueue === 'string') {
          setWriteQueue(body.health.writeQueue)
        }
      } catch {
        if (!cancelled) setWriteQueue('unknown')
      }
    }
    void readHealth()
    const timer = setInterval(() => { void readHealth() }, 10_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pageVisible])

  React.useEffect(() => {
    if (!pageVisible) return
    const source = new EventSource(`${MEMORY_API}/events`)
    const upsert = (raw: MemoryItem) => {
      if (raw === null || typeof raw !== 'object') return
      if (typeof raw.id !== 'string' || typeof raw.content !== 'string') return
      const item: MemoryItem = { ...raw, status: normalizeMemoryStatus(raw.status) }
      setItems((previous: MemoryItem[]) => {
        const index = previous.findIndex(existing => existing.id === item.id)
        if (index < 0) return [item, ...previous]
        const next = [...previous]
        next[index] = item
        return next
      })
    }
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data)
        if (payload?.type === 'memory:added' && payload.item !== undefined) upsert(payload.item)
        else if (payload?.type === 'memory:updated' && payload.item !== undefined) upsert(payload.item)
        else if (payload?.type === 'memory:removed' && typeof payload.id === 'string') {
          setItems((previous: MemoryItem[]) => previous.filter(item => item.id !== payload.id))
        }
      } catch {
        // 忽略格式异常的事件帧，SSE 连接继续。
      }
    }
    return () => source.close()
  }, [pageVisible])

  const filtered = React.useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return items.filter((item: MemoryItem) => matchesFilter(item, activeTab, keyword))
  }, [items, query, activeTab])

  const visibleItems = detailId === null
    ? filtered
    : filtered.filter((item: MemoryItem) => item.id === detailId)

  const closeDetail = () => {
    if (detailId !== null) {
      setExpanded((previous: Record<string, boolean>) => ({ ...previous, [detailId]: false }))
    }
    setDetailId(null)
  }

  const distill = async () => {
    setDistilling(true)
    setError('')
    try {
      const response = await fetch(`${MEMORY_API}/model/distill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const body = await response.json()
      if (!response.ok || body?.ok !== true) {
        throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
      }
      const item = body.item as MemoryItem
      const extras: MemoryItem[] = []
      if (body.strategy !== undefined) extras.push(body.strategy as MemoryItem)
      if (body.rule !== undefined) extras.push(body.rule as MemoryItem)
      const addedIds = new Set([item.id, ...extras.map(extra => extra.id)])
      setItems((previous: MemoryItem[]) => [
        ...extras,
        item,
        ...previous.filter(existing => !addedIds.has(existing.id)),
      ])
      setDetailId(null)
      setActiveTab(extras.length > 0 ? 'strategy' : 'model')
    } catch (caught) {
      setError((caught as Error)?.message || '提炼模型失败')
    } finally {
      setDistilling(false)
    }
  }

  const remove = async (item: MemoryItem) => {
    const id = item.id
    // 提炼策略/法则是可追溯资产：丢弃只置为 rejected，不物理删除。
    const soft = item.type === 'extraction_strategy'
    setDeleting(id)
    setError('')
    try {
      const response = await fetch(`${MEMORY_API}/${soft ? 'reject' : 'delete'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const body = await response.json()
      if (!response.ok || body?.ok !== true) {
        throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
      }
      if (soft) {
        setItems((previous: MemoryItem[]) =>
          previous.map(existing => existing.id === id ? body.item : existing))
      } else {
        setItems((previous: MemoryItem[]) => previous.filter(existing => existing.id !== id))
      }
      setDetailId(null)
    } catch (caught) {
      setError((caught as Error)?.message || (soft ? '丢弃失败' : '删除失败'))
    } finally {
      setDeleting(null)
    }
  }

  const draftOf = (item: MemoryItem): string => drafts[item.id] ?? item.resolution ?? ''

  const saveResolution = async (id: string, resolution: string): Promise<MemoryItem | undefined> => {
    const response = await fetch(`${MEMORY_API}/resolution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, resolution }),
    })
    const body = await response.json()
    if (!response.ok || body?.ok !== true) {
      throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
    }
    setItems((previous: MemoryItem[]) => previous.map(item => item.id === id ? body.item : item))
    return body.item
  }

  const approveItem = async (item: MemoryItem) => {
    setError('')
    if (item.type === 'skill_error_fix') {
      const resolution = draftOf(item).trim()
      if (resolution === '') {
        setError('尚未记录解决办法，请补充后确认')
        return
      }
      setSaving(item.id)
      try {
        await saveResolution(item.id, resolution)
      } catch (caught) {
        setError((caught as Error)?.message || '保存解决办法失败')
        setSaving(null)
        return
      }
      setSaving(null)
    }

    setApproving(item.id)
    try {
      const response = await fetch(`${MEMORY_API}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      })
      const body = await response.json()
      if (!response.ok || body?.ok !== true) {
        throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
      }
      setItems((previous: MemoryItem[]) => previous.map(existing => existing.id === item.id ? body.item : existing))
      setDetailId(null)
    } catch (caught) {
      setError((caught as Error)?.message || '确认失败')
    } finally {
      setApproving(null)
    }
  }

  const saveOnly = async (item: MemoryItem) => {
    const resolution = draftOf(item).trim()
    if (resolution === '') {
      setError('尚未记录解决办法，请补充后确认')
      return
    }
    setSaving(item.id)
    setError('')
    try {
      await saveResolution(item.id, resolution)
      setDrafts((previous: Record<string, string>) => ({ ...previous, [item.id]: resolution }))
    } catch (caught) {
      setError((caught as Error)?.message || '保存解决办法失败')
    } finally {
      setSaving(null)
    }
  }

  const humanDecide = async (id: string, decision: 'adopt' | 'discard') => {
    setHumanDeciding(`${id}:${decision}`)
    setError('')
    try {
      const target = items.find((item: MemoryItem) => item.id === id)
      if (target?.type === 'skill_error_fix') {
        const resolution = draftOf(target).trim()
        if (resolution !== '' && resolution !== (target.resolution ?? '')) {
          try {
            await saveResolution(id, resolution)
          } catch (caught) {
            setError((caught as Error)?.message || '保存解决办法失败，请先保存再裁决')
            return
          }
        }
      }
      const response = await fetch(`${MEMORY_API}/human-decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, decision }),
      })
      const body = await response.json()
      if (!response.ok || body?.ok !== true) {
        throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
      }
      setItems((previous: MemoryItem[]) =>
        previous.map(item => item.id === id ? body.item : item))
      setDetailId(null)
    } catch (caught) {
      setError((caught as Error)?.message || '人类裁决失败')
    } finally {
      setHumanDeciding(null)
    }
  }

  const arbitrate = async (id: string) => {
    setArbitrating(id)
    setError('')
    try {
      const response = await fetch(`${MEMORY_API}/arbitrate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const body = await response.json()
      if (!response.ok || body?.ok !== true) {
        throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
      }
      setItems((previous: MemoryItem[]) => previous.map(item => item.id === id ? body.item : item))
      setDetailId(null)
    } catch (caught) {
      setError((caught as Error)?.message || '开卷申诉失败')
    } finally {
      setArbitrating(null)
    }
  }

  const empty = h('div', { key: 'empty', style: memoryStyles.empty }, activeTab === 'strategy'
    ? (query.trim() === ''
      ? '方法论库还是空的：跑一次小提炼或大提炼，系统会自己沉淀提炼策略'
      : '没有匹配的方法论')
    : query.trim() === '' ? '暂无记忆' : '没有匹配的记忆')
  const counts = React.useMemo(() => tabCounts(items), [items])
  const audit = React.useMemo(() => auditSummary(items), [items])
  const humanCount = items.filter((item: MemoryItem) => item.status === 'human_intervention').length
  const debatingCount = items.filter((item: MemoryItem) => item.status === 'debating').length
  const debateTotal = items.filter((item: MemoryItem) =>
    item.type === 'skill_error_fix' && hasDebateRecord(item)).length
  const today = new Date().toDateString()
  const todaySpeculative = items.filter((item: MemoryItem) =>
    item.status === 'speculative'
    && new Date(item.createdAt).toDateString() === today).length
  const queueLabel = writeQueue === 'busy' ? '繁忙' : writeQueue === 'idle' ? '正常' : '未知'
  const queueStyle = writeQueue === 'busy' ? memoryStyles.statDanger : memoryStyles.statOk
  const tokenPercent = billing === null
    ? 0
    : billing.dailyBudget !== undefined && billing.dailyBudget > 0
      ? Math.min(100, Math.round(((billing.todayTokens ?? 0) / billing.dailyBudget) * 100))
      : (billing.tokenLimit ?? 0) <= 0
        ? 0
        : Math.min(100, Math.round(((billing.lastRunTokens ?? 0) / billing.tokenLimit) * 100))
  const whaleBusy = loading || saving !== null || approving !== null || humanDeciding !== null || arbitrating !== null
  return h('div', { ref: pageRef, style: memoryStyles.page }, [
    h('style', { key: 'pulse-style' }, MEMORY_PULSE_CSS),
    pageVisible ? h(WhaleMascot, { key: 'whale', busy: whaleBusy, error: error !== '' }) : null,
    h('div', { key: 'header', style: memoryStyles.header }, [
      h('h2', { key: 'title', style: memoryStyles.title }, '记忆控制台'),
      h('span', { key: 'count', style: memoryStyles.count },
        `共 ${items.length} 条 · ${activeTab === 'all' ? '全量视图' : '筛选视图'}`),
      detailId !== null
        ? h('button', {
          key: 'detail-back',
          type: 'button',
          style: memoryStyles.detailBack,
          onClick: closeDetail,
        }, '← 返回卡片')
        : null,
    ]),
    h('div', { key: 'dashboard', style: memoryStyles.dashboard }, [
      h('div', { key: 'total', style: memoryStyles.stat }, [
        h('span', { key: 'label', style: memoryStyles.statLabel }, '总记忆'),
        h('span', { key: 'value', style: memoryStyles.statValue }, String(items.length)),
      ]),
      h('div', { key: 'human', style: { ...memoryStyles.stat, ...memoryStyles.statDanger } }, [
        h('span', { key: 'label', style: memoryStyles.statLabel }, '待人类裁决'),
        h('span', { key: 'value', style: memoryStyles.statValue }, String(humanCount)),
      ]),
      h('div', { key: 'spec', style: { ...memoryStyles.stat, ...memoryStyles.statInfo } }, [
        h('span', { key: 'label', style: memoryStyles.statLabel }, '今日漫游'),
        h('span', { key: 'value', style: memoryStyles.statValue }, String(todaySpeculative)),
      ]),
      h('div', { key: 'token', style: { ...memoryStyles.stat, ...memoryStyles.statWide } }, [
        h('span', { key: 'label', style: memoryStyles.statLabel }, '熔断 Token 账单'),
        h('span', { key: 'value', style: memoryStyles.statValue },
          billing === null ? '—' : `${billing.todayTokens.toLocaleString('zh-CN')} 今日`),
        billing === null
          ? null
          : h('div', { key: 'meta', style: memoryStyles.tokenMeta }, [
            billing.dailyBudget !== undefined && billing.dailyBudget > 0
              ? h('span', { key: 'budget' },
                `预算 ${billing.dailyBudget.toLocaleString('zh-CN')} · 剩余 ${(billing.budgetRemaining ?? 0).toLocaleString('zh-CN')}`)
              : h('span', { key: 'last' },
                `最近一次 ${billing.lastRunTokens.toLocaleString('zh-CN')} / 上限 ${billing.tokenLimit.toLocaleString('zh-CN')}`),
            billing.budgetExceeded === true
              ? h('span', { key: 'exceeded', style: memoryStyles.fuseBadge }, '每日预算已用完')
              : billing.fuseCount > 0
                ? h('span', { key: 'fuse', style: memoryStyles.fuseBadge }, `已熔断 ${billing.fuseCount} 次`)
                : h('span', { key: 'ok' }, '未熔断'),
          ]),
        billing === null
          ? null
          : h('div', { key: 'bar', style: memoryStyles.tokenBar }, [
            h('div', {
              key: 'fill',
              style: {
                ...memoryStyles.tokenBarFill,
                width: `${tokenPercent}%`,
                ...(billing.fuseCount > 0 || billing.budgetExceeded === true ? { background: '#d92d20' } : {}),
              },
            }),
          ]),
      ]),
      h('div', { key: 'security', style: { ...memoryStyles.stat, ...memoryStyles.statInfo } }, [
        h('span', { key: 'label', style: memoryStyles.statLabel }, '安全拦截'),
        h('span', { key: 'value', style: memoryStyles.statValue }, String(securityLog.length)),
        h('span', { key: 'hint', style: memoryStyles.count }, '本次运行'),
      ]),
      h('div', { key: 'queue', style: { ...memoryStyles.stat, ...queueStyle } }, [
        h('span', { key: 'label', style: memoryStyles.statLabel }, 'WriteQueue'),
        h('span', { key: 'value', style: memoryStyles.statValue }, queueLabel),
      ]),
    ]),
    h('div', { key: 'panels', style: memoryStyles.panelRow }, [
      h('details', { key: 'security-panel', style: memoryStyles.panel }, [
        h('summary', { key: 'summary', style: memoryStyles.panelSummary },
          `安全拦截日志 · 本次运行 ${securityLog.length} 条`),
        securityLog.length === 0
          ? h('div', { key: 'empty', style: memoryStyles.securityEmpty },
            '本次运行尚未拦截到注入内容。规则命中只表示检测到可疑模式，不代表已确认攻击。')
          : h('div', { key: 'rows', style: memoryStyles.panelBody },
            securityLog.slice(0, 20).map((entry: SecurityIntercept) => h('div', { key: `security-${entry.id}`, style: memoryStyles.securityRow }, [
              h('span', { key: 'time', style: memoryStyles.securityTime }, formatMemoryTime(entry.time)),
              h('span', { key: 'source', style: memoryStyles.securitySource }, entry.source),
              h('span', { key: 'detail', style: memoryStyles.securityExcerpt }, `[${entry.pattern}] ${entry.excerpt}`),
            ]))),
        securityLog.length > 20
          ? h('div', { key: 'more', style: memoryStyles.securityEmpty },
            `仅显示最近 20 条，共 ${securityLog.length} 条`)
          : null,
        h('details', { key: 'audit-history', style: memoryStyles.auditHistory }, [
          h('summary', { key: 'summary', style: memoryStyles.panelSummary }, '持久化审计（最近 30 条）'),
          auditEntries === null
            ? h('button', {
              key: 'load',
              type: 'button',
              style: memoryStyles.button,
              disabled: auditLoading,
              onClick: () => { void loadAudit() },
            }, auditLoading ? '加载中…' : '加载历史审计')
            : h('div', { key: 'rows', style: memoryStyles.panelBody },
              auditEntries.slice(0, 30).map((entry: AuditEntry, index: number) => h('div', {
                key: `audit-${index}`,
                style: memoryStyles.securityRow,
              }, [
                h('span', { key: 'time', style: memoryStyles.securityTime }, formatMemoryTime(entry.ts)),
                h('span', { key: 'event', style: memoryStyles.securitySource }, entry.event),
                h('span', { key: 'payload', style: memoryStyles.securityExcerpt },
                  JSON.stringify(entry.payload).slice(0, 120)),
              ]))),
        ]),
      ]),
      h('details', { key: 'billing-panel', style: memoryStyles.panel }, [
        h('summary', { key: 'summary', style: memoryStyles.panelSummary },
          billing === null
            ? '熔断 Token 账单'
            : `熔断 Token 账单 · 今日 ${billing.todayTokens.toLocaleString('zh-CN')} tokens`),
        billing === null
          ? h('div', { key: 'empty', style: memoryStyles.securityEmpty }, '暂无账单数据')
          : h('div', { key: 'rows', style: memoryStyles.panelBody }, [
            h('div', { key: 'r1', style: memoryStyles.billingRow }, [
              h('span', { style: memoryStyles.billingLabel }, '最近一次漫游'),
              h('span', { style: memoryStyles.billingValue },
                `${billing.lastRunTokens.toLocaleString('zh-CN')} / ${billing.tokenLimit.toLocaleString('zh-CN')}（单次硬上限）`),
            ]),
            h('div', { key: 'r2', style: memoryStyles.billingRow }, [
              h('span', { style: memoryStyles.billingLabel }, '今日 / 累计'),
              h('span', { style: memoryStyles.billingValue },
                `${billing.todayTokens.toLocaleString('zh-CN')} / ${billing.totalTokens.toLocaleString('zh-CN')} tokens`),
            ]),
            h('div', { key: 'stage', style: memoryStyles.billingRow }, [
              h('span', { style: memoryStyles.billingLabel }, '今日 审阅/辩论/漫游'),
              h('span', { style: memoryStyles.billingValue },
                `${(billing.reviewTodayTokens ?? 0).toLocaleString('zh-CN')} / ${(billing.debateTodayTokens ?? 0).toLocaleString('zh-CN')} / ${(billing.dmaTodayTokens ?? 0).toLocaleString('zh-CN')}`),
            ]),
            h('div', { key: 'budget', style: memoryStyles.billingRow }, [
              h('span', { style: memoryStyles.billingLabel }, '每日预算'),
              h('span', {
                style: billing.budgetExceeded === true ? memoryStyles.fuseBadge : memoryStyles.billingValue,
              }, billing.dailyBudget !== undefined && billing.dailyBudget > 0
                ? `${billing.todayTokens.toLocaleString('zh-CN')} / ${billing.dailyBudget.toLocaleString('zh-CN')}${billing.budgetExceeded === true ? '（已用完）' : ''}`
                : '未设置（不限制）'),
            ]),
            h('div', { key: 'r3', style: memoryStyles.billingRow }, [
              h('span', { style: memoryStyles.billingLabel }, '运行次数'),
              h('span', { style: memoryStyles.billingValue }, `今日 ${billing.todayRuns} 次 · 累计 ${billing.totalRuns} 次`),
            ]),
            (billing.disciplineBreakdown ?? []).length === 0 ? null : h('div', { key: 'r4', style: memoryStyles.billingRow }, [
              h('span', { style: memoryStyles.billingLabel }, '学科分布'),
              h('span', { style: memoryStyles.billingValue }, (billing.disciplineBreakdown ?? [])
                .slice(0, 5)
                .map((entry: Billing['disciplineBreakdown'][number]) => `${entry.discipline} ${entry.tokens}t`)
                .join(' · ')),
            ]),
            h('div', { key: 'r5', style: memoryStyles.billingRow }, [
              h('span', { style: memoryStyles.billingLabel }, '熔断'),
              h('span', { style: billing.fuseCount > 0 ? memoryStyles.fuseBadge : memoryStyles.billingValue },
                billing.fuseCount > 0
                  ? `${billing.fuseCount} 次${billing.lastFuse !== undefined ? ` · 最近 ${formatMemoryTime(billing.lastFuse.time)}` : ''}`
                  : '未触发'),
            ]),
            billing.lastFuse !== undefined
              ? h('div', { key: 'r6', style: memoryStyles.securityExcerpt }, billing.lastFuse.message)
              : null,
            billing.lastError !== ''
              ? h('div', { key: 'r7', style: memoryStyles.securityExcerpt }, `最近错误：${billing.lastError}`)
              : null,
            h('div', { key: 'note', style: memoryStyles.securityEmpty },
              '说明：审阅/辩论用量来自模型 usage，漫游按 runId 去重；每日预算由 DSH_MEMORY_DAILY_TOKEN_BUDGET 设置，0 表示不限制。'),
          ]),
      ]),
    ]),
    h('div', { key: 'tabs', style: memoryStyles.tabs },
      FILTER_TABS.map(tab => h('button', {
        key: tab.id,
        type: 'button',
        style: activeTab === tab.id ? { ...memoryStyles.tab, ...memoryStyles.tabActive } : memoryStyles.tab,
        onClick: () => {
          setDetailId(null)
          if (typeof React.startTransition === 'function') React.startTransition(() => setActiveTab(tab.id))
          else setActiveTab(tab.id)
        },
      }, `${tab.label} ${counts[tab.id]}`))),
    activeTab === 'debate'
      ? h('div', { key: 'debate-banner', style: memoryStyles.debateBanner }, [
        h('span', { key: 'title', style: memoryStyles.debateBannerTitle }, '辩论空间'),
        h('span', { key: 'count', style: memoryStyles.debateBannerText },
          `有记录 ${debateTotal} 条 · 正在辩论 ${debatingCount} 条 · 待人类圣裁 ${humanCount} 条`),
        h('button', {
          key: 'expand-all',
          type: 'button',
          style: memoryStyles.button,
          onClick: () => {
            setExpanded((previous: Record<string, boolean>) => {
              const next = { ...previous }
              for (const item of filtered) next[item.id] = true
              return next
            })
          },
        }, '展开全部辩论'),
        h('button', {
          key: 'collapse-all',
          type: 'button',
          style: memoryStyles.button,
          onClick: () => setExpanded({} as Record<string, boolean>),
        }, '全部收起'),
      ])
      : null,
    activeTab === 'audit'
      ? h('div', { key: 'audit-banner', style: memoryStyles.auditBanner }, [
        h('span', { key: 'title', style: memoryStyles.auditBannerTitle }, 'AI 自我审计'),
        h('span', { key: 'summary', style: memoryStyles.auditBannerText },
          `长期 ${audit.longTerm} · 临时 ${audit.temporary} · 需要 ${audit.needed} · 可清理 ${audit.unneeded} · 待判断 ${audit.uncertain}`),
        h('span', { key: 'note', style: memoryStyles.auditReason }, '规则审计，仅给建议，不会自动删除。'),
      ])
      : null,
    activeTab === 'strategy'
      ? h('div', { key: 'strategy-banner', style: memoryStyles.auditBanner }, [
        h('span', { key: 'title', style: memoryStyles.auditBannerTitle }, '方法论库'),
        h('span', { key: 'summary', style: memoryStyles.auditBannerText },
          `小提炼反思 ${items.filter((item: MemoryItem) => item.type === 'extraction_strategy' && item.strategyStage === 'small').length} 条 · 大提炼反思 ${items.filter((item: MemoryItem) => item.type === 'extraction_strategy' && item.strategyStage === 'large').length} 条 · 融合法则 ${items.filter((item: MemoryItem) => item.type === 'extraction_strategy' && item.rule === true).length} 条`),
        h('span', { key: 'note', style: memoryStyles.auditReason },
          '提炼前自动注入最近最成功的 3 条策略；融合法则需人类裁决后，才会以最高优先级进入 System Prompt。'),
      ])
      : null,
    h('div', { key: 'toolbar', style: memoryStyles.toolbar }, [
      h('input', {
        key: 'search',
        style: memoryStyles.input,
        value: query,
        placeholder: '按关键词搜索记忆',
        'aria-label': '搜索记忆',
        onChange: (event: { target: { value: string } }) => {
          setDetailId(null)
          setQuery(event.target.value)
        },
      }),
      h('button', {
        key: 'refresh',
        type: 'button',
        style: memoryStyles.button,
        onClick: () => { void load() },
      }, '刷新'),
      h('button', {
        key: 'distill',
        type: 'button',
        style: memoryStyles.button,
        disabled: distilling,
        onClick: () => { void distill() },
      }, distilling ? '大提炼中…' : '大提炼（模型+策略）'),
      ...(['compact', 'standard', 'large'] as const).map(level => h('button', {
        key: `density-${level}`,
        type: 'button',
        style: density === level ? { ...memoryStyles.button, ...memoryStyles.tabActive } : memoryStyles.button,
        onClick: () => setDensity(level),
      }, level === 'compact' ? '紧凑' : level === 'standard' ? '标准' : '大')),
    ]),
    error !== ''
      ? h('div', { key: 'error', style: memoryStyles.errorBox }, [
        h('span', { key: 'text', style: memoryStyles.errorText }, error),
        h('button', {
          key: 'retry',
          type: 'button',
          style: memoryStyles.button,
          onClick: () => { void load() },
        }, '重试'),
        h('button', {
          key: 'dismiss',
          type: 'button',
          style: memoryStyles.button,
          onClick: () => setError(''),
        }, '忽略'),
      ])
      : null,
    loading ? h('div', { key: 'loading', style: memoryStyles.empty }, '加载中…') : null,
    !loading ? h('div', { key: 'list', style: memoryStyles.list },
      visibleItems.length === 0
        ? [detailId === null ? empty : h('div', { key: 'missing', style: memoryStyles.empty }, '该卡片已不存在')]
        : visibleItems.map((item: MemoryItem) => {
        const busy = item.status === 'under_review' || item.status === 'debating'
        const human = item.status === 'human_intervention'
        const speculative = item.status === 'speculative'
        const staged = item.status === 'staged' || item.status === 'suggested'
        const isDetail = detailId === item.id
        const isExpanded = isDetail || expanded[item.id] === true

        const cardStyle = human
          ? {
            ...memoryStyles.card,
            borderColor: '#d92d20',
            borderWidth: '2px',
            backgroundColor: 'rgba(217, 45, 32, 0.10)',
            animationName: 'dshMemoryBreathe',
            animationDuration: '2.4s',
            animationTimingFunction: 'ease-in-out',
            animationIterationCount: 'infinite',
          }
          : item.type === 'extraction_strategy'
            ? {
              ...memoryStyles.card,
              borderColor: item.rule === true ? '#0891b2' : '#0e7490',
              ...(item.rule === true ? { borderWidth: '2px' } : {}),
              backgroundColor: item.status === 'approved'
                ? 'rgba(8, 145, 178, 0.06)'
                : 'rgba(8, 145, 178, 0.12)',
            }
            : staged
              ? {
                ...memoryStyles.card,
                borderColor: '#d97706',
                backgroundColor: 'rgba(217, 119, 6, 0.10)',
              }
              : item.status === 'rejected'
              ? { ...memoryStyles.card, opacity: 0.65 }
              : speculative
                ? {
                  ...memoryStyles.card,
                  borderColor: '#2563eb',
                  ...(item.type === 'meta_insight'
                    ? { borderLeftColor: '#9333ea', borderLeftWidth: '3px' }
                    : {}),
                  backgroundColor: 'rgba(37, 99, 235, 0.08)',
                }
                : item.type === 'meta_insight'
                  ? {
                    ...memoryStyles.card,
                    borderColor: '#9333ea',
                    backgroundColor: 'rgba(147, 51, 234, 0.07)',
                  }
                  : busy
                    ? {
                      ...memoryStyles.card,
                      borderColor: '#2563eb',
                      backgroundColor: 'rgba(37, 99, 235, 0.08)',
                    }
                    : item.type === 'skill_error_fix'
                      ? {
                        ...memoryStyles.card,
                        borderColor: '#d97706',
                        backgroundColor: item.status === 'approved'
                          ? 'rgba(21, 128, 61, 0.06)'
                          : 'rgba(249, 115, 22, 0.12)',
                      }
                      : item.type === 'conflict'
                        ? {
                          ...memoryStyles.card,
                          borderColor: '#d92d20',
                          backgroundColor: item.status === 'approved'
                            ? 'rgba(21, 128, 61, 0.06)'
                            : 'rgba(220, 38, 38, 0.08)',
                        }
                        : memoryStyles.card

        const statusStyle = human
          ? memoryStyles.statusDanger
          : busy
            ? memoryStyles.statusReview
            : item.status === 'rejected'
              ? memoryStyles.statusRejected
              : speculative
                ? memoryStyles.badgeSpeculative
                : item.status === 'approved'
                  ? memoryStyles.statusApproved
                  : memoryStyles.statusSuggested

        return h('div', { key: item.id, style: { ...cardStyle, ...CARD_DENSITY[density as keyof typeof CARD_DENSITY] } }, [
          h('div', { key: 'main', style: memoryStyles.itemMain }, [
            h('div', { key: 'provenance', style: memoryStyles.provenance },
              `创建 ${formatMemoryTime(item.createdAt)} · 来源 ${originLabel(item.origin)}${item.discipline === undefined ? '' : ` · ${item.discipline}`} · ${perceptionLabel(item)}`),
            h('div', {
              key: 'content',
              style: isExpanded
                ? { ...memoryStyles.content, fontSize: CARD_DENSITY[density as keyof typeof CARD_DENSITY].fontSize }
                : { ...memoryStyles.content, ...memoryStyles.contentClamp, fontSize: CARD_DENSITY[density as keyof typeof CARD_DENSITY].fontSize },
            }, item.content),
            item.type === 'extraction_strategy'
              ? h('div', { key: 'strategy-brief', style: memoryStyles.strategyBrief }, [
                item.rule === true
                  ? '跨域映射法则'
                  : item.strategyStage === 'small'
                    ? '小提炼反思'
                    : item.strategyStage === 'large' ? '大提炼反思' : '提炼策略',
                item.thinkingModel === undefined ? '' : ` · ${item.thinkingModel}`,
                ` · 成功 ${item.successCount ?? 0} 次 / 被注入 ${item.appliedCount ?? 0} 次`,
              ].join(''))
              : null,
            activeTab === 'audit'
              ? (() => {
                const verdict = auditItem(item)
                return h('div', { key: 'audit', style: memoryStyles.auditBox }, [
                  h('div', { key: 'badges', style: memoryStyles.auditBadges }, [
                    h('span', {
                      key: 'durability',
                      style: verdict.durability === 'long-term' ? memoryStyles.auditLong : memoryStyles.auditTemp,
                    }, verdict.durability === 'long-term' ? '长期' : '临时'),
                    h('span', {
                      key: 'necessity',
                      style: verdict.necessity === 'needed'
                        ? memoryStyles.auditNeeded
                        : verdict.necessity === 'unneeded' ? memoryStyles.auditUnneeded : memoryStyles.auditUncertain,
                    }, verdict.necessity === 'needed' ? '需要' : verdict.necessity === 'unneeded' ? '可清理' : '待判断'),
                  ]),
                  h('div', { key: 'reason', style: memoryStyles.auditReason }, verdict.reason),
                ])
              })()
              : null,
            isDetail
              ? null
              : h('button', {
                key: 'detail-link',
                type: 'button',
                style: memoryStyles.detailLink,
                onClick: () => setDetailId(item.id),
              }, '详情 →'),
            isExpanded && item.type === 'skill_error_fix'
              ? h('div', { key: 'detail', style: memoryStyles.detail }, [
                item.errorSignature !== undefined ? `错误：${item.errorSignature}` : null,
                item.context !== undefined ? `上下文：${item.context}` : null,
              ].filter(Boolean).join('\n'))
              : null,
            isExpanded && isMetaItem(item)
              ? h('div', { key: 'speculative', style: memoryStyles.detail }, [
                `学科：${item.discipline ?? '未标注'}`,
                item.topic !== undefined ? `话题：${item.topic}` : null,
              ].filter(Boolean).join('\n'))
              : null,
            isExpanded && item.type === 'extraction_strategy'
              ? h('div', { key: 'strategy-detail', style: memoryStyles.detail }, [
                item.thinkingModel !== undefined ? `思维模型：${item.thinkingModel}` : null,
                item.analogyReason !== undefined ? `类比理由：${item.analogyReason}` : null,
                item.effectiveFor !== undefined ? `最适用于：${item.effectiveFor}` : null,
                `成功 ${item.successCount ?? 0} 次 · 被注入 ${item.appliedCount ?? 0} 次${item.lastAppliedAt === undefined ? '' : ` · 最近 ${formatMemoryTime(item.lastAppliedAt)}`}`,
                item.rule === true
                  ? '类型：跨域映射法则（由多条策略融合产生，人类裁决后以最高优先级注入）'
                  : item.strategyStage === 'small'
                    ? '来源环节：小提炼（四段式审阅/辩论）'
                    : item.strategyStage === 'large'
                      ? '来源环节：大提炼（睡眠巩固）'
                      : '来源环节：未标注',
                item.mergedFrom !== undefined && item.mergedFrom.length > 0
                  ? `融合来源：${item.mergedFrom.length} 条策略`
                  : null,
                item.confidence === undefined
                  ? null
                  : `模型自评置信度：${Math.round(item.confidence * 100)}%`,
              ].filter(Boolean).join('\n'))
              : null,
            isExpanded && item.trace !== undefined && item.trace.length > 0
              ? h('div', { key: 'trace', style: memoryStyles.traceBox }, [
                h('div', { key: 'title', style: memoryStyles.traceTitle }, '提炼过程'),
                ...item.trace.map((step, index) => h('div', {
                  key: `trace-${index}`,
                  style: memoryStyles.traceStep,
                }, `${index + 1}. ${step}`)),
              ])
              : null,
            isExpanded && item.type === 'skill_error_fix'
              ? h('div', { key: 'timeline', style: memoryStyles.timeline },
                buildTimeline(item).map(node => h('div', { key: node.key, style: memoryStyles.timelineRow }, [
                  h('div', { key: 'rail', style: memoryStyles.timelineRail }, [
                    h('span', {
                      key: 'dot',
                      style: node.tone !== undefined
                        ? { ...memoryStyles.timelineDot, background: node.tone }
                        : memoryStyles.timelineDot,
                    }),
                  ]),
                  h('div', { key: 'copy', style: memoryStyles.timelineCopy }, [
                    h('div', {
                      key: 'title',
                      style: node.tone !== undefined
                        ? { ...memoryStyles.timelineTitle, color: node.tone }
                        : memoryStyles.timelineTitle,
                    }, node.title),
                    h('div', { key: 'text', style: memoryStyles.timelineText }, node.text),
                  ]),
                ])))
              : null,
            isExpanded && item.type === 'skill_error_fix' && hasDebateRecord(item)
              ? h('div', { key: 'debate-space', style: memoryStyles.debateSpace }, [
                h('div', { key: 'head', style: memoryStyles.debateHead }, [
                  h('span', { key: 'title', style: memoryStyles.debateSpaceTitle }, '辩论空间'),
                  h('span', { key: 'round', style: memoryStyles.debateRoundTag },
                    `第 ${item.reviewRound ?? 1} 轮 · 子 ⇄ 母 · 同模型模拟`),
                ]),
                h('div', { key: 'origin', style: memoryStyles.debateOrigin }, [
                  h('div', { key: 'why' }, `辩题：${item.errorSignature ?? item.content}`),
                  h('div', { key: 'review' }, `母 Agent 驳回：${item.reviewReason ?? '未记录'}`),
                  h('div', { key: 'challenge' }, `子 Agent 反驳：${item.challenge ?? '未记录'}`),
                  h('div', { key: 'resolution' }, `AI 建议：${item.resolution ?? '尚未给出最终解决办法'}`),
                  h('div', { key: 'source' }, `任务来源：${item.context ?? '未记录任务上下文'}`),
                ]),
                buildDebateBubbles(item).length === 0
                  ? h('div', { key: 'no-rounds', style: memoryStyles.debateLegacy },
                    '该条目没有生成逐轮发言记录。')
                  : h('div', { key: 'rounds', style: memoryStyles.debateRounds },
                    buildDebateBubbles(item).map((round, index) => h('div', {
                      key: `bubble-${index}`,
                      style: round.role === 'child' ? memoryStyles.debateRowChild : memoryStyles.debateRowMother,
                    }, [
                      h('span', {
                        key: 'speaker',
                        style: round.role === 'child' ? memoryStyles.debateSpeakerChild : memoryStyles.debateSpeakerMother,
                      }, round.role === 'child' ? '子 Agent' : '母 Agent'),
                      h('div', {
                        key: 'bubble',
                        style: round.role === 'child' ? memoryStyles.debateBubbleChild : memoryStyles.debateBubbleMother,
                      }, round.content),
                    ]))),
                item.status === 'debating'
                  ? h('div', { key: 'typing', style: memoryStyles.debateTyping }, '母 Agent 正在回应…')
                  : null,
                (item.debateRounds === undefined || item.debateRounds.length === 0) && item.debateSummary !== undefined
                  ? h('div', { key: 'legacy', style: memoryStyles.debateLegacy },
                    `旧记录仅存摘要：${item.debateSummary}`)
                  : null,
                h('div', { key: 'note', style: memoryStyles.debateLegacy },
                  '说明：当前由同一模型分别扮演子/母 Agent，用于梳理反驳与风险，不等同于两个独立智能体。'),
                h('div', { key: 'verdict', style: memoryStyles.debateVerdict }, debateVerdictText(item)),
              ])
              : null,
            item.sources !== undefined && item.sources.length > 0 && isExpanded
              ? h('div', { key: 'sources', style: memoryStyles.sources },
                item.sources.slice(0, 8).map((source, index) => {
                  const safe = isSafeHttpUrl(source)
                  const domain = (() => {
                    try {
                      return new URL(source).hostname
                    } catch {
                      return ''
                    }
                  })()
                  return safe
                    ? h('a', {
                      key: `source-${index}`,
                      href: source,
                      target: '_blank',
                      rel: 'noreferrer',
                      style: memoryStyles.sourceLink,
                    }, domain === '' ? source : `${domain} · ${source}`)
                    : h('span', { key: `source-${index}`, style: memoryStyles.detail }, source)
                }))
              : null,
            item.type === 'skill_error_fix'
              ? h('div', { key: 'resolution' }, [
                h('div', { key: 'label', style: memoryStyles.resolutionLabel }, '解决办法'),
                h('textarea', {
                  key: 'input',
                  style: memoryStyles.resolutionInput,
                  rows: 3,
                  value: draftOf(item),
                  disabled: busy,
                  placeholder: '例如：检查路径是否存在，修正路径后重试',
                  onChange: (event: { target: { value: string } }) => {
                    const value = event.target.value
                    setDrafts((previous: Record<string, string>) => ({ ...previous, [item.id]: value }))
                  },
                }),
                draftOf(item).trim() === ''
                  ? h('div', { key: 'helper', style: memoryStyles.helper }, '尚未记录解决办法，请补充后确认')
                  : null,
              ])
              : null,
            h('div', { key: 'meta', style: memoryStyles.meta }, [
              h('span', {
                key: 'type',
                style: item.type === 'meta_insight'
                  ? memoryStyles.badgeMeta
                  : item.type === 'speculative' ? memoryStyles.badgeSpeculative : memoryStyles.badge,
              }, memoryTypeLabel(item.type)),
              h('span', { key: 'status', style: statusStyle }, memoryStatusLabel(item.status)),
              item.discipline !== undefined
                ? h('span', { key: 'discipline', style: memoryStyles.badgeSpeculative }, item.discipline)
                : null,
              memorySalience(item) >= 0.8
                ? h('span', { key: 'salience', style: memoryStyles.badgeSpeculative }, '⚠️ 致命红线')
                : memorySalience(item) >= 0.55
                  ? h('span', { key: 'salience', style: memoryStyles.badge }, '高显著')
                  : null,
              busy ? h('span', { key: 'loader', style: memoryStyles.loader }, '思考中…') : null,
              h('span', { key: 'time' }, formatMemoryTime(item.createdAt)),
            ]),
          ]),
          h('div', { key: 'actions', style: memoryStyles.actions }, [
            item.type === 'skill_error_fix' && activeTab !== 'debate' && hasDebateRecord(item)
              ? h('button', {
                key: 'goto-debate',
                type: 'button',
                style: memoryStyles.save,
                onClick: () => {
                  setActiveTab('debate')
                  setDetailId(item.id)
                },
              }, '去辩论空间')
              : null,
            item.type === 'skill_error_fix' && activeTab !== 'human' && human
              ? h('button', {
                key: 'goto-human',
                type: 'button',
                style: memoryStyles.humanAdopt,
                onClick: () => {
                  setActiveTab('human')
                  setExpanded((previous: Record<string, boolean>) => ({ ...previous, [item.id]: true }))
                },
              }, '去人类裁决')
              : null,
            human
              ? h('button', {
                key: 'arbitrate',
                type: 'button',
                style: memoryStyles.save,
                disabled: humanDeciding !== null || arbitrating !== null,
                title: '最多检索 3 个网页；仍不收敛则保持待人类圣裁',
                onClick: () => { void arbitrate(item.id) },
              }, arbitrating === item.id ? '检索中…' : '🔎 再查证据')
              : null,
            human
              ? h('button', {
                key: 'adopt',
                type: 'button',
                style: memoryStyles.humanAdopt,
                disabled: humanDeciding !== null,
                onClick: () => { void humanDecide(item.id, 'adopt') },
              }, humanDeciding === `${item.id}:adopt` ? '采纳中…' : '⚖️ 强制采纳')
              : null,
            human
              ? h('button', {
                key: 'discard',
                type: 'button',
                style: memoryStyles.humanDiscard,
                disabled: humanDeciding !== null,
                onClick: () => { void humanDecide(item.id, 'discard') },
              }, humanDeciding === `${item.id}:discard` ? '驳回中…' : '🗑️ 强制驳回')
              : null,
            busy
              ? h('button', {
                key: 'thinking',
                type: 'button',
                style: memoryStyles.save,
                disabled: true,
              }, '思考中…')
              : null,
            item.type === 'skill_error_fix' && !busy && item.status !== 'rejected'
              && draftOf(item).trim() !== ''
              && draftOf(item).trim() !== (item.resolution ?? '')
              ? h('button', {
                key: 'save-resolution',
                type: 'button',
                style: memoryStyles.save,
                disabled: saving === item.id,
                onClick: () => { void saveOnly(item) },
              }, saving === item.id ? '保存中…' : '保存解决办法')
              : null,
            !human && !busy && (staged || speculative)
              ? h('button', {
                key: 'approve',
                type: 'button',
                style: memoryStyles.approve,
                disabled: approving === item.id || saving === item.id,
                onClick: () => { void approveItem(item) },
              }, approving === item.id ? '批准中…' : '批准生效')
              : null,
            !human && !busy && (staged || speculative)
              ? h('button', {
                key: 'discard',
                type: 'button',
                style: memoryStyles.delete,
                disabled: deleting === item.id,
                onClick: () => { void remove(item) },
              }, deleting === item.id ? '丢弃中…' : '丢弃')
              : null,
            (item.status === 'approved' || item.status === 'rejected')
              ? h('button', {
                key: 'delete',
                type: 'button',
                style: memoryStyles.delete,
                disabled: deleting === item.id,
                onClick: () => { void remove(item) },
              }, deleting === item.id ? '删除中…' : '删除')
              : null,
          ]),
        ])
      }),
    ) : null,
  ])
}

/** Client 上下文的最小结构。 */
export interface ClientContext {
  effect(callback: () => () => void): unknown
  slots: {
    inject(name: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
}

/**
 * 注册 clarify dock、侧边栏“记忆”入口、主面板页面和设置页“记忆管理”。
 * 所有注册都由 ctx.effect 清理；单个失败不影响其他入口。
 */
export function apply(ctx: ClientContext): void {
  try {
    ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'clarify',
      order: 30,
    }, ClarifyDock)))
  } catch (error) {
    console.error('[dsh-evolution-flywheel] clarify client initialization failed:', error)
  }

  try {
    ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: MEMORY_PANEL_ID,
    }, MemoryExplorerPage)))
  } catch (error) {
    console.error('[dsh-evolution-flywheel] memory page registration failed:', error)
  }

  try {
    ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: MEMORY_PANEL_ID,
      order: 20,
      label: () => '记忆',
    }, MemoryExplorerIcon)))
  } catch (error) {
    console.error('[dsh-evolution-flywheel] memory sidebar registration failed:', error)
  }

  try {
    ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: MEMORY_SETTINGS_ID,
      order: 17,
      label: () => '记忆管理',
    }, MemoryExplorerPage)))
  } catch (error) {
    console.error('[dsh-evolution-flywheel] memory settings registration failed:', error)
  }
}

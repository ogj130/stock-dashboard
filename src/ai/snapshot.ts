/**
 * 分析上下文的形状与校验。
 *
 * 原则：**只把界面上已经算好的事实给模型**。前端发什么、这里认什么，
 * 服务器不重新估值——否则「AI 说的数字」和「界面上的数字」会来自两条链路，
 * 一旦有差就再也对不齐。
 *
 * 校验不是防黑客（本机服务、请求就来自自己的页面），是防「把一堆没算完的
 * undefined 喂给模型」：字段缺失时宁可直接报 400，也不要让模型自由发挥。
 */

export type Phase = 'pre' | 'live' | 'settled'

export interface SnapshotFund {
  code: string
  name: string
  marketValue: number
  amount: number
  pct: number
  holdingProfit: number
  /** 0~1；0 = 这只今天没有可用行情 */
  coveredWeight: number
  board: string | null
  /** 官方净值日（估算锚点） */
  navDate: string | null
  /** 净值日之后已经补了几场 */
  sessionsSinceNav: number
}

export interface SnapshotStock {
  symbol: string
  name: string
  weightPct: number
  pct: number
  /** 这批个股涨跌属于哪个时段（盘前时是「上一交易日收盘」） */
  asOf: string
}

export interface SnapshotNews {
  title: string
  tsMs: number
  important: boolean
  /** 标题命中的持仓 symbol（前端算好，模型不用自己猜） */
  related: string[]
}

export interface AnalysisSnapshot {
  phase: Phase
  /** 分析请求时刻（epoch ms） */
  atMs: number
  /** 时间上下文：北京/美东、阶段、以及「哪些数据属于上一场」 */
  clock: { local: string; et: string; session: string; note: string }
  totalValue: number
  totalAmount: number
  totalAmountPct: number | null
  totalHoldingProfit: number
  totalHoldingPct: number | null
  fx: { pair: string; rate: number; pct: number } | null
  indices: Array<{ name: string; pct: number; asOf: string }>
  /** 按跟踪指数聚合的板块权重 */
  boards: Array<{ name: string; weightPct: number }>
  funds: SnapshotFund[]
  stocks: SnapshotStock[]
  news: SnapshotNews[]
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

function num(v: unknown, fallback = 0): number {
  return isNum(v) ? v : fallback
}

function str(v: unknown, max: number): string {
  return isStr(v) ? v.trim().slice(0, max) : ''
}

export interface ParseResult {
  snapshot?: AnalysisSnapshot
  error?: string
}

/**
 * 宽松类型 + 严格边界：数字必须是有限数、字符串截断、数组截断。
 * `phase` 非法直接拒绝——它决定提示词里「今天 / 盘前 / 已收盘」的说法。
 */
export function parseSnapshot(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null) return { error: '快照必须是对象' }
  const raw = input as Record<string, unknown>
  if (raw.phase !== 'pre' && raw.phase !== 'live' && raw.phase !== 'settled') {
    return { error: 'phase 非法' }
  }

  const fundsRaw = Array.isArray(raw.funds) ? raw.funds.slice(0, 40) : []
  const funds: SnapshotFund[] = []
  for (const item of fundsRaw) {
    if (typeof item !== 'object' || item === null) continue
    const f = item as Record<string, unknown>
    const code = str(f.code, 12)
    if (code === '') continue
    funds.push({
      code,
      name: str(f.name, 40) || code,
      marketValue: num(f.marketValue),
      amount: num(f.amount),
      pct: num(f.pct),
      holdingProfit: num(f.holdingProfit),
      coveredWeight: Math.min(1, Math.max(0, num(f.coveredWeight))),
      board: str(f.board, 20) || null,
      navDate: str(f.navDate, 12) || null,
      sessionsSinceNav: Math.max(0, Math.round(num(f.sessionsSinceNav))),
    })
  }
  if (funds.length === 0) return { error: '没有任何基金数据' }

  const stocksRaw = Array.isArray(raw.stocks) ? raw.stocks.slice(0, 12) : []
  const stocks: SnapshotStock[] = []
  for (const item of stocksRaw) {
    if (typeof item !== 'object' || item === null) continue
    const s = item as Record<string, unknown>
    const symbol = str(s.symbol, 10)
    if (symbol === '') continue
    stocks.push({
      symbol,
      name: str(s.name, 30) || symbol,
      weightPct: num(s.weightPct),
      pct: num(s.pct),
      asOf: str(s.asOf, 20) || '未知',
    })
  }

  const newsRaw = Array.isArray(raw.news) ? raw.news.slice(0, 8) : []
  const news: SnapshotNews[] = []
  for (const item of newsRaw) {
    if (typeof item !== 'object' || item === null) continue
    const n = item as Record<string, unknown>
    const title = str(n.title, 120)
    if (title === '') continue
    const related = Array.isArray(n.related)
      ? n.related.filter((item): item is string => typeof item === 'string').slice(0, 6).map((item) => item.slice(0, 10))
      : []
    news.push({ title, tsMs: num(n.tsMs), important: n.important === true, related })
  }

  const indicesRaw = Array.isArray(raw.indices) ? raw.indices.slice(0, 6) : []
  const indices = indicesRaw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({ name: str(item.name, 20), pct: num(item.pct), asOf: str(item.asOf, 20) || '未知' }))
    .filter((item) => item.name !== '')

  const fxRaw = raw.fx
  const fx =
    typeof fxRaw === 'object' && fxRaw !== null
      ? {
          pair: str((fxRaw as Record<string, unknown>).pair, 12) || 'USD/CNY',
          rate: num((fxRaw as Record<string, unknown>).rate),
          pct: num((fxRaw as Record<string, unknown>).pct),
        }
      : null

  const totalAmountPct = isNum(raw.totalAmountPct) ? raw.totalAmountPct : null
  const totalHoldingPct = isNum(raw.totalHoldingPct) ? raw.totalHoldingPct : null

  const boardsRaw = Array.isArray(raw.boards) ? raw.boards.slice(0, 8) : []
  const boards = boardsRaw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({ name: str(item.name, 20), weightPct: num(item.weightPct) }))
    .filter((item) => item.name !== '')

  const clockRaw = typeof raw.clock === 'object' && raw.clock !== null ? (raw.clock as Record<string, unknown>) : {}
  const clock = {
    local: str(clockRaw.local, 30) || '未知',
    et: str(clockRaw.et, 30) || '未知',
    session: str(clockRaw.session, 40) || '未知',
    note: str(clockRaw.note, 200) || '',
  }

  return {
    snapshot: {
      phase: raw.phase,
      atMs: isNum(raw.atMs) ? raw.atMs : Date.now(),
      clock,
      totalValue: num(raw.totalValue),
      totalAmount: num(raw.totalAmount),
      totalAmountPct,
      totalHoldingProfit: num(raw.totalHoldingProfit),
      totalHoldingPct,
      fx,
      indices,
      boards,
      funds,
      stocks,
      news,
    },
  }
}

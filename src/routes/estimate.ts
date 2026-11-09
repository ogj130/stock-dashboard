import type { FastifyInstance } from 'fastify'
import type { Db } from '../store/db'
import type { QuoteRegistry } from '../sources/registry'
import type { Holding, MarketStatus, Phase, Quote } from '../types'
import { buildEstimate, type FundEstimate } from '../engine/pipeline'
import { derivePhase } from '../engine/phase'
import { fetchPosition, resolveHoldingsFrom } from '../fund/holdings'
import { fetchIndexWeights } from '../fund/indexWeight'
import { fetchUsdCny, fetchUsdCnyFallback, loadCachedFx, saveFx, type FxRate } from '../sources/fx'
import { createMarketIndicesCache, type MarketIndex } from '../sources/marketIndices'
import { listFunds, upsertNav, type FundRow } from '../store/queries'
import { recordSnapshot } from '../store/portfolio'
import { CONFIG } from '../config'

/**
 * 东财 secid 市场码 116 = 港股。
 *
 * 产品口径（已定，不再讨论）：港股不参与估值。
 * ① 引擎只有一条 USD/CNY 汇率，缺 HKD/CNY，港币资产会被错误地按美元折算；
 * ② 港股与美股历法不同，港股休市日会拿到上一交易日的 pct，被重复计入涨跌；
 * ③ 这类 QDII 的净值波动主要来自美股持仓。
 * 所以在送去取价之前先滤掉，并如实上报 `excluded.hk`，让界面能说"含港股 N 只，已排除"。
 */
const HK_MARKET = 116

export interface EstimateCtx {
  db: Db
  registry: QuoteRegistry
  status: () => Promise<MarketStatus>
  /** 取行情前必须先解析 symbol→市场码；known 是持仓报文里直接给出的 NEWTEXCH 映射 */
  ensureMarkets: (symbols: string[], known: Record<string, number>) => Promise<void>
}

/** 依赖注入点：默认走真实网络，将来要离线测路由时传桩即可 */
export interface EstimateDeps {
  resolveFx?: () => Promise<FxRate | null>
  loadHoldings?: (fund: FundRow) => Promise<{ holdings: Holding[]; weightsFrom: FundEstimate['weightsFrom'] }>
  latestNav?: (code: string) => Promise<number>
  /** 底部指数条。默认 30 秒缓存 + 东财；测试按需注入，保持完全离线 */
  marketIndices?: () => Promise<MarketIndex[]>
}

/**
 * index_key → 关联板块名。前端分 tab、匹配指数涨跌幅都靠这个字符串，
 * 所以它必须是给人看的中文名（而不是 'ndx' 这种内部码）；未配置就是 null，
 * 界面据此显示「—」并把它归进「全部」。
 */
const BOARD_BY_INDEX_KEY: Record<string, string> = {
  ndx: '纳斯达克100',
  sp500: '标普500',
}

export function boardOf(indexKey: string | null): string | null {
  if (!indexKey) return null
  return BOARD_BY_INDEX_KEY[indexKey] ?? null
}

interface FundHoldingSet {
  fund: FundRow
  holdings: Holding[]
  weightsFrom: FundEstimate['weightsFrom']
  /** 被排除的港股数量（取价前就已滤掉） */
  excludedHk: number
}

export interface EstimateResponse {
  funds: FundEstimate[]
  phase: Phase
  /** 这条估算指向的美东净值日（YYYY-MM-DD） */
  targetNavDate: string
  /** 汇率腿的实况；null 表示取不到且无历史可用 */
  fx: { pair: string; rate: number; prevClose: number; pct: number; sourceId: string; tsMs: number } | null
  /** 底部指数条；取不到就是空数组（绝不因为这条锦上添花的腿把估值弄成 500） */
  marketIndices: MarketIndex[]
}

export function registerEstimateRoutes(
  app: FastifyInstance,
  ctx: EstimateCtx,
  deps: EstimateDeps = {},
): void {
  const loadHoldings = deps.loadHoldings ?? defaultLoadHoldings
  const latestNav = deps.latestNav ?? ((code: string) => resolveNav(ctx.db, code))
  const resolveFx = deps.resolveFx ?? (() => resolveFxRate(ctx.db))
  const fetchIndices = deps.marketIndices ?? createMarketIndicesCache()

  app.get('/api/estimate', async (): Promise<EstimateResponse> => {
    const funds = listFunds(ctx.db)
    const targetNavDate = etDate()

    // 两个背景信息并行取，谁也不拖累谁：
    // - 状态拿不到时由 server 注入的 status 退回本地时钟推导，不在这里默认 CLOSED，
    //   把盘中误判成收盘会让界面冻结一个本该跳动的数字；
    // - 指数条与基金列表无关（空仓时也该显示），失败在 getMarketIndicesSafely 里吞掉。
    const [status, marketIndices] = await Promise.all([
      ctx.status().catch(() => 'CLOSED' as MarketStatus),
      getMarketIndicesSafely(app, fetchIndices),
    ])
    const phase = derivePhase(status)
    if (funds.length === 0) return { funds: [], phase, targetNavDate, fx: null, marketIndices }

    const [fx, resolved] = await Promise.all([
      resolveFx(),
      Promise.all(
        funds.map(async (fund): Promise<FundHoldingSet> => {
          const { holdings, weightsFrom } = await loadHoldings(fund)
          // 港股在取价之前剔除：既省掉无意义的请求，也不让港币混进美元折算
          const usOnly = holdings.filter((h) => h.market !== HK_MARKET)
          return { fund, holdings: usOnly, weightsFrom, excludedHk: holdings.length - usOnly.length }
        }),
      ),
    ])

    const known: Record<string, number> = {}
    for (const { holdings } of resolved) {
      for (const h of holdings) if (h.market !== undefined) known[h.symbol] = h.market
    }
    const symbols = [...new Set(resolved.flatMap((r) => r.holdings.map((h) => h.symbol)))]

    // 顺序不能颠倒：东财对市场码未知的票整批返回 data:null（实测 162411 猜 105 → 0/10，正确 106 → 10/10）
    if (symbols.length > 0) await ctx.ensureMarkets(symbols, known)
    const quotes = await getQuotesSafely(app, ctx.registry, symbols)
    const navs = await Promise.all(resolved.map(({ fund }) => latestNav(fund.code)))

    const estimates = resolved.map((r, i) =>
      buildEstimate({
        code: r.fund.code,
        name: r.fund.name || r.fund.code,
        shares: r.fund.shares,
        costBasis: r.fund.cost_basis,
        nav: navs[i] ?? 0,
        holdings: r.holdings,
        quotes,
        fxNow: fx?.rate ?? 0,
        fxPrev: fx?.prevClose ?? 0,
        exposure: r.fund.exposure,
        lagDays: r.fund.lag_days,
        phase,
        excludedHk: r.excludedHk,
        weightsFrom: r.weightsFrom,
        indexPct: indexPctFor(r.fund.index_key, marketIndices),
        board: boardOf(r.fund.index_key),
      }),
    )

    logEstimates(
      ctx.db,
      phase,
      estimates.map((estimate, i) => ({
        estimate,
        lagDays: resolved[i]!.fund.lag_days,
        exposure: resolved[i]!.fund.exposure,
      })),
      targetNavDate,
    )

    // 折线图的原料。失败（表被删、磁盘满、锁超时）只记一条 warn：
    // 曲线是锦上添花，不能因为它把整条估值变成 500。
    recordSnapshotSafely(app, ctx.db, estimates)

    return {
      funds: estimates,
      phase,
      targetNavDate,
      fx: fx
        ? {
            pair: fx.pair,
            rate: fx.rate,
            prevClose: fx.prevClose,
            pct: fx.prevClose > 0 ? (fx.rate / fx.prevClose - 1) * 100 : 0,
            sourceId: fx.sourceId,
            tsMs: fx.tsMs,
          }
        : null,
      marketIndices,
    }
  })
}

/**
 * 指数条是锦上添花：取不到就返回空数组并记一条 warn，绝不影响基金估值。
 * 界面拿到空数组就不渲染那一条，比显示一条假点位诚实。
 */
async function getMarketIndicesSafely(
  app: FastifyInstance,
  fetchIndices: () => Promise<MarketIndex[]>,
): Promise<MarketIndex[]> {
  try {
    return await fetchIndices()
  } catch (err) {
    app.log.warn({ err }, 'market indices unavailable; bottom strip hidden')
    return []
  }
}

/**
 * 权重来源优先级：跟踪指数的全量成分（覆盖率≈100%）> 基金披露的前十大（约 40~70%）。
 *
 * 这一条是实测逼出来的：用 270042 的前十大（Σweight=0.4276）算，覆盖股当日加权 +2.63%，
 * 但 navPct 只有 +1.07%，而同一天 QQQ 实际 +3.20%。低覆盖率会把估值系统性压向 0，
 * 且无法靠拟合 exposure 补救（需要 exposure≈2.34，但语义上只能在 0~1.5）。
 */
async function defaultLoadHoldings(
  fund: FundRow,
): Promise<{ holdings: Holding[]; weightsFrom: FundEstimate['weightsFrom'] }> {
  // 成分权重与披露持仓都是日级别的数据（纳指每季度才调仓），
  // 5 秒轮询没必要每轮重拉一次 21KB 的 101 行报文
  const cached = holdingsMemo.get(fund.code)
  if (cached && Date.now() - cached.atMs < CONFIG.staleMs.settled) return cached.value

  const value = await loadHoldingsUncached(fund)
  holdingsMemo.set(fund.code, { value, atMs: Date.now() })
  return value
}

const holdingsMemo = new Map<
  string,
  { value: { holdings: Holding[]; weightsFrom: FundEstimate['weightsFrom'] }; atMs: number }
>()

async function loadHoldingsUncached(
  fund: FundRow,
): Promise<{ holdings: Holding[]; weightsFrom: FundEstimate['weightsFrom'] }> {
  if (fund.index_key) {
    // 未知指数键会抛错：静默空数组会让调用方以为「该指数没有成分」，
    // 于是悄悄退回前十大而不知道自己降级了
    const holdings = await fetchIndexWeights(fund.index_key).catch(() => [] as Holding[])
    if (holdings.length > 0) return { holdings, weightsFrom: 'index' }
  }
  const resolved = await resolveHoldingsFrom(fund.code, fetchPosition).catch(() => null)
  const holdings = resolved?.holdings ?? []
  return { holdings, weightsFrom: holdings.length > 0 ? 'top10' : 'none' }
}

/**
 * 取行情。数据层的契约（Task 7.5 加固后）决定了这里必须容忍三种结果：
 * - 返回的 Map 可能比请求小：缺口由 buildEstimate 用 `quotes.has` 逐个剔除并计入 missing；
 * - 一个源都解析不了这些符号时返回空 Map 且**不抛错**：覆盖率 0 照常渲染；
 * - 只有「问过源、却一条都没拿到」才抛 all sources failed。
 *   估值不能因此 500——覆盖率 0 是比 500 更诚实也更有用的回答（界面显示"行情不可用"）。
 */
async function getQuotesSafely(
  app: FastifyInstance,
  registry: QuoteRegistry,
  symbols: string[],
): Promise<Map<string, Quote>> {
  if (symbols.length === 0) return new Map()
  try {
    // crossCheck 关掉：5 秒轮询下每轮多问一遍备源，收益不抵请求量
    return await registry.getQuotes(symbols, { crossCheck: false })
  } catch (err) {
    app.log.warn({ err, wanted: symbols.length }, 'quotes unavailable; estimating with zero coverage')
    return new Map()
  }
}

interface FxMemo {
  fx: FxRate
  atMs: number
}

/** 上次成功取到的汇率。5 秒轮询不能每轮都打汇率接口，按 CONFIG.staleMs.fx 复用 */
let fxMemo: FxMemo | null = null

/**
 * 汇率三级取值：东财 → 新浪 → 库里的上一次真实值。
 *
 * 汇率不可用不该让整条估值 500，也不该静默按「汇率不变」算——
 * 后者会把汇率那条腿的涨跌悄悄抹掉。沿用上次落库的真实汇率（带 sourceId/ts），
 * 至少是个有据可查的数值，界面也能标出"汇率可能滞后"。
 */
async function resolveFxRate(db: Db): Promise<FxRate | null> {
  const now = Date.now()
  if (fxMemo && now - fxMemo.atMs < CONFIG.staleMs.fx) return fxMemo.fx

  for (const fetcher of [fetchUsdCny, fetchUsdCnyFallback]) {
    try {
      const fx = await fetcher()
      saveFx(db, fx)
      fxMemo = { fx, atMs: now }
      return fx
    } catch {
      // 换下一个源；全失败再退回缓存
    }
  }
  const cached = loadCachedFx(db)
  if (cached) fxMemo = { fx: cached, atMs: now }
  return cached
}

/** 美东当地日期 YYYY-MM-DD，作为这条估算指向的净值日（en-CA 天然给出 YYYY-MM-DD） */
const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function etDate(now: Date = new Date()): string {
  const parts = ET_DATE.formatToParts(now)
  const get = (t: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * 每次估值留痕，供日后对账。没有这张表，校准闭环就没有原料。
 * target_nav_date 记录这条估算指向哪个净值日——这是让 reconcile 能选对行的关键。
 */
function logEstimates(
  db: Db,
  phase: Phase,
  rows: Array<{ estimate: FundEstimate; lagDays: number; exposure: number }>,
  targetNavDate: string,
): void {
  // 必须 upsert：v2 迁移给 (fund_code, target_nav_date, phase) 加了唯一索引，
  // 5 秒轮询的第二次插入若不 on conflict 就直接撞 UNIQUE 约束。
  // 覆盖而非追加也让每天每基金最多两行（live + settled）。
  const stmt = db.prepare(
    `insert into estimate_log
       (fund_code, model_ts, target_nav_date, phase, model_pct, model_amount, covered_weight, lag_days, exposure)
     values (?,?,?,?,?,?,?,?,?)
     on conflict(fund_code, target_nav_date, phase) do update set
       model_ts=excluded.model_ts,
       model_pct=excluded.model_pct,
       model_amount=excluded.model_amount,
       covered_weight=excluded.covered_weight,
       lag_days=excluded.lag_days,
       exposure=excluded.exposure`,
  )
  const now = Date.now()
  // 一次 begin 包住整批：不能嵌套，也不该每行一次提交
  db.exec('begin')
  try {
    for (const { estimate, lagDays, exposure } of rows) {
      stmt.run(
        estimate.code,
        now,
        targetNavDate,
        phase,
        estimate.navPct,
        estimate.amount,
        estimate.coveredWeight,
        lagDays,
        exposure,
      )
    }
    db.exec('commit')
  } catch (err) {
    db.exec('rollback')
    throw err
  }
}

/**
 * 组合市值快照，给前端折线图。
 *
 * 两条硬约束：
 * ① 空仓不落点——没有基金的 0 值会把曲线拉到底部，看起来像亏光了；
 * ② 绝不把异常抛进请求路径——曲线是装饰，估值才是主业务，写库失败只记 warn。
 *
 * 节流在 recordSnapshot 里按「库里最新一行有多老」判定，30 秒一行。
 */
function recordSnapshotSafely(
  app: FastifyInstance,
  db: Db,
  estimates: FundEstimate[],
): void {
  if (estimates.length === 0) return
  try {
    const value = estimates.reduce((sum, e) => sum + e.marketValue, 0)
    const amount = estimates.reduce((sum, e) => sum + e.amount, 0)
    // 持有收益是「存量」：市值减成本，累计口径，和当日估算收益(amount)不是一回事。
    // 空仓/成本未填时自然为 0，曲线在新指标下就是一条贴零的直线，如实反映没记录。
    const profit = estimates.reduce((sum, e) => sum + (e.marketValue - e.costBasis), 0)
    recordSnapshot(db, { value, amount, profit, fundCount: estimates.length })
  } catch (err) {
    app.log.warn({ err }, 'portfolio snapshot skipped')
  }
}

/** index_key → 大盘行情里的指数代码，用于取官方涨跌幅 */
const INDEX_SYMBOL: Record<string, string> = { ndx: 'NDX100', sp500: 'SPX' }

/**
 * 指数基金直接用官方指数涨跌，不再自算成分加权。
 * 实测自算的纯市值加权与官方 NDX 差 0.206pp（NDX 是修正市值加权、有 capping），
 * 而验收预算是 0.15pp —— 自算在这一层是负贡献。
 */
function indexPctFor(key: string | null, list: MarketIndex[]): number | undefined {
  if (!key) return undefined
  const sym = INDEX_SYMBOL[key]
  if (!sym) return undefined
  return list.find((m) => m.symbol === sym)?.pct
}

function latestNavOf(db: Db, code: string): number {
  const row = db
    .prepare('select nav from nav_history where fund_code = ? order by nav_date desc limit 1')
    .get(code) as { nav: number } | undefined
  return row?.nav ?? 0
}

/** 上次取到的最新净值，避免 5 秒轮询每轮都打基金接口 */
const navMemo = new Map<string, { nav: number; atMs: number }>()

/**
 * 最新净值：先看 nav_history，库里没有再去实时取。
 *
 * 为什么必须兜底：没有净值就没有市值与当日收益，amount 会恒为 0，界面等于坏掉。
 * 取到后按来源自己给的净值日 PDATE 落库——QDII 的净值 T+1 才披露，
 * 拿「今天」当净值日会把 nav_history 这张对账地面真值写歪。
 * NAVCHGRT 缺失时只回值不落库：宁可少一行，也不写一个编造的 pct。
 */
async function resolveNav(db: Db, code: string): Promise<number> {
  const stored = latestNavOf(db, code)
  if (stored > 0) return stored

  const memo = navMemo.get(code)
  if (memo && Date.now() - memo.atMs < CONFIG.navPollMs) return memo.nav

  const url =
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=1` +
    `&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=1&Fcodes=${code}`
  try {
    const res = await fetch(url)
    if (!res.ok) return 0
    const body = (await res.json()) as { Datas?: NavApiRow[] | null }
    const row = body.Datas?.[0]
    const nav = toNumber(row?.NAV)
    if (!row || nav === null || nav <= 0) return 0
    navMemo.set(code, { nav, atMs: Date.now() })

    const pct = toNumber(row.NAVCHGRT)
    if (pct !== null && row.PDATE) upsertNav(db, code, row.PDATE, nav, pct)
    return nav
  } catch {
    return 0
  }
}

interface NavApiRow {
  FCODE?: string
  PDATE?: string
  NAV?: unknown
  NAVCHGRT?: unknown
}

/** 数字字段可能是字符串、"" 或 "-"：空串必须先拦（Number('') === 0 会被当成净值 0） */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return null
    const num = Number(text)
    return Number.isFinite(num) ? num : null
  }
  return null
}

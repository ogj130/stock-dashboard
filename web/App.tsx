import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import PortfolioChart, {
  DEFAULT_RANGE,
  isRangeKey,
  type HistoryResponse,
  type RangeKey,
} from './PortfolioChart'
import { afterHoursClock, summarizeAfterHours, type AfterHoursLite } from './afterHours'
import { money, pctFromDelta, pctText, signedMoney, tone } from './format'
import { weightChip, type WeightChipInput } from './weightChip'
import { preViewFunds } from './preView'

/**
 * 与 src/engine/pipeline.ts 的 FundEstimate 一一对应。
 * 只读不猜：界面上任何一个数字都必须来自 /api/estimate，不许自己造。
 */
interface Breakdown {
  symbol: string
  /** 中文简称（东财 f14），缺失时是英文公司名 */
  name: string
  weight: number
  pct: number
  contribution: number
}

type WeightsFrom = 'index' | 'top10' | 'none'

interface FundEstimate {
  code: string
  name: string
  phase: 'pre' | 'live' | 'settled'
  navPct: number
  nav: number
  shares: number
  costBasis: number
  marketValue: number
  amount: number
  holdingProfit: number
  coveredWeight: number
  holdingsCount: number
  lagDays: number
  weightsFrom: WeightsFrom
  /**
   * 官方指数涨跌幅是否真的拿到了。false 且 weightsFrom='index' 时说明
   * 「成分是指数口径、涨跌幅却是自算的」——方法论已经换了，必须让用户看见。
   */
  indexPctAvailable: boolean
  /**
   * 配了跟踪指数却拿不到成分权重，退回前十大。
   * 和 weightsFrom='top10' 且没有跟踪指数是两回事：那个要填配置，这个等重试。
   */
  indexWeightsUnavailable: boolean
  excluded: { hk: number }
  missing: string[]
  breakdown: Breakdown[]
  /** 关联板块（跟踪指数的中文名）；null 表示没配 index_key */
  board: string | null
  /** 官方净值日（口径锚点） */
  navDate: string | null
  /** 净值日之后已走完那几场的复合涨跌（%）；当前市值含这一段 */
  priorPct: number
  /** 滞后场次数；>0 说明官方净值还没跟上 */
  sessionsSinceNav: number
  /** 夜盘读数。没有盘后行情 / 覆盖率 < 30% / 非收盘相时后端根本不发这个键 */
  afterHours?: AfterHoursLite
  /**
   * 盘前读数（相对上一交易日收盘）。只有盘前相且拿到成交才有。
   * `basis` 说明这条数字的口径：index=用跟踪指数 ETF（QQQ/SPY），
   * constituents=成分加权（主动基金走这条）。
   */
  preMarket?: AfterHoursLite & {
    basis: 'index' | 'constituents'
    constituentPct?: number
  }
}

/** 对账结果（/api/accuracy）：判断"我们准不准"的唯一硬指标 */
interface AccuracyRow {
  code: string
  n: number
  mae: number
  bias: number
  suggestedExposure: number
}

interface AccuracyResponse {
  slot: number
  mae: number
  samples: number
  enough: boolean
  funds: AccuracyRow[]
}

interface FxLeg {
  pair: string
  rate: number
  prevClose: number
  pct: number
  sourceId: string
  tsMs: number
}

/** 底部指数条的一条；点位/涨跌点/涨跌幅都已由后端缩放好 */
interface MarketIndex {
  symbol: string
  name: string
  value: number
  change: number
  pct: number
}

interface EstimateResponse {
  funds: FundEstimate[]
  phase: 'pre' | 'live' | 'settled'
  targetNavDate: string
  fx: FxLeg | null
  marketIndices: MarketIndex[]
}

interface FundRowLite {
  id: number
  code: string
}

const REFRESH_MS = 5000

/**
 * 折线图的档位选择存 localStorage：用户上一次点的是「7日」，刷新后应该还在 7日。
 * 存的是档位键（不是下标），后端改顺序也不会读错档。
 */
const RANGE_STORAGE_KEY = 'pf-chart-range'

function readStoredRange(): RangeKey {
  try {
    const stored = window.localStorage.getItem(RANGE_STORAGE_KEY)
    return isRangeKey(stored) ? stored : DEFAULT_RANGE
  } catch {
    // 隐私模式/被禁用时 localStorage 会抛异常：档位退回默认，别让首屏白屏
    return DEFAULT_RANGE
  }
}

/**
 * 规则 1：覆盖率 0 时引擎仍会给出一个由汇率腿算出来的 navPct。
 * 把它当成基金涨跌展示就是在骗人，所以整行必须走「行情不可用 / 无覆盖」分支。
 */
const uncovered = (f: FundEstimate) => f.coveredWeight === 0

/** 盘前与盘中都按 5 秒刷新；文案分开，是因为「现在看的是哪一段行情」必须一眼看出 */
const PHASE_TEXT: Record<'pre' | 'live' | 'settled', string> = {
  pre: '盘前 · 5 秒刷新',
  live: '盘中 · 5 秒刷新',
  settled: '美股已收盘 · 待公布净值',
}

/**
 * 盘前视图：把 preMarket 那组数字铺到主字段上，让表格/汇总/排序都看同一份数。
 *
 * 市值与持有收益必须跟着重算，否则会出现「涨跌是盘前的、金额是昨收的」
 * 这种一眼看不出来的错位——那是比不显示更坏的展示。
 * 没有盘前读数（覆盖率不足或取数失败）的基金原样返回，仍显示昨收数字，
 * 由 chips 里的「盘前无成交」提示说明为什么没跟着变。
 */
function applyPreView(f: FundEstimate): FundEstimate {
  const pm = f.preMarket
  if (!pm) return f
  const marketValue = f.nav * f.shares * (1 + pm.navPct / 100)
  return {
    ...f,
    navPct: pm.navPct,
    amount: pm.amount,
    marketValue,
    holdingProfit: marketValue - f.costBasis,
  }
}

/** 持有收益率：分母是成本，成本为 0 时没有定义，界面显示「—」而不是 0% 或 Infinity */
function holdingProfitPct(f: FundEstimate): number | null {
  if (f.costBasis === 0) return null
  return (f.holdingProfit / f.costBasis) * 100
}

/**
 * 板块 → 该指数当日行情。
 *
 * 东财把 NDX 叫「纳斯达克」，而基金跟踪的是「纳斯达克100」，名字对不上，
 * 所以先精确匹配，再退回最长前缀匹配（'纳斯达克100'.startsWith('纳斯达克')）。
 * 前缀匹配里取最长的那个：将来接口若同时给出「纳斯达克」和「纳斯达克100」，不能被短的抢走。
 */
function indexForBoard(indices: MarketIndex[], board: string | null): MarketIndex | null {
  if (!board) return null
  const exact = indices.find((i) => i.name === board)
  if (exact) return exact
  const prefixed = indices
    .filter((i) => board.startsWith(i.name))
    .sort((a, b) => b.name.length - a.name.length)[0]
  return prefixed ?? null
}

/** 三列表头可排序：当日收益 / 关联板块（按其指数涨跌幅）/ 持有收益 */
type SortKey = 'amount' | 'board' | 'holding'
type SortDir = 'desc' | 'asc'

interface SortState {
  key: SortKey
  dir: SortDir
}

const DEFAULT_SORT: SortState = { key: 'amount', dir: 'desc' }

const SORT_LABEL: Record<SortKey, string> = {
  amount: '当日收益',
  board: '关联板块',
  holding: '持有收益',
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return (await res.json()) as T
}

const clock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export default function App() {
  const [data, setData] = useState<EstimateResponse | null>(null)
  const [idsByCode, setIdsByCode] = useState<Record<string, number>>({})
  const [openCode, setOpenCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  /** 盘前相看哪一段：'pre' = 今天盘前（默认），'close' = 上一交易日收盘 */
  const [preMode, setPreMode] = useState<'pre' | 'close'>('pre')
  const [loaded, setLoaded] = useState(false)
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT)
  /** 'all' 或某个板块名 */
  const [tab, setTab] = useState<string>('all')
  /**
   * 服务端存的组合市值点（老 → 新）+ 窗口边界。刷新页面不会丢，因为点不在这儿的 state 里；
   * 连 startMs/endMs 一起存，横轴与副标题才有真实窗口可标注。
   */
  const [history, setHistory] = useState<HistoryResponse | null>(null)
  const [accuracy, setAccuracy] = useState<AccuracyResponse | null>(null)
  /** 用户选中的档位。默认「今日」= 当天美股开盘到收盘 */
  const [chartRange, setChartRange] = useState<RangeKey>(readStoredRange)

  const [code, setCode] = useState('')
  const [marketValue, setMarketValue] = useState('')
  const [profit, setProfit] = useState('')

  const aliveRef = useRef(true)

  // 曲线也要跟着口径走：盘前视图要盘前那一场的窗口与点位，否则头部写盘前、图是昨天
  const historySession = data?.phase === 'pre' && preMode === 'pre' ? 'pre' : 'regular'

  const load = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      const [estimate, fundsRes, hist, acc] = await Promise.all([
        getJson<EstimateResponse>('/api/estimate'),
        getJson<{ funds: FundRowLite[] }>('/api/funds'),
        // 曲线失败不许拖垮估值：取不到就沿用上一轮的点，页面照常跳数字
        getJson<HistoryResponse>(
          `/api/portfolio/history?range=${chartRange}&phase=${historySession}`,
        ).catch(() => null),
        // 对账失败不拖垮估值：没有它只是少了"准确度"那几行
        getJson<AccuracyResponse>('/api/accuracy').catch(() => null),
      ])
      if (!aliveRef.current) return
      const map: Record<string, number> = {}
      for (const row of fundsRes.funds) map[row.code] = row.id
      setData(estimate)
      setIdsByCode(map)
      if (hist) setHistory(hist)
      if (acc) setAccuracy(acc)
      setError(null)
      setUpdatedAt(Date.now())
    } catch (err) {
      if (!aliveRef.current) return
      setError(err instanceof Error ? err.message : '连不上后端')
    } finally {
      if (aliveRef.current) setLoaded(true)
    }
    // chartRange / historySession 进依赖：换档位或切「盘前/昨收」立刻重新取数，
    // 不用等下一个 5 秒 tick
  }, [chartRange, historySession])

  useEffect(() => {
    aliveRef.current = true
    void load()
    // load 的依赖里包含 chartRange：换档位时这个 effect 重跑 = 立刻取数 + 重置计时器
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => {
      aliveRef.current = false
      clearInterval(timer)
    }
  }, [load])

  /** 换档位：写进 localStorage（下次刷新还是这一档），取数由上面的 effect 立刻触发 */
  const changeRange = useCallback((next: RangeKey) => {
    setChartRange(next)
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, next)
    } catch {
      // 存不了就算了，当前这一档仍然有效
    }
  }, [])

  async function addFund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body = {
        code: code.trim(),
        marketValue: Number(marketValue),
        profit: profit.trim() === '' ? 0 : Number(profit),
      }
      const res = await fetch('/api/funds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(payload.error ?? `录入失败 HTTP ${res.status}`)
      setCode('')
      setMarketValue('')
      setProfit('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '录入失败')
    } finally {
      setBusy(false)
    }
  }

  async function removeFund(target: FundEstimate) {
    const id = idsByCode[target.code]
    if (id === undefined) return
    if (!window.confirm(`移除 ${target.name || target.code}？`)) return
    try {
      const res = await fetch(`/api/funds/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`移除失败 HTTP ${res.status}`)
      if (openCode === target.code) setOpenCode(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '移除失败')
    }
  }

  const funds = data?.funds ?? []
  const phase = data?.phase ?? 'settled'
  const preAvailable = funds.some((f) => f.preMarket !== undefined)
  const fx = data?.fx ?? null
  const marketIndices = data?.marketIndices ?? []

  // tab 由数据自己长出来：没有标普500 持仓，就不该出现一个永远空着的 tab
  const boards = useMemo(() => {
    const seen: string[] = []
    for (const f of funds) {
      if (f.board && !seen.includes(f.board)) seen.push(f.board)
    }
    return seen
  }, [funds])

  // 选中的板块在刷新后消失了（删掉最后一只），退回「全部」，不能卡在一个空列表上
  useEffect(() => {
    if (tab !== 'all' && !boards.includes(tab)) setTab('all')
  }, [tab, boards])

  /**
   * 盘前视图。
   *
   * 盘前时段后端给两组数：navPct 是**上一交易日收盘**那一段（常规接口只会给这个），
   * preMarket 是今天盘前进行中的那一段。默认看盘前（那才是"现在"），
   * 也允许切回昨收——盘前成交薄，想确认"昨天到底涨了多少"时得能切回去。
   * 切换在视图层做：把 preMarket 的数字铺到 navPct/amount/marketValue 上，
   * 下面所有表格、汇总、排序、排序用的都是同一份数，不会出现表头与行不一致。
   */
  const showPre = phase === 'pre' && preMode === 'pre'
  const viewFunds = useMemo(() => (showPre ? preViewFunds(funds) : funds), [funds, showPre])

  const visible = useMemo(() => {
    const filtered = tab === 'all' ? viewFunds : viewFunds.filter((f) => f.board === tab)
    const valueOf = (f: FundEstimate): number | null => {
      if (sort.key === 'amount') return uncovered(f) ? null : f.amount
      if (sort.key === 'board') return indexForBoard(marketIndices, f.board)?.pct ?? null
      return f.holdingProfit
    }
    // 没有可比数值的行（无覆盖的金额、没配指数的板块）两个方向都沉到末尾：
    // 它们在表格里显示的是「—」，插在有序数字中间只会误导
    const sorted = [...filtered].sort((a, b) => {
      const av = valueOf(a)
      const bv = valueOf(b)
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return sort.dir === 'desc' ? bv - av : av - bv
    })

    // 展开的那一行钉在列表最上面：它不是「排序结果里的一行」，而是当前正在看的那只。
    // 先排序再抽出来，所以收起时顺序完全不受影响；pin 只挪位置、不碰 .row 的网格列，
    // 三列数字照样和表头对齐。展开的基金若被 tab 过滤掉了，就什么也不钉。
    if (openCode === null) return sorted
    const pinned = sorted.find((f) => f.code === openCode)
    if (!pinned) return sorted
    return [pinned, ...sorted.filter((f) => f.code !== openCode)]
  }, [viewFunds, tab, sort, marketIndices, openCode])

  // 汇总永远可见，但只统计当前 tab 的持仓——表头的数字必须和下面的行对得上
  const valued = visible.filter((f) => !uncovered(f))
  const totalValue = visible.reduce((sum, f) => sum + f.marketValue, 0)
  const totalAmount = valued.reduce((sum, f) => sum + f.amount, 0)
  const totalHoldingProfit = visible.reduce((sum, f) => sum + f.holdingProfit, 0)
  const blindCount = visible.length - valued.length
  const totalCost = visible.reduce((sum, f) => sum + f.costBasis, 0)
  const totalHoldingPct = totalCost === 0 ? null : (totalHoldingProfit / totalCost) * 100
  /**
   * 今日估算的百分比：分母只能是**有行情那几只**的变动前市值。
   * 无覆盖的基金市值是真的（计入总资产），但它今天的涨跌是未知的——把它塞进
   * 分母就等于默认它今天一动不动，覆盖率低的那天会把跌幅算轻。
   */
  const coveredValue = valued.reduce((sum, f) => sum + f.marketValue, 0)
  const totalAmountPct = valued.length > 0 ? pctFromDelta(totalAmount, coveredValue) : null

  /**
   * 夜盘汇总：与上面几个数字同一口径（只统计当前 tab），几只基金按市值加权。
   * 没有任何一只带夜盘读数时是 null——那一行整行不渲染，不写「夜盘 —」。
   */
  const night = summarizeAfterHours(visible)
  const nightClock = night === null ? null : afterHoursClock(night.asOfMs)

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' },
    )
  }

  function sortButton(key: SortKey) {
    const active = sort.key === key
    const state = active ? (sort.dir === 'desc' ? '当前降序' : '当前升序') : '默认降序'
    return (
      <button
        type="button"
        className={`sort${active ? ' on' : ''}`}
        aria-pressed={active}
        aria-label={`按${SORT_LABEL[key]}排序（${state}）`}
        onClick={() => toggleSort(key)}
      >
        {SORT_LABEL[key]}
        <span className="arrow" aria-hidden="true">
          {active ? (sort.dir === 'desc' ? '↓' : '↑') : '↕'}
        </span>
      </button>
    )
  }

  const tabs = [
    { key: 'all', label: '全部', count: funds.length },
    ...boards.map((board) => ({
      key: board,
      label: board,
      count: funds.filter((f) => f.board === board).length,
    })),
  ]

  return (
    <>
      <div className="page">
        <header className="glass card summary">
          <div className="label">
            账户资产
            {tab !== 'all' && <span className="scope"> · 仅「{tab}」</span>}
          </div>
          <div className="amount num">{money(totalValue)}</div>
          <div className="delta">
            <span className="delta-group">
              今日估算 <span className={`num ${tone(totalAmount)}`}>{signedMoney(totalAmount)}</span>
              {totalAmountPct !== null && (
                <span
                  className={`num small ${tone(totalAmountPct)}`}
                  title={
                    blindCount > 0
                      ? `分母为有行情的 ${valued.length} 只的昨日市值（${blindCount} 只无覆盖不计入）`
                      : '分母为昨日市值'
                  }
                >
                  {pctText(totalAmountPct)}
                </span>
              )}
            </span>
            <span className="delta-group">
              持有收益{' '}
              <span className={`num ${tone(totalHoldingProfit)}`}>{signedMoney(totalHoldingProfit)}</span>
              {totalHoldingPct !== null && (
                <span className={`num small ${tone(totalHoldingPct)}`}>{pctText(totalHoldingPct)}</span>
              )}
            </span>
          </div>
          <div className="phase">
            <span className="phase-item">
              <span className={`dot ${phase}`} />
              {PHASE_TEXT[phase]}
            </span>
            <span className="sep">·</span>
            <span className="phase-item">净值日 {data?.targetNavDate ?? '—'}</span>
          </div>
          {phase === 'pre' && preAvailable && (
            <div className="phase">
              {/* 盘前成交薄，两者都可能想看：默认「盘前」（那是现在），可切回「昨收」核对 */}
              <span className="seg" role="group" aria-label="估值口径">
                <button
                  type="button"
                  className={preMode === 'pre' ? 'on' : ''}
                  aria-pressed={preMode === 'pre'}
                  onClick={() => setPreMode('pre')}
                >
                  盘前
                </button>
                <button
                  type="button"
                  className={preMode === 'close' ? 'on' : ''}
                  aria-pressed={preMode === 'close'}
                  onClick={() => setPreMode('close')}
                >
                  昨收
                </button>
              </span>
            </div>
          )}
          {fx && (
            <div className="phase">
              <span className="fx">
                汇率 {fx.pair.replace('CNY', '/CNY')}{' '}
                <span className="num">{fx.rate.toFixed(4)}</span>{' '}
                <span className={`num ${tone(fx.pct)}`}>{pctText(fx.pct)}</span>
              </span>
            </div>
          )}
          {night !== null && (
            <div className="phase ah">
              <span className="phase-item">
                夜盘估值 <span className={`num ${tone(night.pct)}`}>{pctText(night.pct)}</span>
              </span>
              {nightClock !== null && (
                <>
                  <span className="sep">·</span>
                  <span className="phase-item">更新于 {nightClock}</span>
                </>
              )}
            </div>
          )}
          <div className="stamp">
            {updatedAt === null ? '等待首轮数据' : `更新于 ${clock.format(new Date(updatedAt))}`}
            {tab !== 'all' && <span> · 汇总口径：{tab} {visible.length} 只</span>}
            {blindCount > 0 && <span className="warn-text"> · {blindCount} 只无覆盖，未计入今日估算</span>}
          </div>
        </header>

        {/* 直接贴在汇总卡下面：总资产怎么走到今天这个数的，一眼就能看见 */}
        {funds.length > 0 && (
          <PortfolioChart range={chartRange} data={history} onRangeChange={changeRange} />
        )}

        {error && (
          <div className="glass card error" role="alert">
            {error}
          </div>
        )}

        <div className="tabs" role="group" aria-label="按关联板块筛选">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`tab${tab === t.key ? ' on' : ''}`}
              aria-pressed={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              <span className="tab-count num">{t.count}</span>
            </button>
          ))}
        </div>

        <section className="glass card list" aria-label="持仓基金">
          <div className="list-head">
            <span className="hcell" aria-hidden="true" />
            {sortButton('amount')}
            {sortButton('board')}
            {sortButton('holding')}
          </div>

          {funds.length === 0 && (
            <div className="empty">{loaded ? '还没有基金，先录入一只' : '正在读取估值…'}</div>
          )}
          {funds.length > 0 && visible.length === 0 && (
            <div className="empty">「{tab}」下还没有基金</div>
          )}

          {visible.map((f) => {
            const isOpen = openCode === f.code
            const boardIndex = indexForBoard(marketIndices, f.board)
            const holdPct = holdingProfitPct(f)
            return (
              <div className="fund" key={f.code}>
                <button
                  type="button"
                  className="row"
                  aria-expanded={isOpen}
                  aria-controls={`detail-${f.code}`}
                  onClick={() => setOpenCode(isOpen ? null : f.code)}
                >
                  <span className="cell c-name" title={f.name || f.code}>
                    {f.name || f.code}
                  </span>
                  <span className={`cell c-amount num ${uncovered(f) ? 'flat' : tone(f.amount)}`}>
                    {uncovered(f) ? '—' : signedMoney(f.amount)}
                  </span>
                  <span className={`cell c-board num ${boardIndex ? tone(boardIndex.pct) : 'flat'}`}>
                    {boardIndex ? pctText(boardIndex.pct) : '—'}
                  </span>
                  <span className={`cell c-hold num ${tone(f.holdingProfit)}`}>
                    {signedMoney(f.holdingProfit)}
                  </span>

                  <span className="cell c-meta">
                    <span>{f.code}</span>
                    <span className="sep">·</span>
                    {/* 「市值」与金额绑成一组不折行：80px 宽时 "市值" 和数字被拆到两行会更难看 */}
                    <span className="meta-amount">
                      市值 <span className="num">{money(f.marketValue)}</span>
                    </span>
                  </span>
                  <span className={`cell c-navpct num ${uncovered(f) ? 'flat' : tone(f.navPct)}`}>
                    {uncovered(f) ? '—' : pctText(f.navPct)}
                  </span>
                  <span className="cell c-boardname">{f.board ?? '—'}</span>
                  <span className={`cell c-holdpct num ${holdPct === null ? 'flat' : tone(holdPct)}`}>
                    {holdPct === null ? '—' : pctText(holdPct)}
                  </span>

                  <span className="chips">
                    {/* 规则 1：没有行情就直说，绝不把汇率腿的 navPct 当涨跌展示 */}
                    {uncovered(f) && <span className="chip bad">行情不可用 / 无覆盖</span>}
                    {/* 规则 2：港股是「已排除」而不是「没算」，不说清楚会像 bug */}
                    {f.excluded.hk > 0 && (
                      <span className="chip warn">含港股 {f.excluded.hk} 只，已排除</span>
                    )}
                    {/* 净值滞后：QDII 的净值 T+1/T+2 才公布，市值里已经补上中间那几场，
                        但必须说清锚点是哪天的净值，否则「当日 -1%」和「总资产涨了」看着像矛盾 */}
                    {f.sessionsSinceNav > 0 && (
                      <span className="chip" title={`官方净值 ${f.navDate}，之后已按估算补 ${f.sessionsSinceNav} 场（累计 ${f.priorPct >= 0 ? '+' : ''}${f.priorPct.toFixed(2)}%）`}>
                        净值 {f.navDate?.slice(5)} · 补 {f.sessionsSinceNav} 场 {f.priorPct >= 0 ? '+' : ''}
                        {f.priorPct.toFixed(2)}%
                      </span>
                    )}
                    {/* 盘前：说清这条数字用的是哪套口径，以及为什么某只没跟着变 */}
                    {phase === 'pre' && showPre && (
                      f.preMarket ? (
                        <span className="chip pre">
                          盘前 · {f.preMarket.basis === 'index' ? '指数口径' : '成分口径'}
                        </span>
                      ) : (
                        // 原因可能是「这只票没盘前成交」也可能是「整个基金覆盖率不足 30%」，
                        // 统一说「暂无读数」而不猜是哪一种——猜错了用户会去查错方向
                        <span className="chip warn">暂无盘前读数，显示昨收</span>
                      )
                    )}
                    {/* 规则 3+4：口径降级。文案差别是「下一步该做什么」，见 weightChip.ts */}
                    <WeightChip fund={f} />
                    {!uncovered(f) && f.missing.length > 0 && (
                      <span className="chip">缺 {f.missing.length} 只行情</span>
                    )}
                    {/* 原先这里按**配置**的 lag_days 显示"净值滞后 N 日"：
                        那是我们以为的滞后，不是实际的。真实滞后由 navDate +
                        sessionsSinceNav 表达（上面那个 chip 与明细里的"净值日"），
                        两个口径同时摆着只会互相打脸，所以删掉配置版 */}
                  </span>
                </button>

                {isOpen && (
                  <div className="detail" id={`detail-${f.code}`}>
                    {f.breakdown.length === 0 ? (
                      <div className="detail-empty">这一次没有可用的持仓行情，明细为空</div>
                    ) : (
                      <>
                        <div className="brow bhead">
                          <span>持仓</span>
                          <span>权重</span>
                          <span>当日</span>
                          <span>贡献</span>
                        </div>
                        {f.breakdown.map((b) => (
                          <div className="brow" key={b.symbol}>
                            <span className="bname" title={`${b.name}（${b.symbol}）`}>
                              {b.name}
                              {b.name !== b.symbol && <em className="ticker">{b.symbol}</em>}
                            </span>
                            <span className="num">{(b.weight * 100).toFixed(2)}%</span>
                            <span className={`num ${tone(b.pct)}`}>{pctText(b.pct)}</span>
                            <span className={`num ${tone(b.contribution)}`}>
                              {b.contribution.toFixed(3)}pp
                            </span>
                          </div>
                        ))}
                        <div className="detail-foot">
                          <span>净值 {f.nav > 0 ? f.nav.toFixed(4) : '—'}</span>
                          <span>份额 <span className="num">{f.shares.toFixed(2)}</span></span>
                          <span>持仓 {f.holdingsCount} 只</span>
                          <span>覆盖 <span className="num">{Math.round(f.coveredWeight * 100)}%</span></span>
                          <span>
                            净值日 {f.navDate ?? '—'}
                            {f.sessionsSinceNav > 0 && `（补 ${f.sessionsSinceNav} 场）`}
                          </span>
                          {/* 对账：只有官方净值公布过、且留痕能对齐的那几天才算样本。
                              0 天时不说 0.00pp，那是"还没开始对账"，不是"误差为零" */}
                          {(() => {
                            const a = accuracy?.funds.find((x) => x.code === f.code)
                            if (!a || a.n === 0) return <span className="muted">对账样本 0 天</span>
                            return (
                              <span title={`偏差 ${a.bias >= 0 ? '+' : ''}${a.bias.toFixed(2)}pp；建议仓位 ${a.suggestedExposure.toFixed(2)}`}>
                                对账 {a.n} 天 · MAE {a.mae.toFixed(2)}pp
                              </span>
                            )
                          })()}
                          <button type="button" className="remove" onClick={() => void removeFund(f)}>
                            移除
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </section>

        <form className="glass card entry" onSubmit={(e) => void addFund(e)}>
          <div className="entry-fields">
            <input
              className="field code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="代码"
              inputMode="numeric"
              autoComplete="off"
              aria-label="基金代码"
              required
            />
            <input
              className="field"
              value={marketValue}
              onChange={(e) => setMarketValue(e.target.value)}
              placeholder="市值 ¥"
              inputMode="decimal"
              autoComplete="off"
              aria-label="持有市值"
              required
            />
            <input
              className="field"
              value={profit}
              onChange={(e) => setProfit(e.target.value)}
              placeholder="收益 ¥"
              inputMode="decimal"
              autoComplete="off"
              aria-label="持有收益（可为负）"
            />
            <button type="submit" className="submit" disabled={busy}>
              {busy ? '…' : '录入'}
            </button>
          </div>
        </form>
      </div>

      {marketIndices.length > 0 && (
        <div className="market" aria-label="大盘指数">
          <div className="market-track">
            {marketIndices.map((idx) => (
              <span className="mkt" key={idx.symbol}>
                <span className="mkt-name">{idx.name}</span>
                <span className={`num mkt-value ${tone(idx.pct)}`}>{idx.value.toFixed(2)}</span>
                <span className={`num mkt-change ${tone(idx.change)}`}>{signedMoney(idx.change)}</span>
                <span className={`num mkt-pct ${tone(idx.pct)}`}>{pctText(idx.pct)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

/** 口径降级提醒：判断逻辑与文案都在 weightChip.ts，这里只负责渲染 */
function WeightChip({ fund }: { fund: WeightChipInput }) {
  const chip = weightChip(fund)
  if (!chip) return null
  return <span className={`chip ${chip.tone}`}>{chip.text}</span>
}

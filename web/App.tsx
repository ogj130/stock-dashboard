import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import PortfolioChart, {
  DEFAULT_RANGE,
  isRangeKey,
  type HistoryResponse,
  type RangeKey,
} from './PortfolioChart'
import { afterHoursClock, summarizeAfterHours, type AfterHoursLite } from './afterHours'
import { money, pctText, signedMoney, tone } from './format'

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
  phase: 'live' | 'settled'
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
  excluded: { hk: number }
  missing: string[]
  breakdown: Breakdown[]
  /** 关联板块（跟踪指数的中文名）；null 表示没配 index_key */
  board: string | null
  /** 夜盘读数。没有盘后行情 / 覆盖率 < 30% / 盘中时后端根本不发这个键 */
  afterHours?: AfterHoursLite
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
  phase: 'live' | 'settled'
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
  const [loaded, setLoaded] = useState(false)
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT)
  /** 'all' 或某个板块名 */
  const [tab, setTab] = useState<string>('all')
  /**
   * 服务端存的组合市值点（老 → 新）+ 窗口边界。刷新页面不会丢，因为点不在这儿的 state 里；
   * 连 startMs/endMs 一起存，横轴与副标题才有真实窗口可标注。
   */
  const [history, setHistory] = useState<HistoryResponse | null>(null)
  /** 用户选中的档位。默认「今日」= 当天美股开盘到收盘 */
  const [chartRange, setChartRange] = useState<RangeKey>(readStoredRange)

  const [code, setCode] = useState('')
  const [marketValue, setMarketValue] = useState('')
  const [profit, setProfit] = useState('')

  const aliveRef = useRef(true)

  const load = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      const [estimate, fundsRes, hist] = await Promise.all([
        getJson<EstimateResponse>('/api/estimate'),
        getJson<{ funds: FundRowLite[] }>('/api/funds'),
        // 曲线失败不许拖垮估值：取不到就沿用上一轮的点，页面照常跳数字
        getJson<HistoryResponse>(`/api/portfolio/history?range=${chartRange}`).catch(() => null),
      ])
      if (!aliveRef.current) return
      const map: Record<string, number> = {}
      for (const row of fundsRes.funds) map[row.code] = row.id
      setData(estimate)
      setIdsByCode(map)
      if (hist) setHistory(hist)
      setError(null)
      setUpdatedAt(Date.now())
    } catch (err) {
      if (!aliveRef.current) return
      setError(err instanceof Error ? err.message : '连不上后端')
    } finally {
      if (aliveRef.current) setLoaded(true)
    }
    // chartRange 进依赖：换档位立刻重新取数，不用等下一个 5 秒 tick
  }, [chartRange])

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

  const visible = useMemo(() => {
    const filtered = tab === 'all' ? funds : funds.filter((f) => f.board === tab)
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
  }, [funds, tab, sort, marketIndices, openCode])

  // 汇总永远可见，但只统计当前 tab 的持仓——表头的数字必须和下面的行对得上
  const valued = visible.filter((f) => !uncovered(f))
  const totalValue = visible.reduce((sum, f) => sum + f.marketValue, 0)
  const totalAmount = valued.reduce((sum, f) => sum + f.amount, 0)
  const totalHoldingProfit = visible.reduce((sum, f) => sum + f.holdingProfit, 0)
  const blindCount = visible.length - valued.length
  const totalCost = visible.reduce((sum, f) => sum + f.costBasis, 0)
  const totalHoldingPct = totalCost === 0 ? null : (totalHoldingProfit / totalCost) * 100

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
              <span className={`dot ${phase === 'live' ? 'live' : ''}`} />
              {phase === 'live' ? '盘中 · 5 秒刷新' : '美股已收盘 · 待公布净值'}
            </span>
            <span className="sep">·</span>
            <span className="phase-item">净值日 {data?.targetNavDate ?? '—'}</span>
          </div>
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
                    {/* 规则 3：前十大权重口径系统性偏保守（实测 +0.95% vs 指数口径 +2.44%） */}
                    {f.weightsFrom === 'top10' && (
                      <span className="chip warn">未配置跟踪指数，估值偏保守</span>
                    )}
                    {f.weightsFrom === 'none' && (
                      <span className="chip bad">未取到持仓，无法估值</span>
                    )}
                    {!uncovered(f) && f.missing.length > 0 && (
                      <span className="chip">缺 {f.missing.length} 只行情</span>
                    )}
                    {f.lagDays !== 0 && f.lagDays !== 1 && (
                      <span className="chip">净值滞后 {f.lagDays} 日</span>
                    )}
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
                          <span>滞后 {f.lagDays} 日</span>
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

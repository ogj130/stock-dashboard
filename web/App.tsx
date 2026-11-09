import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

/**
 * 与 src/engine/pipeline.ts 的 FundEstimate 一一对应。
 * 只读不猜：界面上任何一个数字都必须来自 /api/estimate，不许自己造。
 */
interface Breakdown {
  symbol: string
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
}

interface FxLeg {
  pair: string
  rate: number
  prevClose: number
  pct: number
  sourceId: string
  tsMs: number
}

interface EstimateResponse {
  funds: FundEstimate[]
  phase: 'live' | 'settled'
  targetNavDate: string
  fx: FxLeg | null
}

interface FundRowLite {
  id: number
  code: string
}

const REFRESH_MS = 5000

const money = (n: number) =>
  n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 带正负号的金额：中文习惯 + 赚 / − 亏，符号本身就是语气；0 不带符号 */
const signedMoney = (n: number) =>
  n === 0 ? money(0) : `${n < 0 ? '-' : '+'}${money(Math.abs(n))}`

const pctText = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`

/** 红涨绿跌（A 股/国内习惯），0 视为无色，避免把持平刷成一片红 */
const tone = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat')

/**
 * 规则 1：覆盖率 0 时引擎仍会给出一个由汇率腿算出来的 navPct。
 * 把它当成基金涨跌展示就是在骗人，所以整行必须走「行情不可用 / 无覆盖」分支。
 */
const uncovered = (f: FundEstimate) => f.coveredWeight === 0

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

  const [code, setCode] = useState('')
  const [marketValue, setMarketValue] = useState('')
  const [profit, setProfit] = useState('')

  const aliveRef = useRef(true)

  const load = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      const [estimate, fundsRes] = await Promise.all([
        getJson<EstimateResponse>('/api/estimate'),
        getJson<{ funds: FundRowLite[] }>('/api/funds'),
      ])
      if (!aliveRef.current) return
      const map: Record<string, number> = {}
      for (const row of fundsRes.funds) map[row.code] = row.id
      setData(estimate)
      setIdsByCode(map)
      setError(null)
      setUpdatedAt(Date.now())
    } catch (err) {
      if (!aliveRef.current) return
      setError(err instanceof Error ? err.message : '连不上后端')
    } finally {
      if (aliveRef.current) setLoaded(true)
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => {
      aliveRef.current = false
      clearInterval(timer)
    }
  }, [load])

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

  // 无覆盖的基金不参与「今日估算」合计：它那个 amount 只是汇率腿，计进去等于把谎话加总
  const valued = funds.filter((f) => !uncovered(f))
  const totalValue = funds.reduce((sum, f) => sum + f.marketValue, 0)
  const totalAmount = valued.reduce((sum, f) => sum + f.amount, 0)
  const totalHoldingProfit = funds.reduce((sum, f) => sum + f.holdingProfit, 0)
  const blindCount = funds.length - valued.length

  return (
    <div className="page">
      <header className="glass card summary">
        <div className="label">账户资产</div>
        <div className="amount num">{money(totalValue)}</div>
        <div className="delta">
          今日估算 <span className={`num ${tone(totalAmount)}`}>{signedMoney(totalAmount)}</span>
          <span className="sep">·</span>
          持有收益 <span className={`num ${tone(totalHoldingProfit)}`}>{signedMoney(totalHoldingProfit)}</span>
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
        <div className="stamp">
          {updatedAt === null ? '等待首轮数据' : `更新于 ${clock.format(new Date(updatedAt))}`}
          {blindCount > 0 && <span className="warn-text"> · {blindCount} 只无覆盖，未计入今日估算</span>}
        </div>
      </header>

      {error && (
        <div className="glass card error" role="alert">
          {error}
        </div>
      )}

      <section className="glass card list" aria-label="持仓基金">
        {funds.length === 0 && (
          <div className="empty">
            {loaded ? '还没有基金，先录入一只' : '正在读取估值…'}
          </div>
        )}
        {funds.map((f) => {
          const isOpen = openCode === f.code
          return (
            <div className="fund" key={f.code}>
              <button
                type="button"
                className="row"
                aria-expanded={isOpen}
                aria-controls={`detail-${f.code}`}
                onClick={() => setOpenCode(isOpen ? null : f.code)}
              >
                <span className="row-main">
                  <span className="name">{f.name || f.code}</span>
                  <span className="meta">
                    <span>{f.code}</span>
                    <span>市值 <span className="num">{money(f.marketValue)}</span></span>
                    <span>
                      持有{' '}
                      <span className={`num ${tone(f.holdingProfit)}`}>
                        {signedMoney(f.holdingProfit)}
                      </span>
                    </span>
                    {!uncovered(f) && (
                      <span>覆盖 <span className="num">{Math.round(f.coveredWeight * 100)}%</span></span>
                    )}
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
                </span>
                <span className="right">
                  {uncovered(f) ? (
                    <>
                      <span className="amount num flat">—</span>
                      <span className="small flat">无覆盖</span>
                    </>
                  ) : (
                    <>
                      <span className={`amount num ${tone(f.amount)}`}>{signedMoney(f.amount)}</span>
                      <span className={`small num ${tone(f.navPct)}`}>{pctText(f.navPct)}</span>
                    </>
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
                          <span>{b.symbol}</span>
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
  )
}

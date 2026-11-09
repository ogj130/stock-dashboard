import { useEffect, useId, useRef, useState } from 'react'
import { buildGeometry, type HistoryPoint, type HistoryResponse } from './PortfolioChart'
import {
  COMPACT_POINT_LIMIT,
  DASH,
  deriveCompactView,
  tailPoints,
  type CompactFund,
} from './compact'
import './compact.css'

/**
 * 桌面小部件（`?compact=1`）。会被塞进一个 320×220 的无边框置顶窗口里，
 * 所以这一层只干三件事：按 5 秒取数、把数据压成六个字段、把它们画满一屏。
 *
 * 刻意不复用 App：主页面的 state（排序、tab、展开行、录入表单）在这里都是
 * 噪声，任何一个都不该有机会让这张卡重渲染。取数口径仍是同一套接口，
 * 数字与主页面当然一致。
 */

const REFRESH_MS = 5000

/** 只声明用到的字段：卡片不读 breakdown，也就不为它承担类型耦合 */
interface EstimateLite {
  funds: CompactFund[]
  phase: 'live' | 'settled'
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return (await res.json()) as T
}

export default function CompactCard() {
  const [data, setData] = useState<EstimateLite | null>(null)
  const [history, setHistory] = useState<HistoryResponse | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const aliveRef = useRef(true)
  const gradientId = `cc-grad-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    aliveRef.current = true

    async function tick(): Promise<void> {
      // 与主页面刻意不同：**不**看 document.hidden。这是个常驻置顶窗口，
      // 被别的窗口挡住时照样要跳数——用户抬头看见的那一眼不能是十分钟前的价格。
      try {
        const [estimate, hist] = await Promise.all([
          getJson<EstimateLite>('/api/estimate'),
          // 曲线取不到不许拖垮数字：沿用上一轮的点，卡片照样读数
          getJson<HistoryResponse>('/api/portfolio/history?range=session').catch(() => null),
        ])
        if (!aliveRef.current) return
        setData(estimate)
        if (hist) setHistory(hist)
        setError(null)
        setUpdatedAt(Date.now())
      } catch (err) {
        if (!aliveRef.current) return
        setError(err instanceof Error ? err.message : '连不上后端')
      } finally {
        if (aliveRef.current) setLoaded(true)
      }
    }

    void tick()
    const timer = setInterval(() => void tick(), REFRESH_MS)
    return () => {
      aliveRef.current = false
      clearInterval(timer)
    }
  }, [])

  const view = deriveCompactView({
    funds: data?.funds ?? [],
    phase: data?.phase ?? 'settled',
    updatedAt,
    loaded,
    error,
  })

  /**
   * 迷你曲线画总资产（存量），不画当日收益：这条线是给「今天这一场走到哪了」
   * 用的，量级稳定才不会每跳一次就重排纵轴。
   * 几何复用主图那条纯函数（viewBox 1000×100 + non-scaling-stroke），
   * 压缩到 52px 高时笔画粗细不会跟着变糊。
   */
  const points: HistoryPoint[] = tailPoints(history?.points ?? [], COMPACT_POINT_LIMIT)
  const geo = buildGeometry(points, 'value')
  const count = points.length

  const ariaLabel =
    `总资产 ${view.totalText}，今日估算 ${view.deltaText}` +
    `${view.deltaPctText === null ? '' : ` ${view.deltaPctText}`}，` +
    `持有收益 ${view.holdText}，${view.phaseText}`

  return (
    <div className="cc-card" role="group" aria-label={ariaLabel}>
      <div className="cc-top">
        <div className="cc-label">总资产</div>
        <div className="cc-total num">{view.totalText}</div>
        <div className="cc-delta">
          <span className="cc-k">今日估算</span>
          <span className={`cc-v num ${view.deltaTone}`}>{view.deltaText}</span>
          {view.deltaPctText !== null && (
            <span className={`cc-p num ${view.deltaTone}`}>{view.deltaPctText}</span>
          )}
        </div>
        <div className="cc-hold">
          <span className="cc-k">持有收益</span>
          <span className="cc-v num">{view.holdText}</span>
        </div>
        {view.note !== null && <div className="cc-note">{view.note}</div>}
      </div>

      {/* 颜色跟着今日估算走：涨红跌绿，无行情时是灰的——没有涨跌就别给颜色 */}
      <div className={`cc-spark ${view.deltaTone}`} aria-hidden="true">
        {count === 0 ? (
          <span className="cc-spark-empty">{DASH}</span>
        ) : (
          <>
            <svg className="cc-spark-svg" viewBox="0 0 1000 100" preserveAspectRatio="none">
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
              </defs>
              {/* 一个点画不出趋势：只留右端那个圆点，别用一条贯穿的平线假装有曲线 */}
              {count >= 2 && (
                <>
                  <path className="cc-area" d={geo.area} fill={`url(#${gradientId})`} />
                  <path
                    className="cc-line"
                    d={geo.line}
                    fill="none"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </>
              )}
            </svg>
            <span
              className="cc-dot"
              style={{ left: `${geo.lastXPct}%`, top: `${geo.lastYPct}%` }}
            />
          </>
        )}
      </div>

      <div className="cc-foot">
        <span className="cc-phase">
          <span className={`cc-pip${data?.phase === 'live' ? ' on' : ''}`} />
          {view.phaseText}
        </span>
        {view.quotesAvailable && view.blindCount > 0 && (
          <span className="cc-blind">· {view.blindCount} 只无覆盖</span>
        )}
        <span className="cc-clock num">{view.clockText}</span>
      </div>
    </div>
  )
}

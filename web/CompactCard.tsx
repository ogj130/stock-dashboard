import { useEffect, useId, useRef, useState } from 'react'
import { buildGeometry, type HistoryPoint, type HistoryResponse } from './PortfolioChart'
import {
  COMPACT_POINT_LIMIT,
  DASH,
  deriveCompactView,
  deriveKeyStocks,
  deriveNewsRows,
  tailPoints,
  type BreakdownLite,
  type CompactFund,
  type KeyStockRow,
  type NewsResponse,
  type NewsRow,
} from './compact'
import { preViewFunds, type PreViewFund } from './preView'
import './compact.css'

/**
 * 桌面小部件（`?compact=1`）。会被塞进一个 340×420 的无边框置顶窗口里，
 * 所以这一层只干三件事：按 5 秒取数、把数据压成汇总 + 三个 Tab 的行、把它们画满一屏。
 *
 * 三个 Tab 各回答一个问题：
 *   · 基金：我的 16 只今天各涨了多少（原有列表，口径不动）；
 *   · 个股：这 16 只共同押注的那几只美股今天在干什么（复用 estimate 的 breakdown，
 *     不新增任何行情请求）；
 *   · 大事：与持仓相关的近期财经快讯（独立接口，60 秒一刷，挂了只降级这一格）。
 *
 * 刻意不复用 App：主页面的 state（排序、tab、展开行、录入表单）在这里都是
 * 噪声，任何一个都不该有机会让这张卡重渲染。取数口径仍是同一套接口，
 * 数字与主页面当然一致。
 */

const REFRESH_MS = 5000
/** 快讯 60 秒一刷：东财快讯的更新频率远低于行情，5 秒一刷只是白打接口 */
const NEWS_REFRESH_MS = 60_000
/** 卡片只显示最近 5 条：多了在 292px 宽 / 两行标题的密度下就只是噪音 */
const NEWS_LIMIT = 5

type TabKey = 'funds' | 'stocks' | 'news'

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'funds', label: '基金' },
  { key: 'stocks', label: '个股' },
  { key: 'news', label: '大事' },
]

/**
 * 盘前换算需要净值、份额、成本这三样（市值与持有收益要跟着重算），
 * 它们服务端一直都有，只是卡片平时不显示。多带上不影响 CompactFund 的契约。
 */
interface CardFund extends CompactFund, PreViewFund {
  /** 持仓明细；盘前/取数失败时可能整段缺失 */
  breakdown?: BreakdownLite[]
}

interface EstimateLite {
  funds: CardFund[]
  phase: 'pre' | 'live' | 'settled'
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return (await res.json()) as T
}

/**
 * 在浏览器里打开一条快讯。
 *
 * 卡片是 WKWebView，直接 `window.open` 会被它当成一次页面导航请求（没实现
 * createWebViewWith 就什么也不会发生）。所以交给 Swift 外壳：`open-url:` 前缀
 * 是一个只接受 http/https 的白名单命令，外壳用 NSWorkspace 打开系统浏览器。
 * 在普通浏览器里（Chrome 调试卡片）退回 window.open。
 */
function openExternal(url: string): void {
  if (url === '') return
  const bridge = (window as unknown as {
    webkit?: { messageHandlers?: { card?: { postMessage(m: string): void } } }
  }).webkit?.messageHandlers?.card
  if (bridge) bridge.postMessage(`open-url:${url}`)
  else window.open(url, '_blank', 'noopener')
}

export default function CompactCard() {
  const [data, setData] = useState<EstimateLite | null>(null)
  const [history, setHistory] = useState<HistoryResponse | null>(null)
  const [news, setNews] = useState<NewsResponse | null>(null)
  const [tab, setTab] = useState<TabKey>('funds')
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

  /**
   * 快讯单独一条时间线：60 秒一刷，与 5 秒的估值 tick 完全解耦。
   * 失败保留上一轮（后端也会给 stale 缓存），绝不因为快讯挂了把整张卡打空。
   */
  useEffect(() => {
    let alive = true
    async function loadNews(): Promise<void> {
      try {
        const payload = await getJson<NewsResponse>(`/api/news?limit=${NEWS_LIMIT}`)
        if (alive) setNews(payload)
      } catch {
        // 拿不到就保持现状：首次失败时下面显示「资讯暂不可用」
      }
    }
    void loadNews()
    const timer = setInterval(() => void loadNews(), NEWS_REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const phase = data?.phase ?? 'settled'
  // 卡片是「一眼看现在」用的：盘前就显示盘前那一段，绝不拿昨天的收盘涨幅当今天
  const rawFunds: CardFund[] = data?.funds ?? []
  const view = deriveCompactView({
    funds: phase === 'pre' ? preViewFunds(rawFunds) : rawFunds,
    phase,
    updatedAt,
    loaded,
    error,
  })

  /**
   * 个股用**原始** funds 聚合：breakdown 是常规行情的产物，盘前铺数只改市值与金额，
   * 拿它当权重基准会得到「成分没变但权重跟着盘前抖」的假变化。
   */
  const stocks: KeyStockRow[] = deriveKeyStocks(rawFunds)
  const newsRows: NewsRow[] = deriveNewsRows(news?.items ?? [], stocks, NEWS_LIMIT)
  const newsStale = news?.stale === true && newsRows.length > 0

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
    `持有收益 ${view.holdText}，${view.phaseText}` +
    // 夜盘是补充读数：读屏也要能听到，否则视觉用户看到的那一行对他们是缺失的
    `${view.afterHoursText === null ? '' : `，${view.afterHoursText}`}`

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
        {/* 空仓时的 note 由列表区的空态负责，这里只管「有旧数据但这轮失败了」 */}
        {view.note !== null && view.rows.length > 0 && <div className="cc-note">{view.note}</div>}
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

      {/* 三段切换：22px 高，占掉基金列表约一行，换来另外两个视角。
          默认「基金」，不持久化——每次拉起卡片先看持仓，这是每天的第一眼。 */}
      <div className="cc-tabs" role="tablist" aria-label="卡片视图">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`cc-tab-${key}`}
            className={`cc-tab${tab === key ? ' on' : ''}`}
            aria-selected={tab === key}
            aria-controls={`cc-panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => setTab(key)}
          >
            {label}
            {key === 'news' && newsStale && <i className="cc-tab-cache">缓存</i>}
          </button>
        ))}
      </div>

      {/* 列表区：上半 (汇总 + 曲线 + Tab) 与底部脚注高度固定，剩下的全给它；
          三个 Tab 各自一个列表，数据各自独立——快讯挂了只让「大事」降级 */}
      {tab === 'funds' &&
        (view.rows.length === 0 ? (
          // 空态文案只出现一次，并且就放在它描述的那块区域里
          <div className="cc-list-empty" role="tabpanel" id="cc-panel-funds" aria-labelledby="cc-tab-funds">
            {view.note ?? DASH}
          </div>
        ) : (
          <ul
            className="cc-list"
            id="cc-panel-funds"
            role="tabpanel"
            aria-labelledby="cc-tab-funds"
            aria-label="全部基金"
          >
            {view.rows.map((row) => (
              <li className="cc-row" key={row.code}>
                <span className="cc-name" title={row.name}>
                  {row.name}
                </span>
                <span className={`cc-pct num ${row.pctTone}`}>{row.pctText}</span>
                <span className={`cc-amt num ${row.amountTone}`}>{row.amountText}</span>
              </li>
            ))}
          </ul>
        ))}

      {tab === 'stocks' &&
        (stocks.length === 0 ? (
          <div className="cc-list-empty" role="tabpanel" id="cc-panel-stocks" aria-labelledby="cc-tab-stocks">
            暂无持仓明细
          </div>
        ) : (
          <ul
            className="cc-list"
            id="cc-panel-stocks"
            role="tabpanel"
            aria-labelledby="cc-tab-stocks"
            aria-label="重点个股"
          >
            {stocks.map((row) => (
              <li className="cc-row cc-stock" key={row.symbol}>
                <span
                  className="cc-name cc-stock-name"
                  title={`${row.name} ${row.symbol}${
                    row.turnoverText === null ? '' : ` · 当日成交额 ${row.turnoverText}`
                  }`}
                >
                  <span className="cc-stock-label">{row.name}</span>
                  {/* ticker 定宽留在行尾：英文名再长也只截名字，代码永远看得见 */}
                  <i className="cc-sym">{row.symbol}</i>
                </span>
                <span className="cc-stock-w num">{row.weightText}</span>
                <span className={`cc-stock-p num ${row.pctTone}`}>{row.pctText}</span>
              </li>
            ))}
          </ul>
        ))}

      {tab === 'news' &&
        (newsRows.length === 0 ? (
          <div className="cc-list-empty" role="tabpanel" id="cc-panel-news" aria-labelledby="cc-tab-news">
            资讯暂不可用
          </div>
        ) : (
          <ul
            className="cc-list cc-news"
            id="cc-panel-news"
            role="tabpanel"
            aria-labelledby="cc-tab-news"
            aria-label="近期大事"
          >
            {newsRows.map((row) => (
              <li className="cc-news-item" key={row.id}>
                {/* 整行是一个按钮：点哪都能开，不需要瞄准标题；Swift 外壳用系统浏览器打开 */}
                <button
                  type="button"
                  className="cc-news-row"
                  onClick={() => openExternal(row.url)}
                  title={row.url === '' ? row.title : `${row.title}\n${row.url}`}
                  aria-label={`${row.title}（在浏览器打开）`}
                >
                  <span className="cc-news-time num">{row.timeText}</span>
                  <span className="cc-news-title">{row.title}</span>
                  {row.important && <i className="cc-tag imp">重要</i>}
                  {row.related && <i className="cc-tag hold">持仓</i>}
                  <i className="cc-news-go" aria-hidden="true">
                    ↗
                  </i>
                </button>
              </li>
            ))}
          </ul>
        ))}

      <div className="cc-foot">
        <span className="cc-phase">
          <span className={`cc-pip${data?.phase === 'live' ? ' on' : ''}`} />
          {view.phaseText}
        </span>
        {view.quotesAvailable && view.blindCount > 0 && (
          <span className="cc-blind">· {view.blindCount} 只无覆盖</span>
        )}
        {/* 有夜盘才多这一段；没有就什么都不渲染（绝不写「夜盘 —」） */}
        {view.afterHoursText !== null && <span className="cc-ah">· {view.afterHoursText}</span>}
        <span className="cc-clock num">{view.clockText}</span>
        {/* 卡片只放总览，明细在网页端。点这里交给 Swift 外壳用系统浏览器打开 */}
        <button
          type="button"
          className="cc-open"
          title="在浏览器打开完整页面"
          onClick={() => {
            const bridge = (window as unknown as {
              webkit?: { messageHandlers?: { card?: { postMessage(m: string): void } } }
            }).webkit?.messageHandlers?.card
            if (bridge) bridge.postMessage('open')
            else window.open('/', '_blank', 'noopener')
          }}
        >
          完整页面
        </button>
      </div>
    </div>
  )
}

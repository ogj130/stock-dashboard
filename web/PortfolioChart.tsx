import { useId } from 'react'
import { money, pctText, signedMoney, tone } from './format'

/**
 * 总资产曲线。手写 SVG，不引图表库：项目没有图表依赖，也不该为此多背一个
 * 100KB 的包去画一条 110px 高的折线。
 *
 * 几何思路：曲线用 viewBox="0 0 1000 100" + preserveAspectRatio="none" 铺满宽度，
 * 但这样会把笔画和文字一起横向拉伸——所以
 *   · 笔画全部加 vector-effect="non-scaling-stroke"，粗细恒为 1.5px；
 *   · 文字（min/max、时间、差值）全交给 HTML 层绝对定位，任何宽度下都不变形。
 */

export interface HistoryPoint {
  tsMs: number
  value: number
  amount: number
}

/** 与后端 `src/store/portfolio.ts` 的 HistoryRange 一一对应（tests 里有类型同构断言） */
export type RangeKey = 'session' | '1h' | '6h' | '24h' | '7d'

export const RANGE_OPTIONS: ReadonlyArray<{ key: RangeKey; label: string }> = [
  { key: 'session', label: '今日' },
  { key: '1h', label: '1时' },
  { key: '6h', label: '6时' },
  { key: '24h', label: '24时' },
  { key: '7d', label: '7日' },
]

export const DEFAULT_RANGE: RangeKey = 'session'

export function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === 'string' && RANGE_OPTIONS.some((option) => option.key === value)
}

export function rangeLabel(range: RangeKey): string {
  return RANGE_OPTIONS.find((option) => option.key === range)?.label ?? '今日'
}

/** 接口回包：range/startMs/endMs 是「窗口」的权威描述，前端不重复算交易日 */
export interface HistoryResponse {
  range: RangeKey
  startMs: number
  endMs: number
  points: HistoryPoint[]
}

const VIEW_W = 1000
const VIEW_H = 100

/**
 * 上下留白（viewBox 单位，等于百分比，因为 VIEW_H 正好是 100）：
 * 曲线贴边会被裁掉半条笔画，也没地方放 min/max 标签。
 */
const PAD = 14

/**
 * 横轴与副标题的格式化器。
 *
 * `session` 必须用美东时间：窗口就是 09:30–16:00 美东，用本地时区读出来
 * 在北京会是 22:30–05:00，看着像跨境夜盘。其余档位是滚动窗口，按本地时间读
 * 才是用户脑子里的「最近 6 小时」。
 */
const ET_HHMM = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const LOCAL_HHMM = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/**
 * 本地日历日。不直接用 `zh-CN` 的 month/day 输出：它会渲染成 "11/09"，
 * 而横轴约定的是 "11-09"；自己做零件拼装，就不必赌 locale 的分隔符。
 */
const LOCAL_DATE_PARTS = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function localDateKey(atMs: number): string {
  const parts = LOCAL_DATE_PARTS.formatToParts(new Date(atMs))
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

/** "11-09" */
const localMonthDay = (atMs: number): string => localDateKey(atMs).slice(5)

const round1 = (n: number): number => Math.round(n * 10) / 10

/** 窗口是否跨了本地日历日：跨了才需要在横轴上带 MM-DD */
function spansDays(startMs: number, endMs: number): boolean {
  return localDateKey(startMs) !== localDateKey(endMs)
}

/**
 * 横轴三档标签（起、中、止），跟着**真实窗口**走而不是跟着采样点走：
 * 09:31 打开页面时只有一两个点，若按点取标签会全都挤在同一分钟里。
 */
export function axisLabels(range: RangeKey, startMs: number, endMs: number): string[] {
  const stamps = [startMs, startMs + (endMs - startMs) / 2, endMs]
  if (range === 'session') return stamps.map((ts) => ET_HHMM.format(new Date(ts)))
  if (spansDays(startMs, endMs)) {
    return stamps.map((ts) => `${localMonthDay(ts)} ${LOCAL_HHMM.format(new Date(ts))}`)
  }
  return stamps.map((ts) => LOCAL_HHMM.format(new Date(ts)))
}

/** 副标题：把窗口边界原样写出来，避免「这条线到底覆盖了什么」靠猜 */
export function windowSubtitle(range: RangeKey, startMs: number, endMs: number): string {
  if (range === 'session') {
    return `美东 ${ET_HHMM.format(new Date(startMs))} – ${ET_HHMM.format(new Date(endMs))}`
  }
  if (spansDays(startMs, endMs)) {
    return `${localMonthDay(startMs)} ${LOCAL_HHMM.format(new Date(startMs))} – ${localMonthDay(endMs)} ${LOCAL_HHMM.format(new Date(endMs))}`
  }
  return `本地 ${LOCAL_HHMM.format(new Date(startMs))} – ${LOCAL_HHMM.format(new Date(endMs))}`
}

export interface ChartGeometry {
  /** 折线路径；0 个点时为空串 */
  line: string
  /** 折线与底边围出的填充区 */
  area: string
  max: number
  min: number
  /** 最高点所在的水平线（viewBox 单位），用于那条淡网格线 */
  gridY: number
  /** 以下都是百分比，供 HTML 层的标签与末端圆点定位 */
  yMaxPct: number
  yMinPct: number
  lastXPct: number
  lastYPct: number
  /** 所有值相同（或只有一个点）：平线画在中线，且没有「涨跌」可言 */
  flat: boolean
}

const EMPTY: ChartGeometry = {
  line: '',
  area: '',
  max: 0,
  min: 0,
  gridY: VIEW_H / 2,
  yMaxPct: 50,
  yMinPct: 50,
  lastXPct: 100,
  lastYPct: 50,
  flat: true,
}

/**
 * 纯函数，便于单测。三种退化情况都必须给出能画的几何：
 * 0 个点 → 空几何（调用方渲染「暂无数据」）；1 个点 → 贯穿的平线 + 一个圆点；
 * 全部相等 → 中线平线（不除零，yOf 里的分母 min/max 差值不能是 0）。
 */
export function buildGeometry(points: HistoryPoint[]): ChartGeometry {
  if (points.length === 0) return EMPTY

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const p of points) {
    if (p.value < min) min = p.value
    if (p.value > max) max = p.value
  }
  const flat = !(max - min > 1e-9)
  const inner = VIEW_H - PAD * 2
  const yOf = (v: number): number => (flat ? VIEW_H / 2 : PAD + (1 - (v - min) / (max - min)) * inner)
  const xOf = (i: number): number => (points.length <= 1 ? 0 : (i * VIEW_W) / (points.length - 1))

  const coords = points.map((p, i) => [xOf(i), yOf(p.value)] as const)
  const lastCoord = coords[coords.length - 1]!

  let line: string
  if (points.length === 1) {
    // 单点不能写成 "M x y" 就完事：那什么也画不出来。给一条贯穿的平线。
    const y = round1(lastCoord[1])
    line = `M0 ${y}L${VIEW_W} ${y}`
  } else {
    line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round1(x)} ${round1(y)}`).join('')
  }

  return {
    line,
    area: `${line}L${VIEW_W} ${VIEW_H}L0 ${VIEW_H}Z`,
    max,
    min,
    gridY: round1(yOf(max)),
    yMaxPct: (yOf(max) / VIEW_H) * 100,
    yMinPct: flat ? 50 : (yOf(min) / VIEW_H) * 100,
    // 单点画在右端（等价于「最新」），与那条平线的末尾重合
    lastXPct: points.length === 1 ? 100 : (lastCoord[0] / VIEW_W) * 100,
    lastYPct: (lastCoord[1] / VIEW_H) * 100,
    flat,
  }
}

interface PortfolioChartProps {
  /** 用户选中的档位（分段控件高亮用） */
  range: RangeKey
  /** 后端回包；首轮还没回来时为 null */
  data: HistoryResponse | null
  onRangeChange: (range: RangeKey) => void
}

export default function PortfolioChart({ range, data, onRangeChange }: PortfolioChartProps) {
  const gradientId = `pf-grad-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const points = data?.points ?? []
  const geo = buildGeometry(points)
  const n = points.length
  const first = points[0]
  const last = points[n - 1]

  // 切换档位后新一轮数据还没到：文案跟着**已有数据**的窗口，不跟着按钮走，
  // 否则会出现「标签写今日、线还是 7 日」的那种撒谎。
  const shownRange = data?.range ?? range
  const label = rangeLabel(shownRange)

  const delta = first && last ? last.value - first.value : 0
  const deltaPct = first && first.value > 0 ? (delta / first.value) * 100 : null
  const trend = tone(delta)

  // 只有一个点时，窗口内没有「变化」可言：显示 — 比显示 0.00 诚实
  const deltaText =
    n < 2
      ? `${label} —`
      : `${label} ${signedMoney(delta)}${deltaPct === null ? '' : ` (${pctText(deltaPct)})`}`

  const xLabels = data ? axisLabels(shownRange, data.startMs, data.endMs) : []
  const subtitle = data ? windowSubtitle(shownRange, data.startMs, data.endMs) : '—'

  const ariaLabel =
    n === 0
      ? `总资产曲线暂无数据（${label}）`
      : `总资产 ${label} 走势（${subtitle}），${money(geo.min)} 至 ${money(geo.max)}，最新 ${money(last?.value ?? 0)}`

  return (
    <section className={`chart glass card ${trend}`} aria-label="总资产走势">
      <div className="chart-head">
        <span className="chart-title">总资产</span>
        <div className="chart-ranges" role="group" aria-label="时间范围">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`chart-range${option.key === range ? ' on' : ''}`}
              aria-pressed={option.key === range}
              onClick={() => onRangeChange(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="chart-meta">
          <span className={`chart-delta num ${trend}`}>{deltaText}</span>
          <span className="chart-sub">{subtitle}</span>
        </span>
      </div>

      {n === 0 ? (
        <div className="chart-empty">暂无数据 · 曲线每 30 秒落一个点，稍后自动出现</div>
      ) : (
        <>
          <div className="chart-plot">
            <svg
              className="chart-svg"
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={ariaLabel}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.26" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
              </defs>
              {/* 一个点画不出趋势：只留那个圆点，别用一条贯穿的平线假装有曲线 */}
              {n >= 2 && (
                <>
                  <line
                    className="chart-grid"
                    x1={0}
                    y1={geo.gridY}
                    x2={VIEW_W}
                    y2={geo.gridY}
                    vectorEffect="non-scaling-stroke"
                  />
                  <path className="chart-area" d={geo.area} fill={`url(#${gradientId})`} />
                  <path
                    className="chart-line"
                    d={geo.line}
                    fill="none"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                </>
              )}
            </svg>

            {/* 标签放在曲线「外侧」：max 标签悬在最高点之上、min 标签沉在最低点之下，
                这样无论涨还是跌都不会被自己的曲线压住 */}
            {n >= 2 && (
              <>
                <span className="chart-y max num" style={{ top: `${geo.yMaxPct}%` }}>
                  {money(geo.max)}
                </span>
                {!geo.flat && (
                  <span className="chart-y min num" style={{ top: `${geo.yMinPct}%` }}>
                    {money(geo.min)}
                  </span>
                )}
              </>
            )}
            <span
              className="chart-dot"
              style={{ left: `${geo.lastXPct}%`, top: `${geo.lastYPct}%` }}
              aria-hidden="true"
            />
          </div>

          <div className="chart-xaxis">
            {xLabels.map((text, i) => (
              <span className="num" key={`${i}-${text}`}>
                {text}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

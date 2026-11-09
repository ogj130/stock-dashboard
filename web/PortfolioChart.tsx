import { useId, useState } from 'react'
import { money, pctText, signedMoney, tone } from './format'

/**
 * 组合曲线。手写 SVG，不引图表库：项目没有图表依赖，也不该为此多背一个
 * 100KB 的包去画一条 110px 高的折线。
 *
 * 几何思路：曲线用 viewBox="0 0 1000 100" + preserveAspectRatio="none" 铺满宽度，
 * 但这样会把笔画和文字一起横向拉伸——所以
 *   · 笔画全部加 vector-effect="non-scaling-stroke"，粗细恒为 1.5px；
 *   · 文字（min/max、时间、差值）全交给 HTML 层绝对定位，任何宽度下都不变形。
 *
 * 三条曲线（总资产 / 当日收益 / 持有收益）同一次回包里一起到达，切换指标只
 * 重算几何、不重新取数。三条线的量级差着两三个数量级（十万 vs 几千），
 * 所以纵轴必须按**选中的那条**算，绝不能拿总资产的比例尺去画收益。
 */

export interface HistoryPoint {
  tsMs: number
  value: number
  amount: number
  profit: number
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

/** 曲线指标：字段名直接就是后端 point 上的键，切换时只做一次 `point[metric]` */
export type MetricKey = 'value' | 'amount' | 'profit'

export const METRIC_OPTIONS: ReadonlyArray<{ key: MetricKey; label: string }> = [
  { key: 'value', label: '总资产' },
  { key: 'amount', label: '当日收益' },
  { key: 'profit', label: '持有收益' },
]

export const DEFAULT_METRIC: MetricKey = 'value'

/** 指标选择的存档键：和档位分开存，改档位不该把指标打回总资产 */
export const METRIC_STORAGE_KEY = 'pf-chart-metric'

export function isMetricKey(value: unknown): value is MetricKey {
  return typeof value === 'string' && METRIC_OPTIONS.some((option) => option.key === value)
}

export function metricLabel(metric: MetricKey): string {
  return METRIC_OPTIONS.find((option) => option.key === metric)?.label ?? '总资产'
}

/**
 * 从 localStorage 读回上次选的指标。隐私模式/被禁用时 getItem 会抛，
 * 读不到就退回总资产——首屏不能因为一个偏好设置白屏。
 */
export function readStoredMetric(): MetricKey {
  try {
    const stored = window.localStorage.getItem(METRIC_STORAGE_KEY)
    return isMetricKey(stored) ? stored : DEFAULT_METRIC
  } catch {
    return DEFAULT_METRIC
  }
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
  /** 折线与**基线**围出的填充区（value 的基线是底边，收益类指标的基线是零线） */
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
  /**
   * 零基线的 y（viewBox 单位）；null 表示这条指标不画零线。
   * 只有「可正可负的收益类指标」且数据真的跨过零时才给，正收益/负收益
   * 一边倒的时候零线在框外，画不出来也不该画。
   */
  zeroY: number | null
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
  zeroY: null,
}

/**
 * 纯函数，便于单测。三种退化情况都必须给出能画的几何：
 * 0 个点 → 空几何（调用方渲染「暂无数据」）；1 个点 → 贯穿的平线 + 一个圆点；
 * 全部相等 → 中线平线（不除零，yOf 里的分母 min/max 差值不能是 0）。
 *
 * 纵轴范围**只来自选中的那条序列**。这是这个函数唯一容易出 bug 的地方：
 * 拿总资产的 8 万当比例尺去画 ±5000 的收益，曲线会被压成一条贴边的直线。
 */
export function buildGeometry(
  points: HistoryPoint[],
  metric: MetricKey = DEFAULT_METRIC,
): ChartGeometry {
  if (points.length === 0) return EMPTY

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const p of points) {
    const v = p[metric]
    if (v < min) min = v
    if (v > max) max = v
  }
  const flat = !(max - min > 1e-9)
  const inner = VIEW_H - PAD * 2
  const yOf = (v: number): number => (flat ? VIEW_H / 2 : PAD + (1 - (v - min) / (max - min)) * inner)
  const xOf = (i: number): number => (points.length <= 1 ? 0 : (i * VIEW_W) / (points.length - 1))

  const coords = points.map((p, i) => [xOf(i), yOf(p[metric])] as const)
  const lastCoord = coords[coords.length - 1]!

  let line: string
  if (points.length === 1) {
    // 单点不能写成 "M x y" 就完事：那什么也画不出来。给一条贯穿的平线。
    const y = round1(lastCoord[1])
    line = `M0 ${y}L${VIEW_W} ${y}`
  } else {
    line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round1(x)} ${round1(y)}`).join('')
  }

  // 收益类指标的填充必须「贴着零线」：正收益那半边的面积代表赚到的钱，
  // 从底边起填会把「零」画在看不见的地方，正负两边看起来一样高。
  // 零线在框外时夹到框边——这叫「零在更远处」，不是「零在这儿」。
  const zeroY =
    metric !== 'value' && !flat && min < 0 && max > 0 ? round1(yOf(0)) : null
  const baselineY =
    metric === 'value' ? VIEW_H : flat ? VIEW_H / 2 : Math.min(VIEW_H, Math.max(0, yOf(0)))

  return {
    line,
    area: `${line}L${VIEW_W} ${round1(baselineY)}L0 ${round1(baselineY)}Z`,
    max,
    min,
    gridY: round1(yOf(max)),
    yMaxPct: (yOf(max) / VIEW_H) * 100,
    yMinPct: flat ? 50 : (yOf(min) / VIEW_H) * 100,
    // 单点画在右端（等价于「最新」），与那条平线的末尾重合
    lastXPct: points.length === 1 ? 100 : (lastCoord[0] / VIEW_W) * 100,
    lastYPct: (lastCoord[1] / VIEW_H) * 100,
    flat,
    zeroY,
  }
}

export interface DeltaSummary {
  text: string
  tone: ReturnType<typeof tone>
}

/**
 * 角落那句「今日 +569.46 (+1.14%)」。
 *
 * 两个口径不能混：
 *   · 总资产是**存量**，有意义的是窗口内的变化量（末 − 首），百分比也只对它成立；
 *   · 当日收益/持有收益是**可正可负的水平值**，有意义的是最新那一跳的数
 *     （"今天赚了多少" % 什么？没有可比的基数，所以不给百分比）。
 */
export function deltaSummary(
  points: HistoryPoint[],
  metric: MetricKey,
  label: string,
): DeltaSummary {
  const last = points[points.length - 1]
  if (!last) return { text: `${label} —`, tone: 'flat' }

  if (metric !== 'value') {
    const level = last[metric]
    return { text: `${label} ${signedMoney(level)}`, tone: tone(level) }
  }

  const first = points[0]
  // 只有一个点时，窗口内没有「变化」可言：显示 — 比显示 0.00 诚实
  if (!first || points.length < 2) return { text: `${label} —`, tone: 'flat' }

  const delta = last.value - first.value
  const pct = first.value > 0 ? (delta / first.value) * 100 : null
  return {
    text: `${label} ${signedMoney(delta)}${pct === null ? '' : ` (${pctText(pct)})`}`,
    tone: tone(delta),
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
  /**
   * 指标的选择权在这一层，不在 App：换指标**不碰网络**，三组数字已经在
   * data.points 里了，多提一层状态只会让 App 的重渲染带着整个列表一起抖。
   * 档位相反，它要重新取数，所以留在 App。
   */
  const [metric, setMetric] = useState<MetricKey>(readStoredMetric)
  const points = data?.points ?? []
  const geo = buildGeometry(points, metric)
  const n = points.length
  const last = points[n - 1]

  // 切换档位后新一轮数据还没到：文案跟着**已有数据**的窗口，不跟着按钮走，
  // 否则会出现「标签写今日、线还是 7 日」的那种撒谎。
  const shownRange = data?.range ?? range
  const label = rangeLabel(shownRange)

  const delta = deltaSummary(points, metric, label)
  const trend = delta.tone
  const title = metricLabel(metric)

  const xLabels = data ? axisLabels(shownRange, data.startMs, data.endMs) : []
  const subtitle = data ? windowSubtitle(shownRange, data.startMs, data.endMs) : '—'

  const ariaLabel =
    n === 0
      ? `${title}曲线暂无数据（${label}）`
      : `${title} ${label} 走势（${subtitle}），${money(geo.min)} 至 ${money(geo.max)}，最新 ${money(last?.[metric] ?? 0)}`

  function changeMetric(next: string): void {
    if (!isMetricKey(next)) return
    setMetric(next)
    try {
      window.localStorage.setItem(METRIC_STORAGE_KEY, next)
    } catch {
      // 存不了就算了，当前这一档仍然有效
    }
  }

  return (
    <section className={`chart glass card ${trend}`} aria-label={`${title}走势`}>
      <div className="chart-head">
        {/*
          下拉菜单而不是第二条分段控件：表头已经有「今日/1时/6时/24时/7日」五个按钮，
          390px 宽再加一排会把右侧的涨跌数字挤到第三行。原生 select 在手机上点开
          是系统选择器，比自绘菜单更稳，也省一整个控件的高度。
        */}
        <select
          className="chart-metric"
          aria-label="曲线指标"
          value={metric}
          onChange={(event) => changeMetric(event.target.value)}
        >
          {METRIC_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
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
          <span className={`chart-delta num ${trend}`}>{delta.text}</span>
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
                  {/* 零基线：收益可正可负，没有这条线就分不清「涨回来的」和「本来就低」 */}
                  {geo.zeroY !== null && (
                    <line
                      className="chart-zero"
                      x1={0}
                      y1={geo.zeroY}
                      x2={VIEW_W}
                      y2={geo.zeroY}
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
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

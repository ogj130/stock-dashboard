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

const VIEW_W = 1000
const VIEW_H = 100

/**
 * 上下留白（viewBox 单位，等于百分比，因为 VIEW_H 正好是 100）：
 * 曲线贴边会被裁掉半条笔画，也没地方放 min/max 标签。
 */
const PAD = 14

const HHMM = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const round1 = (n: number): number => Math.round(n * 10) / 10

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
  points: HistoryPoint[]
  /** 窗口小时数：只用于文案，取数在后端按同一个值做 */
  hours: number
}

export default function PortfolioChart({ points, hours }: PortfolioChartProps) {
  const gradientId = `pf-grad-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const geo = buildGeometry(points)
  const n = points.length
  const first = points[0]
  const last = points[n - 1]

  const delta = first && last ? last.value - first.value : 0
  const deltaPct = first && first.value > 0 ? (delta / first.value) * 100 : null
  const trend = tone(delta)
  const windowText = `${hours}h`

  // 只有一个点时，窗口内没有「变化」可言：显示 — 比显示 0.00 诚实
  const deltaText =
    n < 2
      ? `${windowText}  —`
      : `${windowText}  ${signedMoney(delta)}${deltaPct === null ? '' : ` (${pctText(deltaPct)})`}`

  const xLabels =
    n === 0
      ? []
      : n === 1
        ? [points[0]!.tsMs]
        : [points[0]!.tsMs, points[Math.floor((n - 1) / 2)]!.tsMs, points[n - 1]!.tsMs]

  const label =
    n === 0
      ? '总资产曲线暂无数据'
      : `总资产 ${windowText} 走势，${money(geo.min)} 至 ${money(geo.max)}，最新 ${money(last?.value ?? 0)}`

  return (
    <section className={`chart glass card ${trend}`} aria-label="总资产走势">
      <div className="chart-head">
        <span className="chart-title">总资产</span>
        <span className={`chart-delta num ${trend}`}>{deltaText}</span>
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
              aria-label={label}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.26" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
              </defs>
              {/* 最高点那条淡网格线：让「涨到哪儿了」有个参照 */}
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
            </svg>

            {/* 标签放在曲线「外侧」：max 标签悬在最高点之上、min 标签沉在最低点之下，
                这样无论涨还是跌都不会被自己的曲线压住 */}
            <span className="chart-y max num" style={{ top: `${geo.yMaxPct}%` }}>
              {money(geo.max)}
            </span>
            {!geo.flat && (
              <span className="chart-y min num" style={{ top: `${geo.yMinPct}%` }}>
                {money(geo.min)}
              </span>
            )}
            <span
              className="chart-dot"
              style={{ left: `${geo.lastXPct}%`, top: `${geo.lastYPct}%` }}
              aria-hidden="true"
            />
          </div>

          <div className="chart-xaxis">
            {xLabels.map((ts) => (
              <span className="num" key={ts}>
                {HHMM.format(new Date(ts))}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

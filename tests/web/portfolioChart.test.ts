// tests/web/portfolioChart.test.ts
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_METRIC,
  METRIC_OPTIONS,
  METRIC_STORAGE_KEY,
  RANGE_OPTIONS,
  axisLabels,
  buildGeometry,
  deltaSummary,
  isMetricKey,
  metricLabel,
  readStoredMetric,
  windowSubtitle,
  type HistoryPoint,
  type MetricKey,
  type RangeKey,
  preDeltaSummary,
  preSessionPoints,
} from '../../web/PortfolioChart'
import { pctText } from '../../web/format'
import { HISTORY_RANGES, type HistoryRange } from '../../src/store/portfolio'

const p = (
  value: number,
  tsMs = 0,
  extra: Partial<Pick<HistoryPoint, 'amount' | 'profit'>> = {},
): HistoryPoint => ({
  tsMs,
  value,
  amount: 0,
  profit: 0,
  valuePre: null,
  amountPre: null,
  ...extra,
})

/**
 * 曲线是纯函数算出来的几何，所以三种退化情况能在 node 里直接钉住：
 * 0 个点、1 个点、以及所有值相同（这条最容易写成 x/0 = NaN，整条 path 变空）。
 */
describe('buildGeometry · 退化情况', () => {
  it('0 个点：给空几何（调用方渲染「暂无数据」）', () => {
    expect(buildGeometry([])).toMatchObject({ line: '', area: '', flat: true })
  })

  it('1 个点：一条贯穿的平线 + 右端圆点，不是画不出来的单点路径', () => {
    const g = buildGeometry([p(100)])
    expect(g.line).toBe('M0 50L1000 50')
    expect(g.area).toBe('M0 50L1000 50L1000 100L0 100Z')
    expect(g.flat).toBe(true)
    // 圆点落在右端（等价于「最新」），与平线末尾重合
    expect(g.lastXPct).toBe(100)
    expect(g.lastYPct).toBe(50)
  })

  it('所有值相同：平线画在中线，min/max 差值不参与除法', () => {
    const g = buildGeometry([p(100), p(100), p(100)])
    expect(g.flat).toBe(true)
    expect(g.line).toBe('M0 50L500 50L1000 50')
    expect(g.gridY).toBe(50)
    expect(g.yMaxPct).toBe(50)
    expect(g.yMinPct).toBe(50)
  })

  it('两点一降：最高点贴顶部留白（14），最低点贴底部留白（86）', () => {
    const g = buildGeometry([p(110), p(100)])
    expect(g.line).toBe('M0 14L1000 86')
    expect(g.max).toBe(110)
    expect(g.min).toBe(100)
    expect(g.gridY).toBe(14)
    expect(g.lastXPct).toBe(100)
    expect(g.lastYPct).toBe(86)
  })

  it('正常多点：坐标单调递增、每点一个指令、不出现 NaN', () => {
    const g = buildGeometry([p(1), p(2), p(4), p(8)])
    expect(g.line.match(/[ML]/g)).toHaveLength(4)
    expect(g.line).not.toMatch(/NaN/)
    expect(g.lastXPct).toBe(100)
  })
})

/**
 * 横轴/副标题的文案与档位键都要能脱离 React 断言。
 * session 档位固定在美东，所以能写死期望值；滚动档位按本地时区读，
 * 只能用「相对本地某点」的锚点，不能假设测试机是哪个时区。
 */
describe('axisLabels · 横轴跟着真实窗口走', () => {
  // 周一 09:30–16:00 美东 = 14:30Z–21:00Z（EST）
  const OPEN = Date.UTC(2026, 10, 9, 14, 30)
  const CLOSE = Date.UTC(2026, 10, 9, 21, 0)

  /** 本地时间的某点（今天/偏移 N 天） */
  const localAt = (hour: number, minute = 0, dayOffset = 0): number => {
    const d = new Date()
    d.setHours(hour, minute, 0, 0)
    d.setDate(d.getDate() + dayOffset)
    return d.getTime()
  }

  it('session：三档都是美东时间，与本地时区无关', () => {
    expect(axisLabels('session', OPEN, CLOSE)).toEqual(['09:30', '12:45', '16:00'])
  })

  it('session：只开盘一小时时标签反映「已走到的位置」，不虚报 16:00', () => {
    expect(axisLabels('session', OPEN, OPEN + 3_600_000)).toEqual(['09:30', '10:00', '10:30'])
  })

  it('6h（同一天）：HH:MM，不带日期', () => {
    expect(axisLabels('6h', localAt(9), localAt(15))).toEqual(['09:00', '12:00', '15:00'])
  })

  it('7d（跨天）：带 MM-DD', () => {
    for (const label of axisLabels('7d', localAt(9), localAt(9, 0, 7))) {
      expect(label).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
    }
  })
})

describe('windowSubtitle · 窗口边界的注脚', () => {
  const localAt = (hour: number, minute = 0, dayOffset = 0): number => {
    const d = new Date()
    d.setHours(hour, minute, 0, 0)
    d.setDate(d.getDate() + dayOffset)
    return d.getTime()
  }

  it('session 用美东并写出两端', () => {
    expect(
      windowSubtitle('session', Date.UTC(2026, 10, 9, 14, 30), Date.UTC(2026, 10, 9, 19, 50)),
    ).toBe('美东 09:30 – 14:50')
  })

  it('滚动档位用本地时间，跨天时带日期', () => {
    expect(windowSubtitle('1h', localAt(9), localAt(10))).toBe('本地 09:00 – 10:00')
    expect(windowSubtitle('7d', localAt(9), localAt(9, 0, 7))).toMatch(
      /^\d{2}-\d{2} 09:00 – \d{2}-\d{2} 09:00$/,
    )
  })
})

describe('档位键与后端同构', () => {
  it('前端 RangeKey 与后端 HistoryRange 完全一致（谁加了档位另一边不跟上就编译不过）', () => {
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    const backend: Same<RangeKey, HistoryRange> = true
    const frontend: Same<HistoryRange, RangeKey> = true
    expect(backend && frontend).toBe(true)
    expect(RANGE_OPTIONS.map((o) => o.key)).toEqual([...HISTORY_RANGES])
  })
})

/**
 * 指标切换只重算几何，不重新取数。这里把三条曲线的「纵轴、零线、填充基线、
 * 角落文案」全部钉住——它们各自独立，任何一个跟着 value 走，图上就会出现
 * 「线是收益、比例尺是总资产」这种最难看也最误导的 bug。
 */
describe('buildGeometry · 纵轴跟着选中的序列走', () => {
  // 同一批点：总资产 8 万上下，当日收益 ±几百。量级差两个数量级。
  const points: HistoryPoint[] = [
    { tsMs: 0, value: 80_000, amount: -420.5, profit: 0, valuePre: null, amountPre: null },
    { tsMs: 1, value: 84_568, amount: 120, profit: 0, valuePre: null, amountPre: null },
    { tsMs: 2, value: 84_321, amount: 569.46, profit: 0, valuePre: null, amountPre: null },
  ]

  it('总资产：纵轴是总资产区间，不画零线（存量恒为正）', () => {
    const g = buildGeometry(points, 'value')
    expect(g.min).toBe(80_000)
    expect(g.max).toBe(84_568)
    expect(g.zeroY).toBeNull()
    // 填充仍然贴底：value 的「底」本来就没有语义
    expect(g.area.endsWith('L1000 100L0 100Z')).toBe(true)
  })

  it('当日收益：纵轴换成 amount 的区间（−420.5 ~ 569.46），不是 8 万', () => {
    const g = buildGeometry(points, 'amount')
    expect(g.min).toBe(-420.5)
    expect(g.max).toBe(569.46)
    expect(g.area).not.toBe(buildGeometry(points, 'value').area)
  })

  it('跨零：零基线落在框内，填充的基线也是零线而不是底边', () => {
    const g = buildGeometry(points, 'amount')
    expect(g.zeroY).not.toBeNull()
    // −420.5 在下、569.46 在上，零线严格落在中间
    expect(g.zeroY!).toBeGreaterThan(14)
    expect(g.zeroY!).toBeLessThan(86)
    // area 的两端基线 = 零线（y 相同），不是 100
    const match = /L1000 ([\d.]+)L0 \1Z$/.exec(g.area)
    expect(match, g.area).not.toBeNull()
    expect(Number(match![1])).toBeCloseTo(g.zeroY!, 5)
    expect(g.area).not.toMatch(/L1000 100L0 100Z/)
  })

  it('全零（历史行 total_profit 都是 0）：平线画在中线、不画零线、标签读 0.00', () => {
    const zeros = [p(84_000, 0), p(84_100, 1), p(84_200, 2)].map((row) => ({ ...row, profit: 0 }))
    const g = buildGeometry(zeros, 'profit')
    expect(g.flat).toBe(true)
    expect(g.max).toBe(0)
    expect(g.min).toBe(0)
    expect(g.line).toBe('M0 50L500 50L1000 50')
    expect(g.zeroY).toBeNull()
    // 退化区间不许除零：min/max 标签都压在中线
    expect(g.yMaxPct).toBe(50)
    expect(g.yMinPct).toBe(50)
    expect(deltaSummary(zeros, 'profit', '今日').text).toBe('今日 0.00')
  })

  it('全负（一直浮亏）：零线在框外，不画；填充贴顶而不是贴底', () => {
    const losing = [p(1, 0, { profit: -100 }), p(1, 1, { profit: -300 })]
    const g = buildGeometry(losing, 'profit')
    expect(g.max).toBe(-100)
    expect(g.min).toBe(-300)
    expect(g.zeroY).toBeNull()
    expect(g.area.endsWith('L1000 0L0 0Z')).toBe(true)
  })
})

describe('deltaSummary · 角落那句话必须跟指标对口径', () => {
  const points: HistoryPoint[] = [
    { tsMs: 0, value: 50_000, amount: 0, profit: 12_000, valuePre: null, amountPre: null },
    { tsMs: 1, value: 50_569.46, amount: 7_515.49, profit: 15_907.66, valuePre: null, amountPre: null },
  ]

  it('总资产：窗口内变化 + 百分比（百分比只对存量有意义）', () => {
    expect(deltaSummary(points, 'value', '今日')).toEqual({
      text: '今日 +569.46 (+1.14%)',
      tone: 'up',
    })
  })

  it('当日收益：最新一跳的水平值，不带百分比', () => {
    expect(deltaSummary(points, 'amount', '今日')).toEqual({
      text: '今日 +7,515.49',
      tone: 'up',
    })
  })

  it('持有收益：最新一跳的水平值，不带百分比', () => {
    expect(deltaSummary(points, 'profit', '今日')).toEqual({
      text: '今日 +15,907.66',
      tone: 'up',
    })
  })

  it('颜色按最新值的符号：负数走绿（跌），零算持平', () => {
    const negative: HistoryPoint[] = [
      { tsMs: 0, value: 1, amount: 800, profit: 0, valuePre: null, amountPre: null },
      { tsMs: 1, value: 1, amount: -500, profit: 0, valuePre: null, amountPre: null },
    ]
    expect(deltaSummary(negative, 'amount', '今日').tone).toBe('down')
    expect(deltaSummary(negative, 'amount', '今日').text).toBe('今日 -500.00')
    expect(
      deltaSummary(
        [{ tsMs: 0, value: 1, amount: 0, profit: 0, valuePre: null, amountPre: null }],
        'amount',
        '今日',
      ).tone,
    ).toBe('flat')
  })

  it('空数据与单点：总资产说「—」而不是 0.00，收益类仍给水平值', () => {
    expect(deltaSummary([], 'value', '今日').text).toBe('今日 —')
    expect(deltaSummary([p(84_000)], 'value', '今日').text).toBe('今日 —')
    expect(deltaSummary([p(84_000, 0, { profit: -2.5 })], 'profit', '今日').text).toBe('今日 -2.50')
  })
})

describe('指标键与后端字段同构', () => {
  it('三个指标名就是后端 point 上的字段名', () => {
    expect(METRIC_OPTIONS.map((o) => o.key)).toEqual(['value', 'amount', 'profit'])
    expect(METRIC_OPTIONS.map((o) => o.label)).toEqual(['总资产', '当日收益', '持有收益'])
    const backend: MetricKey[] = ['value', 'amount', 'profit']
    expect(backend).toEqual(METRIC_OPTIONS.map((o) => o.key))
  })

  it('默认总资产；非法值退回默认；标签有兜底', () => {
    expect(DEFAULT_METRIC).toBe('value')
    expect(isMetricKey('profit')).toBe(true)
    expect(isMetricKey('turnover')).toBe(false)
    expect(isMetricKey(null)).toBe(false)
    expect(metricLabel('amount')).toBe('当日收益')
  })

  it('localStorage 读不到（node 环境没有 window / 隐私模式抛错）时退回总资产', () => {
    expect(METRIC_STORAGE_KEY).toBe('pf-chart-metric')
    expect(readStoredMetric()).toBe('value')
  })
})

describe('preSessionPoints', () => {
  it('只留带盘前口径的点，并把盘前数铺到 value/amount', () => {
    const pts = [
      { tsMs: 1, value: 238_000, amount: 7_500, profit: 15_000, valuePre: null, amountPre: null },
      { tsMs: 2, value: 238_000, amount: 7_500, profit: 15_000, valuePre: 237_400, amountPre: -600 },
    ]
    expect(preSessionPoints(pts)).toEqual([
      { tsMs: 2, value: 237_400, amount: -600, profit: 15_000, valuePre: 237_400, amountPre: -600 },
    ])
  })

  it('一个都没有 → 空数组（前端显示暂无数据，而不是画一条贴着 0 的假线）', () => {
    expect(
      preSessionPoints([
        { tsMs: 1, value: 1, amount: 0, profit: 0, valuePre: null, amountPre: null },
      ]),
    ).toEqual([])
  })
})

describe('preDeltaSummary', () => {
  const pts = [
    { tsMs: 1, value: 237_500, amount: -500, profit: 15_000, valuePre: 237_500, amountPre: -500 },
    { tsMs: 2, value: 237_400, amount: -600, profit: 15_000, valuePre: 237_400, amountPre: -600 },
  ]

  it('变化量取最后一笔的累计，而不是「首末两点之差」', () => {
    // 首末差只有 -100，但盘前这一段实际是 -600（相对收盘）
    expect(preDeltaSummary(pts, '今日').text).toContain('-600.00')
  })

  it('百分比的分母是收盘估值（当前市值 − 累计收益）', () => {
    const close = 237_400 + 600
    expect(preDeltaSummary(pts, '今日').text).toContain(pctText((-600 / close) * 100))
  })

  it('空列表给「—」，不编数字', () => {
    expect(preDeltaSummary([], '今日')).toEqual({ text: '今日 —', tone: 'flat' })
  })
})

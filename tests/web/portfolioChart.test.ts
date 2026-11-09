// tests/web/portfolioChart.test.ts
import { describe, it, expect } from 'vitest'
import {
  RANGE_OPTIONS,
  axisLabels,
  buildGeometry,
  windowSubtitle,
  type HistoryPoint,
  type RangeKey,
} from '../../web/PortfolioChart'
import { HISTORY_RANGES, type HistoryRange } from '../../src/store/portfolio'

const p = (value: number, tsMs = 0): HistoryPoint => ({ tsMs, value, amount: 0 })

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

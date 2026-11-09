// tests/web/portfolioChart.test.ts
import { describe, it, expect } from 'vitest'
import { buildGeometry, type HistoryPoint } from '../../web/PortfolioChart'

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

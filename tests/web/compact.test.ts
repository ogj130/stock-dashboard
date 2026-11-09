import { describe, it, expect } from 'vitest'
import {
  COMPACT_POINT_LIMIT,
  DASH,
  PHASE_LIVE_TEXT,
  PHASE_SETTLED_TEXT,
  compactClock,
  deriveCompactView,
  isCompactQuery,
  tailPoints,
  type CompactFund,
  type CompactInput,
} from '../../web/compact'

/**
 * 小部件只有六个字段，任何一格显示错都会在桌面上挂一整天。
 * 所以这里钉的不是「渲染得像」，而是「缺数据时说了什么」：
 * 无数据 / 零覆盖 / 没有基金，三种降级各写一条。
 */

const fund = (over: Partial<CompactFund> = {}): CompactFund => ({
  marketValue: 10_000,
  amount: 120,
  holdingProfit: 2_000,
  coveredWeight: 0.99,
  ...over,
})

const input = (over: Partial<CompactInput> = {}): CompactInput => ({
  funds: [fund()],
  phase: 'live',
  updatedAt: null,
  loaded: true,
  error: null,
  ...over,
})

describe('isCompactQuery · 只认显式的 request', () => {
  it('?compact=1 → 小部件模式', () => {
    expect(isCompactQuery('?compact=1')).toBe(true)
  })

  it('带其它参数、顺序任意，仍然命中', () => {
    expect(isCompactQuery('?compact=1&note=a=b')).toBe(true)
    expect(isCompactQuery('?foo=2&compact=1')).toBe(true)
  })

  it('1 / true 都算开（大小写不敏感），手写 location.search 不带 ? 也认', () => {
    expect(isCompactQuery('?compact=true')).toBe(true)
    expect(isCompactQuery('?compact=TRUE')).toBe(true)
    expect(isCompactQuery('compact=1')).toBe(true)
  })

  it('0 / 空值 / 只有键名 / 别的前缀 → 完整页面', () => {
    expect(isCompactQuery('?compact=0')).toBe(false)
    expect(isCompactQuery('?compact=')).toBe(false)
    expect(isCompactQuery('?compact')).toBe(false)
    expect(isCompactQuery('?notcompact=1')).toBe(false)
    expect(isCompactQuery('')).toBe(false)
  })
})

describe('tailPoints · 迷你曲线只画最后一段', () => {
  it('超过上限时取末尾 N 个，保持时间顺序', () => {
    const points = Array.from({ length: 50 }, (_, i) => i)
    const tail = tailPoints(points)
    expect(tail).toHaveLength(COMPACT_POINT_LIMIT)
    expect(tail[0]).toBe(10)
    expect(tail[tail.length - 1]).toBe(49)
  })

  it('不足上限时原样返回（但必须是副本，别让调用方改到 state）', () => {
    const points = [1, 2, 3]
    const tail = tailPoints(points)
    expect(tail).toEqual([1, 2, 3])
    expect(tail).not.toBe(points)
  })

  it('空数组 / limit 0 → 空数组', () => {
    expect(tailPoints([])).toEqual([])
    expect(tailPoints([1, 2, 3], 0)).toEqual([])
  })
})

describe('compactClock · 没取到数据就不要写一个假时间', () => {
  it('null → —', () => {
    expect(compactClock(null)).toBe(DASH)
  })

  it('合法时间戳 → 本地 HH:MM', () => {
    const at = new Date(2026, 10, 9, 4, 32, 7).getTime()
    expect(compactClock(at)).toBe('04:32')
  })

  it('NaN → —（不要 "Invalid Date"）', () => {
    expect(compactClock(Number.NaN)).toBe(DASH)
  })
})

describe('deriveCompactView · 没有基金', () => {
  it('已加载但一只都没有 → 还没有基金，数字全是 —', () => {
    const view = deriveCompactView(input({ funds: [] }))
    expect(view.note).toBe('还没有基金')
    expect(view.totalText).toBe(DASH)
    expect(view.deltaText).toBe(DASH)
    expect(view.holdText).toBe(DASH)
    expect(view.deltaPctText).toBeNull()
    expect(view.quotesAvailable).toBe(false)
  })

  it('首轮还没回来 → 正在读取…', () => {
    const view = deriveCompactView(input({ funds: [], loaded: false }))
    expect(view.note).toBe('正在读取…')
  })

  it('空列表 + 请求失败 → 先认错，不说「还没有基金」', () => {
    const view = deriveCompactView(input({ funds: [], error: 'HTTP 500' }))
    expect(view.note).toBe('连不上后端')
  })
})

describe('deriveCompactView · 零覆盖', () => {
  it('所有持仓 coveredWeight = 0 → 行情不可用，绝不渲染一个假数字', () => {
    const view = deriveCompactView(
      input({
        funds: [
          fund({ coveredWeight: 0, amount: 88.8 }),
          fund({ marketValue: 5_000, coveredWeight: 0, amount: -12 }),
        ],
      }),
    )
    expect(view.deltaText).toBe('行情不可用')
    expect(view.deltaPctText).toBeNull()
    expect(view.deltaTone).toBe('flat')
    expect(view.quotesAvailable).toBe(false)
    // 总资产与持有收益不依赖行情，照常给
    expect(view.totalText).toBe('15,000.00')
    expect(view.holdText).toBe('+4,000.00')
    expect(view.blindCount).toBe(2)
  })

  it('部分覆盖 → 只在有行情的几只上求和，百分比分母也只取它们的市值', () => {
    const view = deriveCompactView(
      input({
        funds: [
          fund({ marketValue: 10_000, amount: 100, coveredWeight: 0.9 }),
          fund({ marketValue: 30_000, amount: 0, coveredWeight: 0 }),
        ],
      }),
    )
    expect(view.deltaText).toBe('+100.00')
    expect(view.deltaPctText).toBe('+1.00%')
    expect(view.blindCount).toBe(1)
    expect(view.quotesAvailable).toBe(true)
    // 总资产仍然是全部持仓
    expect(view.totalText).toBe('40,000.00')
  })

  it('有覆盖但市值是 0（刚建仓）→ 金额照给，百分比留 —', () => {
    const view = deriveCompactView(
      input({ funds: [fund({ marketValue: 0, amount: 0, coveredWeight: 0.5 })] }),
    )
    expect(view.deltaText).toBe('0.00')
    expect(view.deltaPctText).toBeNull()
    expect(view.deltaTone).toBe('flat')
  })
})

describe('deriveCompactView · 正常读数', () => {
  it('涨：红（up），带正号金额与百分比', () => {
    const view = deriveCompactView(
      input({
        funds: [fund({ marketValue: 49_618.91, amount: 1_686.26, holdingProfit: 14_332.62 })],
      }),
    )
    expect(view.totalText).toBe('49,618.91')
    expect(view.deltaText).toBe('+1,686.26')
    expect(view.deltaPctText).toBe('+3.40%')
    expect(view.deltaTone).toBe('up')
    expect(view.holdText).toBe('+14,332.62')
  })

  it('跌：绿（down），金额带负号', () => {
    const view = deriveCompactView(
      input({ funds: [fund({ marketValue: 10_000, amount: -250, holdingProfit: -800 })] }),
    )
    expect(view.deltaText).toBe('-250.00')
    expect(view.deltaPctText).toBe('-2.50%')
    expect(view.deltaTone).toBe('down')
    expect(view.holdText).toBe('-800.00')
  })

  it('持平：无色（flat），金额不带符号', () => {
    const view = deriveCompactView(
      input({ funds: [fund({ marketValue: 10_000, amount: 0 })] }),
    )
    expect(view.deltaText).toBe('0.00')
    expect(view.deltaTone).toBe('flat')
  })

  it('相位与更新时刻', () => {
    const at = new Date(2026, 10, 9, 4, 32, 7).getTime()
    expect(deriveCompactView(input({ phase: 'live', updatedAt: at })).phaseText).toBe(
      PHASE_LIVE_TEXT,
    )
    const settled = deriveCompactView(input({ phase: 'settled', updatedAt: at }))
    expect(settled.phaseText).toBe(PHASE_SETTLED_TEXT)
    expect(settled.clockText).toBe('04:32')
  })

  it('有基金但这一轮失败 → 数字沿用并标注连不上后端', () => {
    const view = deriveCompactView(input({ error: 'HTTP 500' }))
    expect(view.note).toBe('连不上后端')
    expect(view.totalText).toBe('10,000.00')
  })
})

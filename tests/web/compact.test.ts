import { describe, it, expect } from 'vitest'
import {
  COMPACT_POINT_LIMIT,
  DASH,
  PHASE_LIVE_TEXT,
  PHASE_SETTLED_TEXT,
  compactClock,
  deriveCompactView,
  deriveFundRows,
  isCompactQuery,
  tailPoints,
  type CompactFund,
  type CompactInput,
} from '../../web/compact'

/**
 * 小部件只有六个汇总字段 + 一列基金行，任何一格显示错都会在桌面上挂一整天。
 * 所以这里钉的不是「渲染得像」，而是「缺数据时说了什么」：
 * 无数据 / 零覆盖 / 没有基金，三种降级各写一条。
 */

const fund = (over: Partial<CompactFund> = {}): CompactFund => ({
  code: '161125',
  name: '易方达标普信息科技',
  marketValue: 10_000,
  amount: 120,
  holdingProfit: 2_000,
  navPct: 1.2,
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
    // 列表区没有行可画，卡片据此渲染 note 当空态（两者的文案是同一个来源）
    expect(view.rows).toEqual([])
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

describe('deriveFundRows · 全部基金按市值从大到小', () => {
  it('降序排；同市值按代码排（不依赖 sort 稳定性）', () => {
    const rows = deriveFundRows([
      fund({ code: '000001', marketValue: 5_000 }),
      fund({ code: '162411', marketValue: 30_000 }),
      fund({ code: '270042', marketValue: 5_000 }),
      fund({ code: '161125', marketValue: 18_000 }),
    ])
    expect(rows.map((r) => r.code)).toEqual(['162411', '161125', '000001', '270042'])
  })

  it('不修改入参（列表是从 state 派生的，改到原数组会污染轮询数据）', () => {
    const funds = [fund({ code: 'a', marketValue: 1 }), fund({ code: 'b', marketValue: 2 })]
    const before = funds.map((f) => f.code)
    deriveFundRows(funds)
    expect(funds.map((f) => f.code)).toEqual(before)
  })

  it('空列表 → 没有行', () => {
    expect(deriveFundRows([])).toEqual([])
  })
})

describe('deriveFundRows · 行内的降级与着色', () => {
  it('有覆盖：navPct 与 amount 各自来自 format.ts，各自着色', () => {
    const [up] = deriveFundRows([
      fund({ marketValue: 53_700, navPct: 2.92, amount: 1_568.2, coveredWeight: 0.62 }),
    ])
    expect(up).toMatchObject({
      name: '易方达标普信息科技',
      pctText: '+2.92%',
      pctTone: 'up',
      amountText: '+1,568.20',
      amountTone: 'up',
      covered: true,
    })
  })

  it('前十大权重（weightsFrom=top10 → coveredWeight 常在 0.4~0.7）照常显示，不额外标注', () => {
    const [row] = deriveFundRows([fund({ coveredWeight: 0.4276, navPct: 1.07, amount: 268.5 })])
    expect(row?.pctText).toBe('+1.07%')
    expect(row?.pctTone).toBe('up')
    expect(row?.covered).toBe(true)
  })

  it('零覆盖：百分比与金额都是 —，颜色是中性灰（汇率腿算出的数一个都不许露）', () => {
    const [row] = deriveFundRows([
      fund({ code: '968061', name: '某只无行情基金', coveredWeight: 0, navPct: 0.31, amount: 88.8 }),
    ])
    expect(row?.pctText).toBe(DASH)
    expect(row?.amountText).toBe(DASH)
    expect(row?.pctTone).toBe('flat')
    expect(row?.amountTone).toBe('flat')
    expect(row?.covered).toBe(false)
    // 市值照留：持仓是真的，只是这一天估不准
    expect(row?.marketValue).toBe(10_000)
  })

  it('跌：负数带 - 号且是 down', () => {
    const [row] = deriveFundRows([fund({ navPct: -1.4, amount: -212.5 })])
    expect(row?.pctText).toBe('-1.40%')
    expect(row?.pctTone).toBe('down')
    expect(row?.amountText).toBe('-212.50')
    expect(row?.amountTone).toBe('down')
  })

  it('持平：金额不带符号，颜色 flat', () => {
    const [row] = deriveFundRows([fund({ navPct: 0, amount: 0 })])
    expect(row?.pctText).toBe('0.00%')
    expect(row?.pctTone).toBe('flat')
    expect(row?.amountText).toBe('0.00')
    expect(row?.amountTone).toBe('flat')
  })

  it('名称缺失（空串 / 空白）→ 退回基金代码，不留一行空白', () => {
    const [row] = deriveFundRows([fund({ code: '162411', name: '   ' })])
    expect(row?.name).toBe('162411')
  })

  it('名称两端空白被清掉（列表按 px 算宽度，前导空格白占位）', () => {
    const [row] = deriveFundRows([fund({ name: '  广发纳指100A  ' })])
    expect(row?.name).toBe('广发纳指100A')
  })
})

describe('deriveCompactView · 列表随汇总一起派生', () => {
  it('16 只全部进 rows，顺序是市值降序，零覆盖那只在中间也如实标 —', () => {
    const funds = Array.from({ length: 16 }, (_, i) =>
      fund({
        code: `fund-${String(i).padStart(2, '0')}`,
        name: `基金 ${i}`,
        marketValue: (16 - i) * 1_000,
        // 第 6 只（从 0 数）没有可用行情
        coveredWeight: i === 5 ? 0 : 0.6,
        navPct: i % 2 === 0 ? 1.5 : -0.8,
        amount: i % 2 === 0 ? 15 : -8,
      }),
    )
    const view = deriveCompactView(input({ funds }))
    expect(view.rows).toHaveLength(16)
    expect(view.rows[0]?.marketValue).toBe(16_000)
    expect(view.rows[15]?.marketValue).toBe(1_000)
    expect(view.rows[5]?.pctText).toBe(DASH)
    expect(view.blindCount).toBe(1)
    // 汇总不受列表影响：总资产仍是全部 16 只
    expect(view.totalText).toBe('136,000.00')
  })
})

/**
 * 脚注第三段「· 夜盘 +0.32%」。
 *
 * 唯一必须守住的是「没有就不渲染」：盘前、周末、源挂了的时候，
 * 卡片上不能出现「夜盘 —」，也不能出现「夜盘 +0.00%」。
 */
describe('deriveCompactView · 夜盘段', () => {
  const night = (navPct: number, asOfMs = Date.parse('2026-11-10T00:59:00Z')) => ({
    navPct,
    amount: 0,
    coveredWeight: 0.9,
    asOfMs,
  })

  it('有夜盘数据 → 脚注第三段是加权后的百分比', () => {
    const view = deriveCompactView(
      input({
        funds: [
          fund({ code: 'A', marketValue: 90_000, afterHours: night(0.4) }),
          fund({ code: 'B', marketValue: 10_000, afterHours: night(-1.4) }),
        ],
      }),
    )
    // (0.4·9 − 1.4·1) / 10 = 0.22%
    expect(view.afterHoursText).toBe('夜盘 +0.22%')
  })

  it('只有一个基金有夜盘也照常显示（不是只在大仓位时才有）', () => {
    const view = deriveCompactView(
      input({ funds: [fund({ code: 'A', afterHours: night(1.234) }), fund({ code: 'B' })] }),
    )
    expect(view.afterHoursText).toBe('夜盘 +1.23%')
  })

  it('一只都没有 → null（整段不渲染，绝不写「夜盘 —」）', () => {
    const view = deriveCompactView(input({ funds: [fund(), fund({ code: 'B' })] }))
    expect(view.afterHoursText).toBeNull()
  })

  it('空列表 / 连不上后端时也是 null，不会凭空冒出一段夜盘', () => {
    expect(deriveCompactView(input({ funds: [] })).afterHoursText).toBeNull()
    expect(deriveCompactView(input({ funds: [], error: 'boom' })).afterHoursText).toBeNull()
  })
})

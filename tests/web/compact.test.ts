import { describe, it, expect } from 'vitest'
import {
  COMPACT_POINT_LIMIT,
  DASH,
  PHASE_LIVE_TEXT,
  PHASE_SETTLED_TEXT,
  compactClock,
  deriveCompactView,
  deriveFundRows,
  deriveKeyStocks,
  deriveNewsRows,
  isCompactQuery,
  matchesHolding,
  newsClock,
  shortenStockName,
  tailPoints,
  turnoverText,
  type CompactFund,
  type CompactInput,
  type KeyStockRow,
  type NewsItem,
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

  it('部分覆盖 → 只在有行情的几只上求和，百分比分母也只取它们的变动前市值', () => {
    const view = deriveCompactView(
      input({
        funds: [
          fund({ marketValue: 10_000, amount: 100, coveredWeight: 0.9 }),
          fund({ marketValue: 30_000, amount: 0, coveredWeight: 0 }),
        ],
      }),
    )
    expect(view.deltaText).toBe('+100.00')
    // 100 / (10,000 − 100) = 1.01%
    expect(view.deltaPctText).toBe('+1.01%')
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
    // 1,686.26 / (49,618.91 − 1,686.26) = 3.52%
    expect(view.deltaPctText).toBe('+3.52%')
    expect(view.deltaTone).toBe('up')
    expect(view.holdText).toBe('+14,332.62')
  })

  it('跌：绿（down），金额带负号', () => {
    const view = deriveCompactView(
      input({ funds: [fund({ marketValue: 10_000, amount: -250, holdingProfit: -800 })] }),
    )
    expect(view.deltaText).toBe('-250.00')
    // 250 / (10,000 + 250) = 2.44%（分母是跌之前的 10,250）
    expect(view.deltaPctText).toBe('-2.44%')
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

/* ---------- 个股 Tab ---------- */

const keyFund = (
  marketValue: number,
  breakdown?: Array<{ symbol: string; name: string; weight: number; pct: number; turnover?: number }>,
) => ({ marketValue, breakdown })

const stock = (over: Partial<KeyStockRow> = {}): KeyStockRow => ({
  symbol: 'NVDA',
  name: '英伟达',
  weightPct: 10,
  pct: 2,
  weightText: '10.00%',
  pctText: '+2.00%',
  pctTone: 'up',
  turnover: null,
  turnoverText: null,
  ...over,
})

describe('deriveKeyStocks · 多只基金的同一只票要合并', () => {
  it('同 symbol 合并成一行：暴露相加、涨跌按美元暴露加权', () => {
    const rows = deriveKeyStocks([
      keyFund(60_000, [{ symbol: 'NVDA', name: '英伟达', weight: 0.1, pct: 2 }]),
      keyFund(40_000, [{ symbol: 'NVDA', name: '', weight: 0.2, pct: 4 }]),
    ])
    expect(rows).toHaveLength(1)
    // 暴露 = 6,000 + 8,000；权重分母是全部基金市值 100,000
    expect(rows[0]).toMatchObject({
      symbol: 'NVDA',
      name: '英伟达',
      weightText: '14.00%',
      // (6,000×2 + 8,000×4) / 14,000 = 3.1428…
      pctText: '+3.14%',
      pctTone: 'up',
    })
  })

  it('权重分母含没有 breakdown 的基金（持仓是真的，只是看不到明细）', () => {
    const rows = deriveKeyStocks([
      keyFund(50_000, [{ symbol: 'AAPL', name: '苹果', weight: 0.2, pct: 1 }]),
      keyFund(50_000),
    ])
    expect(rows[0]!.weightText).toBe('10.00%')
  })

  it('按暴露降序、同暴露按 symbol 升序，超过 8 只截断', () => {
    const breakdown = Array.from({ length: 10 }, (_, i) => ({
      symbol: `S${i}`,
      name: `票${i}`,
      weight: 0.01,
      pct: 1,
    }))
    const rows = deriveKeyStocks([keyFund(100_000, breakdown)])
    expect(rows).toHaveLength(8)
    // 全部暴露相同（1,000），按 symbol 升序：S0..S7
    expect(rows.map((r) => r.symbol)).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'])
  })

  it('weight <= 0 / pct 非有限数 / 没有 breakdown → 跳过，不产出假 0', () => {
    const rows = deriveKeyStocks([
      keyFund(100_000, [
        { symbol: 'ZERO', name: '零权重', weight: 0, pct: 3 },
        { symbol: 'NAN', name: '坏数', weight: 0.1, pct: Number.NaN },
        { symbol: 'OK', name: '正常', weight: 0.1, pct: -1.5 },
      ]),
      keyFund(10_000),
    ])
    expect(rows.map((r) => r.symbol)).toEqual(['OK'])
    expect(rows[0]!.pctText).toBe('-1.50%')
    expect(rows[0]!.pctTone).toBe('down')
  })

  it('按当日成交额降序排（热度），不是按组合权重', () => {
    const rows = deriveKeyStocks([
      keyFund(100_000, [
        { symbol: 'BIG', name: '大仓位', weight: 0.3, pct: 1, turnover: 1_000 },
        { symbol: 'HOT', name: '热门', weight: 0.05, pct: 2, turnover: 9_000 },
      ]),
    ])
    expect(rows.map((r) => r.symbol)).toEqual(['HOT', 'BIG'])
    expect(rows[0]!.turnoverText).toBe('$9K')
    // 权重仍然如实显示（热度只决定顺序，不改口径）
    expect(rows[0]!.weightText).toBe('5.00%')
  })

  it('没有成交额时退回组合暴露降序（而不是把热度当成 0 排在最后）', () => {
    const rows = deriveKeyStocks([
      keyFund(100_000, [
        { symbol: 'A', name: '甲', weight: 0.01, pct: 1 },
        { symbol: 'B', name: '乙', weight: 0.2, pct: 1 },
      ]),
    ])
    expect(rows.map((r) => r.symbol)).toEqual(['B', 'A'])
    expect(rows[0]!.turnover).toBeNull()
    expect(rows[0]!.turnoverText).toBeNull()
  })

  it('成交额与暴露都相同时按 symbol 升序（显式次序，不靠 sort 稳定性）', () => {
    const rows = deriveKeyStocks([
      keyFund(100_000, [
        { symbol: 'ZZZ', name: 'Z', weight: 0.1, pct: 1, turnover: 5_000 },
        { symbol: 'AAA', name: 'A', weight: 0.1, pct: 1, turnover: 5_000 },
      ]),
    ])
    expect(rows.map((r) => r.symbol)).toEqual(['AAA', 'ZZZ'])
  })

  it('名称缺失时退回 symbol（宁可显示 NVDA，也不要一行空白）', () => {
    const rows = deriveKeyStocks([
      keyFund(10_000, [{ symbol: 'NVDA', name: '   ', weight: 0.5, pct: 1 }]),
    ])
    expect(rows[0]!.name).toBe('NVDA')
  })

  it('一股持仓数据都没有 → 空数组（卡片据此显示「暂无持仓明细」）', () => {
    expect(deriveKeyStocks([])).toEqual([])
    expect(deriveKeyStocks([keyFund(10_000)])).toEqual([])
  })
})

/* ---------- 大事 Tab ---------- */

/** 2026-11-12 01:30:47 北京时间 */
const NEWS_MS = Date.UTC(2026, 10, 11, 17, 30, 47)

const news = (over: Partial<NewsItem> = {}): NewsItem => ({
  id: 'n1',
  title: '英伟达盘后涨超 3%',
  url: 'https://wap.eastmoney.com/a/1.html',
  tsMs: NEWS_MS,
  important: false,
  ...over,
})

describe('newsClock · 北京时间', () => {
  it('epoch → 北京 HH:MM（不是本地时区）', () => {
    expect(newsClock(NEWS_MS)).toBe('01:30')
  })

  it('非法时间戳 → —，不写 Invalid Date', () => {
    expect(newsClock(0)).toBe(DASH)
    expect(newsClock(Number.NaN)).toBe(DASH)
  })
})

describe('matchesHolding · 只认标题里的持仓名', () => {
  const stocks = [stock({ symbol: 'NVDA', name: '英伟达' }), stock({ symbol: 'AAPL', name: '苹果' })]

  it('中文名包含即命中（长度 >= 2）', () => {
    expect(matchesHolding('英伟达发布新一代芯片', stocks)).toBe(true)
  })

  it('ticker 按词边界匹配、大小写不敏感', () => {
    expect(matchesHolding('nvda 盘后上涨', stocks)).toBe(true)
    expect(matchesHolding('(NVDA) 财报超预期', stocks)).toBe(true)
    // 拼写相近但不是这个词：不能算「持仓相关」
    expect(matchesHolding('NVDIA 的传闻', stocks)).toBe(false)
  })

  it('单字中文名不参与匹配（会误伤几乎所有标题）', () => {
    const single = [stock({ symbol: 'X', name: '美' })]
    expect(matchesHolding('美国通胀数据公布', single)).toBe(false)
  })

  it('没有持仓 → 一律 false', () => {
    expect(matchesHolding('英伟达发布新一代芯片', [])).toBe(false)
  })
})

describe('deriveNewsRows · 卡片要的三列', () => {
  const stocks = [stock({ symbol: 'NVDA', name: '英伟达' })]

  it('时间取北京时间、标题原样、标签来自 important / 命中', () => {
    const rows = deriveNewsRows([news({ important: true })], stocks, 5)
    expect(rows).toEqual([
      {
        id: 'n1',
        timeText: '01:30',
        title: '英伟达盘后涨超 3%',
        url: 'https://wap.eastmoney.com/a/1.html',
        important: true,
        related: true,
      },
    ])
  })

  it('不相关的快讯不带「持仓」标记', () => {
    const rows = deriveNewsRows([news({ title: '欧洲股市收盘再创纪录' })], stocks, 5)
    expect(rows[0]!.related).toBe(false)
  })

  it('只取前 limit 条，顺序由服务端决定', () => {
    const items = Array.from({ length: 8 }, (_, i) => news({ id: `n${i}`, title: `标题${i}` }))
    expect(deriveNewsRows(items, stocks, 5).map((r) => r.id)).toEqual([
      'n0',
      'n1',
      'n2',
      'n3',
      'n4',
    ])
  })

  it('空列表 → 空数组（卡片据此显示「资讯暂不可用」）', () => {
    expect(deriveNewsRows([], stocks, 5)).toEqual([])
  })
})


describe('shortenStockName · 卡片里只留能认人的部分', () => {
  it('剥掉公司形式与证券类型', () => {
    expect(shortenStockName('Apple Inc. Common Stock')).toBe('Apple')
    expect(shortenStockName('NVIDIA Corporation Common Stock')).toBe('NVIDIA')
    expect(shortenStockName('Meta Platforms, Inc. Class A Common Stock')).toBe('Meta Platforms')
    expect(shortenStockName('Broadcom Inc. Common Stock')).toBe('Broadcom')
  })

  it('中文简称原样保留', () => {
    expect(shortenStockName('英伟达')).toBe('英伟达')
    expect(shortenStockName('苹果')).toBe('苹果')
  })

  it('全是后缀的怪名字不被剥成空串（调用方还会再兜一次）', () => {
    expect(shortenStockName('')).toBe('')
    expect(shortenStockName('Corporation')).toBe('Corporation')
  })
})


describe('turnoverText · 成交额的人类读法', () => {
  it('十亿/百万量级用英文缩写', () => {
    expect(turnoverText(5_671_975_014)).toBe('$5.67B')
    expect(turnoverText(305_778_826)).toBe('$305.78M')
    expect(turnoverText(9_000)).toBe('$9K')
  })

  it('没有数据 / 0 / 非有限数 → null（标题里不写这一句）', () => {
    expect(turnoverText(null)).toBeNull()
    expect(turnoverText(0)).toBeNull()
    expect(turnoverText(Number.NaN)).toBeNull()
  })
})

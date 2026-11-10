import { describe, it, expect } from 'vitest'
import { parseSina } from '../../src/sources/sina'

const RAW = `var hq_str_gb_aapl="苹果,350.1200,2.26,2026-11-10 01:13:44,7.7500,344.9950,351.4200,344.7800,355.3800,242.8900";`

describe('sina', () => {
  it('取现价与涨跌幅', () => {
    const q = parseSina(RAW)[0]!
    expect(q.symbol).toBe('AAPL')
    expect(q.price).toBeCloseTo(350.12, 2)
    expect(q.pct).toBeCloseTo(2.26, 2)
  })
  it('昨收 = 现价 - 涨跌额', () => {
    expect(parseSina(RAW)[0]!.prevClose).toBeCloseTo(350.12 - 7.75, 2)
  })
})

// ---- 以下为加固用例：位置式字段缺失、垃圾报文、时区 ----
describe('sina 加固', () => {
  it('涨跌额缺失时用涨跌幅反推昨收', () => {
    const raw = `var hq_str_gb_msft="微软,500.0000,25.00,2026-11-10 01:07:03,,344.9950";`
    const q = parseSina(raw)[0]!
    expect(q.prevClose).toBeCloseTo(400, 4)
    expect(q.pct).toBeCloseTo(25, 4)
  })

  it('时间是北京时间，解析成毫秒', () => {
    expect(parseSina(RAW)[0]!.tsMs).toBe(Date.parse('2026-11-10T01:13:44+08:00'))
  })

  it('无价格的条目与非 gb_ 变量都被丢弃，绝不产出 NaN', () => {
    const raw = `var hq_str_gb_xx="乱码,,";\nvar hq_str_sh600000="浦发银行,1,2,3";`
    const q = parseSina(raw)
    expect(q).toHaveLength(0)
    expect(q.every((x) => Number.isFinite(x.price) && Number.isFinite(x.prevClose))).toBe(true)
  })
})

// ---- 盘后字段（夜盘估值的数据源） ----
//
// 报文取自实测：2026-11-10 12:44 CST（美东 2026-11-09 23:44，盘后已收盘）的
// `https://hq.sinajs.cn/list=gb_aapl`，36 个字段。下面这些都是位置式的真样本。
const AH_FIELDS = [
  '苹果', // [0]
  '350.6900', // [1] 常规收盘
  '2.43', // [2] 当日涨跌幅 %
  '2026-11-10 09:30:10', // [3] 北京时间
  '8.3200', // [4] 涨跌额
  '344.9950', // [5]
  '352.3300', // [6]
  '344.7800', // [7]
  '355.3800', // [8]
  '242.8900', // [9]
  '48753031', // [10]
  '56680400', // [11]
  '5096317836117', // [12]
  '8.30', // [13]
  '42.250000', // [14]
  '0.00', // [15]
  '0.68', // [16]
  '0.00', // [17]
  '0.00', // [18]
  '14532258793', // [19]
  '63', // [20]
  '350.5000', // [21] 盘后价
  '-0.05', // [22] 盘后涨跌幅 %
  '-0.19', // [23] 盘后涨跌额
  'Nov 09 07:59PM EST', // [24] 盘后最后一笔时刻
  'Nov 09 04:00PM EST', // [25] 常规收盘时刻
  '342.3700', // [26] 昨收
  '8566944', // [27]
  '1', // [28]
  '2026', // [29]
  '17077778235.0000', // [30]
  '352.0200', // [31]
  '330.3559', // [32]
  '3004259468.4064', // [33]
  '350.5000', // [34]
  '342.3700', // [35]
]

/** 拼一条报文；over 用下标覆盖任意字段（模拟「盘后字段缺失/被占位」的各种报文） */
function ahRaw(over: Record<number, string> = {}): string {
  const fields = AH_FIELDS.map((v, i) => over[i] ?? v)
  return `var hq_str_gb_aapl="${fields.join(',')}";`
}

/** 2026-11-09 23:04 EST —— 实测那次取数的时刻（美东当天是 11-09） */
const NOW = Date.parse('2026-11-10T04:04:00Z')

describe('sina · 盘后（夜盘）', () => {
  it('36 字段全在时解析出盘后价 / 涨跌幅 / 时刻', () => {
    expect(AH_FIELDS).toHaveLength(36)
    const q = parseSina(ahRaw(), NOW)[0]!
    expect(q.afterHoursPrice).toBeCloseTo(350.5, 4)
    // [22] 是盘后涨跌幅（百分数），基准是 [1] 常规收盘
    expect(q.afterHoursPct).toBeCloseTo(-0.05, 4)
    expect(q.afterHoursMs).toBe(Date.parse('2026-11-09T19:59:00-05:00'))
  })

  it('盘后价与常规收盘对得上：[22] 是百分比、[23] 才是涨跌额', () => {
    const q = parseSina(ahRaw(), NOW)[0]!
    const derived = (350.5 / 350.69 - 1) * 100
    expect(derived).toBeCloseTo(-0.0542, 3)
    // 报文 [22]=-0.05 是它的四舍五入；[23]=-0.19 恰好是价格差，不是百分比
    expect(q.afterHoursPct).toBeCloseTo(derived, 1)
    expect(Math.abs(350.5 - 350.69)).toBeCloseTo(0.19, 4)
  })

  it('[22] 与定义式矛盾时退回定义式（字段语义变了也不盲信位置）', () => {
    const q = parseSina(ahRaw({ 22: '9.99' }), NOW)[0]!
    expect(q.afterHoursPct).toBeCloseTo((350.5 / 350.69 - 1) * 100, 6)
  })

  it('[21] = 0.00（新浪的「没有盘后成交」占位）→ 三个字段一个都不给', () => {
    const q = parseSina(ahRaw({ 21: '0.00' }), NOW)[0]!
    expect(q.afterHoursPrice).toBeUndefined()
    expect(q.afterHoursPct).toBeUndefined()
    expect(q.afterHoursMs).toBeUndefined()
    expect('afterHoursPrice' in q).toBe(false)
  })

  it('[21] 缺失 / 为空 → 不给盘后字段（不是 0）', () => {
    for (const over of [{ 21: '' }, { 21: 'abc' }, { 21: '-1.00' }] as const) {
      const q = parseSina(ahRaw(over), NOW)[0]!
      expect(q.afterHoursPrice).toBeUndefined()
      // 常规行情照样在：盘后只是附加读数，缺了不许连累主行情
      expect(q.price).toBeCloseTo(350.69, 4)
    }
  })

  it('[24] 为空或解析不了 → 三个字段一起省掉（有价无时间等于没法展示）', () => {
    for (const time of ['', '   ', 'not a timestamp', '2026-11-09 07:59PM', 'Nov 32 07:59PM EST']) {
      const q = parseSina(ahRaw({ 24: time }), NOW)[0]!
      expect(q.afterHoursPrice).toBeUndefined()
      expect(q.afterHoursPct).toBeUndefined()
      expect(q.afterHoursMs).toBeUndefined()
    }
  })

  it('没有盘后字段的老报文（10 字段）不会凭空长出一个 afterHoursPrice', () => {
    expect(parseSina(RAW)[0]!.afterHoursPrice).toBeUndefined()
  })
})

describe('sina · 盘后时刻的年份推导', () => {
  /** 美东 2027-01-02 08:00 EST */
  const JAN2 = Date.parse('2027-01-02T13:00:00Z')

  it('跨年边界：1 月初收到 Dec 31 的报文 → 去年', () => {
    const q = parseSina(ahRaw({ 24: 'Dec 31 07:59PM EST' }), JAN2)[0]!
    expect(q.afterHoursMs).toBe(Date.parse('2026-12-31T19:59:00-05:00'))
  })

  it('昨天（Jan 01）不该被推成明年', () => {
    const q = parseSina(ahRaw({ 24: 'Jan 01 07:59PM EST' }), JAN2)[0]!
    expect(q.afterHoursMs).toBe(Date.parse('2027-01-01T19:59:00-05:00'))
  })

  it('今天（Jan 02）就是今天', () => {
    // 取数时刻是当天深夜（美东 Jan 02 23:30），报文里的 19:59 已经过去，不会被 clamp 干扰
    const late = Date.parse('2027-01-03T04:30:00Z')
    const q = parseSina(ahRaw({ 24: 'Jan 02 07:59PM EST' }), late)[0]!
    expect(q.afterHoursMs).toBe(Date.parse('2027-01-02T19:59:00-05:00'))
  })

  it('EDT 与 EST 分别按 -4 / -5 换算', () => {
    const now = Date.parse('2026-11-10T04:04:00Z')
    const est = parseSina(ahRaw({ 24: 'Nov 09 07:59PM EST' }), now)[0]!.afterHoursMs
    const edt = parseSina(ahRaw({ 24: 'Nov 09 07:59PM EDT' }), now)[0]!.afterHoursMs
    expect(est! - edt!).toBe(3_600_000)
  })

  it('未来时刻被 clamp 到 now：界面绝不显示「更新于未来」', () => {
    // 报文说 Nov 09 23:59 EST，而 now 是 Nov 09 23:04 EST
    const q = parseSina(ahRaw({ 24: 'Nov 09 11:59PM EST' }), NOW)[0]!
    expect(q.afterHoursMs).toBe(NOW)
  })
})

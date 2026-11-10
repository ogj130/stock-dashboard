import { describe, it, expect } from 'vitest'
import { openDb, type Db } from '../../src/store/db'
import {
  HISTORY_MAX_POINTS,
  SNAPSHOT_THROTTLE_MS,
  etWallClock,
  etWallClockToUtcMs,
  listWindow,
  parseRange,
  rangeFromHours,
  readHistory,
  preSessionWindow,
  recordSnapshot,
  sessionWindow,
} from '../../src/store/portfolio'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** 美东墙钟 → 测试里要用的 UTC 时间戳（就是被测的那个助手，独立断言见「DST」一节） */
const et = (y: number, m: number, d: number, h: number, mi = 0): number =>
  etWallClockToUtcMs(y, m, d, h, mi)

/** 用美东墙钟读数断言：写死 UTC 数字会在 DST 换季时变成一堆难读的 ±一小时 */
const etText = (ms: number): string =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms))

function seed(db: Db, stamps: number[], value = 100_000, amount = 0): void {
  const stmt = db.prepare(
    'insert into portfolio_snapshot (ts_ms, total_value, total_amount, fund_count) values (?,?,?,?)',
  )
  for (const ts of stamps) stmt.run(ts, value, amount, 2)
}

/** 一个交易日的整场（09:30–16:00 美东） */
const fullDay = (y: number, m: number, d: number) => ({
  startMs: et(y, m, d, 9, 30),
  endMs: et(y, m, d, 16),
})

describe('parseRange · 档位解析与回退', () => {
  it('五个合法档位原样通过', () => {
    for (const range of ['session', '1h', '6h', '24h', '7d'] as const) {
      expect(parseRange(range)).toBe(range)
    }
  })

  it('大小写与空白被吃掉：SESSION / " 6h " 都能认', () => {
    expect(parseRange('SESSION')).toBe('session')
    expect(parseRange(' 6h ')).toBe('6h')
  })

  it('未知值/空串/数字/undefined 一律退回 session（默认档不是 6 小时了）', () => {
    for (const raw of ['', '  ', '12h', 'week', 'null', 6, null, undefined, {}]) {
      expect(parseRange(raw)).toBe('session')
    }
  })
})

describe('rangeFromHours · 旧 ?hours= 的兼容映射', () => {
  it('取「装得下这个小时数的最小档位」', () => {
    expect(rangeFromHours(0)).toBe('1h')
    expect(rangeFromHours(1)).toBe('1h')
    expect(rangeFromHours(2)).toBe('6h')
    expect(rangeFromHours(6)).toBe('6h')
    expect(rangeFromHours(12)).toBe('24h')
    expect(rangeFromHours(24)).toBe('24h')
    expect(rangeFromHours(25)).toBe('7d')
    expect(rangeFromHours(72)).toBe('7d')
  })

  it('字符串按数字解析，坏值退回默认档', () => {
    expect(rangeFromHours('6')).toBe('6h')
    expect(rangeFromHours(' 24 ')).toBe('24h')
    for (const raw of ['', 'abc', 'NaN', null, undefined]) {
      expect(rangeFromHours(raw)).toBe('session')
    }
  })
})

describe('etWallClockToUtcMs · DST 两侧', () => {
  it('2026-07-06 用 EDT（−04:00）：09:30 美东 = 13:30Z', () => {
    const ts = etWallClockToUtcMs(2026, 7, 6, 9, 30)
    expect(ts).toBe(Date.UTC(2026, 6, 6, 13, 30))
    expect(etText(ts)).toBe('07/06/2026, 09:30')
  })

  it('2026-11-09 用 EST（−05:00）：09:30 美东 = 14:30Z', () => {
    const ts = etWallClockToUtcMs(2026, 11, 9, 9, 30)
    expect(ts).toBe(Date.UTC(2026, 10, 9, 14, 30))
    expect(etText(ts)).toBe('11/09/2026, 09:30')
  })

  it('DST 换季当天（2026-11-01）收盘 16:00 仍是 EST，不是 ±一小时', () => {
    const ts = etWallClockToUtcMs(2026, 11, 1, 16, 0)
    expect(ts).toBe(Date.UTC(2026, 10, 1, 21, 0))
    expect(etText(ts)).toBe('11/01/2026, 16:00')
  })

  it('etWallClock 的周几索引：2026-11-09 是周一（1）、11-07 是周六（6）', () => {
    expect(etWallClock(et(2026, 11, 9, 10)).weekday).toBe(1)
    expect(etWallClock(et(2026, 11, 7, 10)).weekday).toBe(6)
  })
})

describe('sessionWindow · 最近一个美股交易日', () => {
  it('工作日盘中：今天 09:30 → 现在', () => {
    const db = openDb(':memory:')
    const now = et(2026, 11, 9, 10, 15)
    seed(db, [now])
    const w = sessionWindow(db, now)
    expect(w.startMs).toBe(et(2026, 11, 9, 9, 30))
    expect(w.endMs).toBe(now)
    expect(etText(w.startMs)).toBe('11/09/2026, 09:30')
  })

  it('工作日开盘前（08:00）：退回上一个工作日（周五）的整场', () => {
    const db = openDb(':memory:')
    const friday = fullDay(2026, 11, 6)
    seed(db, [et(2026, 11, 6, 12)])
    const w = sessionWindow(db, et(2026, 11, 9, 8))
    expect(w).toEqual(friday)
    expect(etText(w.startMs)).toBe('11/06/2026, 09:30')
    expect(etText(w.endMs)).toBe('11/06/2026, 16:00')
  })

  it('周六：退回周五的整场', () => {
    const db = openDb(':memory:')
    seed(db, [et(2026, 11, 6, 12)])
    expect(sessionWindow(db, et(2026, 11, 7, 11))).toEqual(fullDay(2026, 11, 6))
  })

  it('周日：同样退回周五', () => {
    const db = openDb(':memory:')
    seed(db, [et(2026, 11, 6, 12)])
    expect(sessionWindow(db, et(2026, 11, 8, 20))).toEqual(fullDay(2026, 11, 6))
  })

  it('收盘后：仍是今天的整场，end 钉在 16:00 而不是「现在」', () => {
    const db = openDb(':memory:')
    seed(db, [et(2026, 11, 9, 12)])
    expect(sessionWindow(db, et(2026, 11, 9, 18))).toEqual(fullDay(2026, 11, 9))
  })

  it('节假日（感恩节）：算出来的那天一条快照都没有 → 回退到前一个工作日', () => {
    const db = openDb(':memory:')
    // 只有 11-25（周三）有数据；11-26（周四，感恩节）当天是空的
    seed(db, [et(2026, 11, 25, 12)])
    const w = sessionWindow(db, et(2026, 11, 26, 11))
    expect(w).toEqual(fullDay(2026, 11, 25))
  })

  it('空退最多 5 个工作日：长假后不会一直往前翻到史前', () => {
    const db = openDb(':memory:')
    // 库里只有三周前的数据，于是每一跳都落空：11/06→11/05→11/04→11/03→11/02 停
    seed(db, [et(2026, 10, 1, 12)])
    const w = sessionWindow(db, et(2026, 11, 9, 10))
    expect(w).toEqual(fullDay(2026, 11, 2))
  })

  it('空库：不回退（没有更早的数据可退），直接给今天这一场', () => {
    const db = openDb(':memory:')
    const now = et(2026, 11, 9, 10)
    expect(sessionWindow(db, now)).toEqual({
      startMs: et(2026, 11, 9, 9, 30),
      endMs: now,
    })
  })
})

describe('readHistory · 各档位的窗口与抽样', () => {
  const now = et(2026, 11, 9, 15)

  it('滚动档位的跨度就是档位名', () => {
    const db = openDb(':memory:')
    const spans: Array<[string, number]> = [
      ['1h', HOUR],
      ['6h', 6 * HOUR],
      ['24h', 24 * HOUR],
      ['7d', 7 * DAY],
    ]
    for (const [range, span] of spans) {
      const out = readHistory(db, range as '1h' | '6h' | '24h' | '7d', now)
      expect(out.range).toBe(range)
      expect(out.startMs).toBe(now - span)
      expect(out.endMs).toBe(now)
    }
  })

  it('session 档位只取 09:30–16:00 美东内的点，窗口外的点不混进来', () => {
    const db = openDb(':memory:')
    const inside = [et(2026, 11, 9, 9, 31), et(2026, 11, 9, 12), et(2026, 11, 9, 14, 59)]
    const outside = [
      et(2026, 11, 9, 9, 29), // 开盘前一分钟
      et(2026, 11, 9, 16, 1), // 收盘后一分钟
      et(2026, 11, 6, 12), // 上一个交易日
    ]
    seed(db, [...inside, ...outside])
    const out = readHistory(db, 'session', now)
    expect(out.points.map((p) => p.tsMs)).toEqual(inside)
    expect(out.startMs).toBe(et(2026, 11, 9, 9, 30))
    expect(out.endMs).toBe(now)
  })

  it('7 天内 5000 个点抽到 720 个，首尾都保留（末点=最新）', () => {
    const db = openDb(':memory:')
    const span = 7 * DAY
    const count = 5000
    const stamps = Array.from({ length: count }, (_, i) => now - (i * span) / (count - 1))
    seed(db, stamps)
    const out = readHistory(db, '7d', now)
    expect(out.points).toHaveLength(HISTORY_MAX_POINTS)
    expect(out.points[0]!.tsMs).toBe(now - span)
    expect(out.points[out.points.length - 1]!.tsMs).toBe(now)
    const ts = out.points.map((p) => p.tsMs)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
    expect(new Set(ts).size).toBe(HISTORY_MAX_POINTS)
  })

  it('点数不够上限时原样返回，金额与时间不被改写', () => {
    const db = openDb(':memory:')
    const stamps = Array.from({ length: 100 }, (_, i) => now - (100 - i) * MIN)
    seed(db, stamps)
    const out = readHistory(db, '6h', now)
    expect(out.points.map((p) => p.tsMs)).toEqual(stamps)
  })
})

/**
 * 写入侧的三个指标必须一起落库：曲线可以在「总资产 / 当日收益 / 持有收益」之间
 * 即时切换，靠的就是同一行里三列都有值——缺一列就得回头再查一次库。
 */
describe('recordSnapshot · 三个指标一起落库', () => {
  interface Row {
    total_value: number
    total_amount: number
    total_profit: number
    fund_count: number
  }

  it('value/amount/profit 各进各的列，并能被 listWindow 原样读出', () => {
    const db = openDb(':memory:')
    const now = et(2026, 11, 9, 10, 0)
    const wrote = recordSnapshot(
      db,
      { value: 100_000, amount: -120.5, profit: 15_907.66, fundCount: 2 },
      now,
    )
    expect(wrote).toBe(true)

    const row = db
      .prepare('select total_value, total_amount, total_profit, fund_count from portfolio_snapshot')
      .get() as unknown as Row
    expect(row.total_value).toBeCloseTo(100_000, 6)
    expect(row.total_amount).toBeCloseTo(-120.5, 6)
    expect(row.total_profit).toBeCloseTo(15_907.66, 6)
    expect(row.fund_count).toBe(2)

    const points = listWindow(db, { startMs: now - MIN, endMs: now + MIN })
    // 非盘前时段落的点没有盘前口径：null 而不是 0（0 会在图上画出断崖）
    expect(points).toEqual([
      {
        tsMs: now,
        value: 100_000,
        amount: -120.5,
        profit: 15_907.66,
        valuePre: null,
        amountPre: null,
      },
    ])
  })

  it('持有收益可以是负数（浮亏），不被 default/约束吃掉', () => {
    const db = openDb(':memory:')
    const now = et(2026, 11, 9, 10, 0)
    recordSnapshot(db, { value: 80_000, amount: 30, profit: -4_321.09, fundCount: 1 }, now)
    const points = listWindow(db, { startMs: now - MIN, endMs: now + MIN })
    expect(points[0]!.profit).toBeCloseTo(-4_321.09, 6)
  })

  it('30 秒内的第二跳被节流跳过（返回 false，不写行，也不改上一行）', () => {
    const db = openDb(':memory:')
    const now = et(2026, 11, 9, 10, 0)
    recordSnapshot(db, { value: 100_000, amount: 1, profit: 500, fundCount: 2 }, now)
    const skipped = recordSnapshot(
      db,
      { value: 999_999, amount: 9, profit: 9_999, fundCount: 2 },
      now + SNAPSHOT_THROTTLE_MS - 1,
    )
    expect(skipped).toBe(false)
    const rows = db.prepare('select total_value, total_profit from portfolio_snapshot').all() as unknown as Row[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.total_value).toBeCloseTo(100_000, 6)
    expect(rows[0]!.total_profit).toBeCloseTo(500, 6)

    // 过了一个节流窗口就可以写下一行
    expect(
      recordSnapshot(db, { value: 101_000, amount: 2, profit: 600, fundCount: 2 }, now + SNAPSHOT_THROTTLE_MS),
    ).toBe(true)
    expect((db.prepare('select count(*) c from portfolio_snapshot').get() as { c: number }).c).toBe(2)
  })
})

describe('preSessionWindow · 盘前那一段', () => {
  // 盘前是**今天**那一段（04:00–09:30 美东）。常规窗口的规则「还没开盘就退回
  // 上一个工作日」用在这里会把横轴指到昨天 09:30–16:00，
  // 于是头部写「盘前 -0.24%」、图画着昨天那一场，两处自相矛盾。
  it('盘前时段内：今天 04:00 → 现在（不越过 09:30）', () => {
    const db = openDb(':memory:')
    seed(db, [et(2026, 11, 10, 5, 0)])
    const now = et(2026, 11, 10, 6, 15)
    const w = preSessionWindow(db, now)
    expect(etText(w.startMs)).toBe('11/10/2026, 04:00')
    expect(etText(w.endMs)).toBe('11/10/2026, 06:15')
  })

  it('过了开盘时刻：右端钉在 09:30（盘前不含常规时段）', () => {
    const db = openDb(':memory:')
    seed(db, [et(2026, 11, 10, 5, 0)])
    const w = preSessionWindow(db, et(2026, 11, 10, 11, 0))
    expect(etText(w.endMs)).toBe('11/10/2026, 09:30')
  })

  it('凌晨四点前：退回上一个工作日的整段盘前', () => {
    const db = openDb(':memory:')
    seed(db, [et(2026, 11, 9, 6, 0)])
    const w = preSessionWindow(db, et(2026, 11, 10, 3, 0))
    expect(etText(w.startMs)).toBe('11/09/2026, 04:00')
    expect(etText(w.endMs)).toBe('11/09/2026, 09:30')
  })

  it('周末：退到上周五的盘前', () => {
    const db = openDb(':memory:')
    seed(db, [et(2026, 11, 6, 6, 0)])
    const w = preSessionWindow(db, et(2026, 11, 8, 12, 0))
    expect(etText(w.startMs)).toBe('11/06/2026, 04:00')
  })

  it('盘前窗口与常规窗口不是同一个窗口（否则切口径等于没切）', () => {
    const db = openDb(':memory:')
    seed(db, [et(2026, 11, 10, 5, 0)])
    const now = et(2026, 11, 10, 6, 0)
    const pre = preSessionWindow(db, now)
    const regular = sessionWindow(db, now)
    expect(pre.startMs).not.toBe(regular.startMs)
  })

  it('readHistory 传 pre 才用盘前窗口（默认行为一个字都不变）', () => {
    const db = openDb(':memory:')
    // 两天都落点：否则常规窗口找不到数据会顺工作日往前退，退到哪儿取决于回溯次数
    seed(db, [et(2026, 11, 9, 11, 0), et(2026, 11, 10, 5, 0)])
    const now = et(2026, 11, 10, 6, 0)
    const pre = readHistory(db, 'session', now, undefined, 'pre')
    const regular = readHistory(db, 'session', now)
    expect(etText(pre.startMs)).toBe('11/10/2026, 04:00')
    expect(etText(regular.startMs)).toBe('11/09/2026, 09:30')
  })
})

describe('recordSnapshot · 盘前口径', () => {
  it('传了盘前就落两列，没传就是 null（不是 0）', () => {
    const db = openDb(':memory:')
    const t1 = et(2026, 11, 10, 5, 0)
    recordSnapshot(db, {
      value: 238_000,
      amount: 7_500,
      profit: 15_000,
      fundCount: 16,
      valuePre: 237_400,
      amountPre: -600,
    }, t1)
    recordSnapshot(db, {
      value: 238_000,
      amount: 7_500,
      profit: 15_000,
      fundCount: 16,
    }, t1 + SNAPSHOT_THROTTLE_MS + 1)

    const points = listWindow(db, { startMs: t1 - MIN, endMs: t1 + 2 * MIN })
    expect(points.map((p) => p.valuePre)).toEqual([237_400, null])
    expect(points.map((p) => p.amountPre)).toEqual([-600, null])
  })
})

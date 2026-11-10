import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  AFTER_HOURS_BATCH,
  AFTER_HOURS_TTL_MS,
  createAfterHoursFetcher,
  type ReadBatch,
} from '../../src/sources/afterHours'

/**
 * 夜盘取数是一条「锦上添花」的腿：它失败的正确表现是**安静地什么都不给**，
 * 而不是让 /api/estimate 变成 500。所以这里钉的四件事是：
 * 分片、空响应、超时/异常、缓存——每一条都在「不许抛错」这条主线下。
 */

const NOW = Date.parse('2026-11-10T04:04:00Z')

/** 与 sina.test 同一份实测报文；只有 [21]/[22]/[24] 参与盘后解析 */
const FIELDS = [
  '苹果', '350.6900', '2.43', '2026-11-10 09:30:10', '8.3200', '344.9950', '352.3300',
  '344.7800', '355.3800', '242.8900', '48753031', '56680400', '5096317836117', '8.30',
  '42.250000', '0.00', '0.68', '0.00', '0.00', '14532258793', '63', '350.5000', '-0.05',
  '-0.19', 'Nov 09 07:59PM EST', 'Nov 09 04:00PM EST', '342.3700', '8566944', '1', '2026',
  '17077778235.0000', '352.0200', '330.3559', '3004259468.4064', '350.5000', '342.3700',
]

/**
 * 批量造符号。**必须是纯字母**：新浪的变量名正则 `hq_str_gb_([a-z.\-]+)` 不收数字，
 * 用 `S0/S1` 造样本会被当成「不是 gb_ 变量」而整条丢掉（实测踩过）。
 */
const sym = (prefix: string, i: number): string =>
  prefix + i.toString().replace(/[0-9]/g, (d) => 'ABCDEFGHIJ'[Number(d)]!)

/** 把 symbol 拼成一条「有盘后数据」的报文；名字无所谓，位置不能错 */
function line(symbol: string, ahPrice = '350.5000', ahTime = 'Nov 09 07:59PM EST'): string {
  const fields = [...FIELDS]
  fields[21] = ahPrice
  fields[24] = ahTime
  return `var hq_str_gb_${symbol.toLowerCase()}="${fields.join(',')}";`
}

/** 记录每批请求到的符号；按调用顺序返回对应的报文 */
function recordingReader(text: (batch: string[]) => string): {
  read: ReadBatch
  batches: string[][]
} {
  const batches: string[][] = []
  const read: ReadBatch = async (symbols) => {
    batches.push([...symbols])
    return text(symbols)
  }
  return { read, batches }
}

const fresh = (read: ReadBatch, ttlMs?: number) =>
  createAfterHoursFetcher({ readBatch: read, now: () => NOW, ...(ttlMs === undefined ? {} : { ttlMs }) })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('afterHours · 解析与分片', () => {
  it('按 100 只一片请求：250 只 → 100 / 100 / 50，结果全都在', async () => {
    const symbols = Array.from({ length: 250 }, (_, i) => sym('S', i))
    const { read, batches } = recordingReader((batch) => batch.map((s) => line(s)).join(';'))
    const got = await fresh(read)(symbols)

    expect(batches.map((b) => b.length)).toEqual([100, 100, 50])
    expect(batches.every((b) => b.length <= AFTER_HOURS_BATCH)).toBe(true)
    expect(got.size).toBe(250)
    expect(got.get(sym('S', 0))).toMatchObject({ symbol: sym('S', 0), price: 350.5 })
    expect(got.get(sym('S', 0))!.tsMs).toBe(Date.parse('2026-11-09T19:59:00-05:00'))
  })

  it('重复符号只问一次（多只基金持同一只票是常态）', async () => {
    const { read, batches } = recordingReader((batch) => batch.map((s) => line(s)).join(';'))
    const got = await fresh(read)(['AAPL', 'AAPL', 'AAPL'])
    expect(batches).toEqual([['AAPL']])
    expect(got.size).toBe(1)
  })

  it('没有盘后成交的票（[21]=0.00）不进结果，也不写 0 占位', async () => {
    const { read } = recordingReader((batch) =>
      batch.map((s, i) => line(s, i === 0 ? '0.00' : '350.5000')).join(';'),
    )
    const got = await fresh(read)(['AAPL', 'MSFT'])
    expect(got.has('AAPL')).toBe(false)
    expect(got.get('MSFT')!.price).toBeCloseTo(350.5, 4)
  })

  it('只问美股代码：纯数字（港股/A 股）先被滤掉，一次请求都不发', async () => {
    const { read, batches } = recordingReader((batch) => batch.map((s) => line(s)).join(';'))
    const got = await fresh(read)(['00700', '600000'])
    expect(batches).toEqual([])
    expect(got.size).toBe(0)
  })
})

describe('afterHours · 降级（永不抛错）', () => {
  it('空响应 → 空 Map', async () => {
    const { read } = recordingReader(() => '')
    await expect(fresh(read)(['AAPL'])).resolves.toEqual(new Map())
  })

  it('报文里没有 gb_ 变量（新浪限流/改版）→ 空 Map', async () => {
    const { read } = recordingReader(() => 'var hq_str_sh600000="浦发银行,1,2,3";')
    const got = await fresh(read)(['AAPL'])
    expect(got.size).toBe(0)
  })

  it('超时 / 抛异常 → 空 Map，绝不向上抛', async () => {
    const timedOut: ReadBatch = () => Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
    await expect(fresh(timedOut)(['AAPL', 'NVDA'])).resolves.toEqual(new Map())

    const boom: ReadBatch = () => {
      throw new Error('sina http 503')
    }
    await expect(fresh(boom)(['AAPL'])).resolves.toEqual(new Map())
  })

  it('一批挂掉不连坐另一批：坏的那批空着，好的那批照常返回', async () => {
    const read: ReadBatch = async (batch) => {
      if (batch.some((s) => s.startsWith('BAD'))) throw new Error('timeout')
      return batch.map((s) => line(s)).join(';')
    }
    const bad = Array.from({ length: 100 }, (_, i) => sym('BAD', i))
    const good = Array.from({ length: 50 }, (_, i) => sym('OK', i))
    const got = await fresh(read)([...bad, ...good])
    expect(got.has('BAD0')).toBe(false)
    expect(got.size).toBe(50)
  })

  it('真实网络入口在 fetch 被掐断时也不抛（默认 readBatch 的兜底）', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('network down')
    })
    const got = await createAfterHoursFetcher({ now: () => NOW })(['AAPL'])
    expect(got.size).toBe(0)
  })
})

describe('afterHours · 60 秒缓存', () => {
  it('TTL 内重复调用不再发请求（前端 5 秒轮询 × 一分钟 = 12 次 → 1 次）', async () => {
    const { read, batches } = recordingReader((batch) => batch.map((s) => line(s)).join(';'))
    const fetchOnce = createAfterHoursFetcher({ readBatch: read, now: () => NOW })
    await fetchOnce(['AAPL'])
    await fetchOnce(['AAPL'])
    await fetchOnce(['AAPL'])
    expect(batches).toHaveLength(1)
  })

  it('过了 TTL 重新取（时间源可注入，不用真等 61 秒）', async () => {
    let clock = NOW
    const { read, batches } = recordingReader((batch) => batch.map((s) => line(s)).join(';'))
    const fetchIt = createAfterHoursFetcher({ readBatch: read, now: () => clock })
    await fetchIt(['AAPL'])
    clock = NOW + AFTER_HOURS_TTL_MS - 1
    await fetchIt(['AAPL'])
    expect(batches).toHaveLength(1)
    clock = NOW + AFTER_HOURS_TTL_MS + 1
    await fetchIt(['AAPL'])
    expect(batches).toHaveLength(2)
  })

  it('阴性结果也缓存：没有盘后成交的票一分钟内不反复重问', async () => {
    const { read, batches } = recordingReader(() => '')
    const fetchIt = createAfterHoursFetcher({ readBatch: read, now: () => NOW })
    await fetchIt(['AAPL'])
    await fetchIt(['AAPL'])
    expect(batches).toHaveLength(1)
  })

  it('缓存里只有部分符号命中时，只补问缺的那几只', async () => {
    const { read, batches } = recordingReader((batch) => batch.map((s) => line(s)).join(';'))
    const fetchIt = createAfterHoursFetcher({ readBatch: read, now: () => NOW })
    await fetchIt(['AAPL'])
    await fetchIt(['AAPL', 'NVDA'])
    expect(batches).toEqual([['AAPL'], ['NVDA']])
  })
})

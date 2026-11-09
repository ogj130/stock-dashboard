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

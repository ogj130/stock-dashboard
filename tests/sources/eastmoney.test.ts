import { describe, it, expect } from 'vitest'
import { normalizeEastmoney, toSecid } from '../../src/sources/eastmoney'

const RAW = {
  data: {
    diff: [
      { f2: 350170, f3: 228, f12: 'AAPL', f13: 105, f14: '苹果', f18: 342370 },
      { f2: 542330, f3: 221, f12: 'MSFT', f13: 105, f14: '微软', f18: 530610 },
    ],
  },
}

describe('eastmoney', () => {
  it('价格放大 1000 倍要还原，涨跌幅放大 100 倍要还原', () => {
    const q = normalizeEastmoney(RAW)[0]!
    expect(q.symbol).toBe('AAPL')
    expect(q.price).toBeCloseTo(350.17, 3)
    expect(q.prevClose).toBeCloseTo(342.37, 3)
    expect(q.pct).toBeCloseTo(2.28, 3)
  })

  it('沪深美股市场码映射正确', () => {
    expect(toSecid('AAPL', 105)).toBe('105.AAPL')
    expect(toSecid('IBM', 106)).toBe('106.IBM')
  })

  it('缺字段的条目被丢弃而不是产生 NaN', () => {
    const q = normalizeEastmoney({ data: { diff: [{ f12: 'X' }] } })
    expect(q).toHaveLength(0)
  })
})

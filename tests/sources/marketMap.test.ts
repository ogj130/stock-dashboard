import { describe, it, expect } from 'vitest'
import { openDb } from '../../src/store/db'
import { MarketMap } from '../../src/sources/marketMap'

const never = async () => { throw new Error('should not fetch') }

describe('MarketMap', () => {
  it('已缓存的直接返回，不发起探测', async () => {
    const db = openDb(':memory:')
    const m = new MarketMap(db, never)
    m.remember('AAPL', 105)
    expect(await m.resolve(['AAPL'])).toEqual({ AAPL: 105 })
  })

  it('未知符号交给探测器，并写回缓存', async () => {
    const db = openDb(':memory:')
    const probe = async (sym: string) => (sym === 'IBM' ? 106 : null)
    const m = new MarketMap(db, probe)
    expect(await m.resolve(['IBM'])).toEqual({ IBM: 106 })
    // 第二次不再探测
    const m2 = new MarketMap(db, never)
    expect(await m2.resolve(['IBM'])).toEqual({ IBM: 106 })
  })

  it('探测不出市场码的符号不出现在结果里', async () => {
    const db = openDb(':memory:')
    const m = new MarketMap(db, async () => null)
    expect(await m.resolve(['ZZZZ'])).toEqual({})
  })
})

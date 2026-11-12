import { describe, it, expect } from 'vitest'
import { parseTencent } from '../../src/sources/tencent'

// 实测报文（2026-11-10 01:36 采集），以索引对齐方式截取前 38 个字段：
// [0]状态 [1]名称 [2]代码 [3]现价 [4]昨收 [5]今开 ... [30]时间 [31]涨跌额 [32]涨跌幅
// [33]高 [34]低 [35]币种 [36]成交量 [37]成交额
const RAW = `v_usAAPL="${['200', '苹果', 'AAPL.OQ', '349.58', '342.37', '345.00', '15566421',
  ...Array(23).fill('0'), '2026-11-09 12:36:20', '7.21', '2.10', '351.42', '344.78', 'USD',
  '15566421', '5671975014'].join('~')}";`;

describe('tencent', () => {
  it('按字段索引取现价/昨收/涨跌幅', () => {
    const q = parseTencent(RAW)[0]!
    expect(q.symbol).toBe('AAPL')
    expect(q.price).toBeCloseTo(349.58, 2)
    expect(q.prevClose).toBeCloseTo(342.37, 2)
    expect(q.pct).toBeCloseTo(2.1, 2)
  })

  it('中文名与成交额：卡片「个股」的中文名与热度排序都靠这两个字段', () => {
    const q = parseTencent(RAW)[0]!
    expect(q.name).toBe('苹果')
    expect(q.turnover).toBe(5_671_975_014)
  })

  it('缺成交额时不留键（卡片据此退回按组合权重排序）', () => {
    const q = parseTencent('v_usAAPL="200~苹果~AAPL.OQ~1~1";')[0]!
    expect(q.name).toBe('苹果')
    expect(q).not.toHaveProperty('turnover')
  })

  it('时间戳按美东解析成毫秒', () => {
    const q = parseTencent(RAW)[0]!
    expect(q.tsMs).toBe(Date.parse('2026-11-09T12:36:20-05:00'))
  })

  it('状态码非 200 的条目被丢弃', () => {
    expect(parseTencent('v_usXXXX="301~x~x";')).toHaveLength(0)
  })
})

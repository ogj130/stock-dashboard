import type { Quote } from '../types'
import type { Capability, QuoteSource } from './types'

/**
 * L4 可选推流源，**默认不注册**进 registry。
 *
 * 选型结论（2026-11-10 定，勿改）：免费层只有 IEX 单一交易所，成交量占全市场 2~3%，
 * 价格与 consolidated tape 存在系统性偏离，会污染估值。国内三家（东财/腾讯/新浪）
 * 已免费实时无 key，感知上等同推流。所以这里只留接口骨架。
 *
 * 启用方式：设置 ALPACA_KEY_ID / ALPACA_SECRET_KEY，
 * 并在 createRegistry() 里把 new AlpacaSource() 加进 sources 数组。
 */

interface Snapshot {
  latestTrade?: { p?: number; t?: string }
  prevDailyBar?: { c?: number }
}

export class AlpacaSource implements QuoteSource {
  id = 'alpaca'
  maxBatch = 100
  sep = ','
  capabilities: Capability[] = ['quote', 'stream']

  constructor(
    private keyId = process.env.ALPACA_KEY_ID ?? '',
    private secret = process.env.ALPACA_SECRET_KEY ?? '',
  ) {}

  get enabled(): boolean {
    return Boolean(this.keyId && this.secret)
  }

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    if (!this.enabled) throw new Error('alpaca credentials missing')
    if (symbols.length === 0) return []
    const list = symbols.slice(0, this.maxBatch).join(',')
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${list}&feed=iex`,
      { headers: { 'APCA-API-KEY-ID': this.keyId, 'APCA-API-SECRET-KEY': this.secret } },
    )
    if (!res.ok) throw new Error(`alpaca http ${res.status}`)
    const body = (await res.json()) as Record<string, Snapshot>
    const out: Quote[] = []
    for (const [symbol, snap] of Object.entries(body)) {
      const price = snap?.latestTrade?.p
      if (!symbol || typeof price !== 'number' || !Number.isFinite(price)) continue
      const prevClose = snap?.prevDailyBar?.c ?? price
      out.push({
        symbol,
        price,
        prevClose,
        pct: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
        // 骨架阶段不追精度：IEX 时间戳带 Z，解析失败退回当前时间，绝不下传 NaN
        tsMs: Date.parse(snap?.latestTrade?.t ?? '') || Date.now(),
        precision: 2,
        sourceId: 'alpaca',
      })
    }
    return out
  }
}

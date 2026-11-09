import type { MarketSnapshot, Quote } from '../types'

export type Capability = 'quote' | 'marketStatus' | 'prepost' | 'stream'

export interface QuoteSource {
  id: string
  maxBatch: number
  sep: string
  capabilities: Capability[]
  fetchQuotes(symbols: string[]): Promise<Quote[]>
  fetchMarketStatus?(): Promise<MarketSnapshot>
  /**
   * 可选：该源能否为这个 symbol 取到行情。不声明表示「都有，都试试」。
   *
   * 声明后 registry 只把「它能取到的」符号问给它，也不会因为它跳过了一批符号
   * 就把它记成失败。东财的市场码来自持仓报文，取不到时它自己会跳过；
   * 而腾讯/新浪/CNBC 只认美股代码，5 位纯数字（港股 00992、A 股）问它们只会整批空返回，
   * 若照单全问反倒把三个源一起误降级。
   */
  resolves?(symbol: string): boolean
}

/** 腾讯（us 前缀）、新浪（gb_ 前缀）、CNBC 只服务美股代码；纯数字（港股/A 股）它们取不到。 */
export function isUsTicker(symbol: string): boolean {
  return !/^\d+$/.test(symbol)
}

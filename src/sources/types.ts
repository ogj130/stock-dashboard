import type { MarketSnapshot, Quote } from '../types'

export type Capability = 'quote' | 'marketStatus' | 'prepost' | 'stream'

export interface QuoteSource {
  id: string
  maxBatch: number
  sep: string
  capabilities: Capability[]
  fetchQuotes(symbols: string[]): Promise<Quote[]>
  fetchMarketStatus?(): Promise<MarketSnapshot>
}

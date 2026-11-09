import type { Db } from '../store/db'

export type MarketProbe = (symbol: string) => Promise<number | null>

/**
 * 东财 secids 的市场码映射。猜错会让整批请求返回 data:null，所以必须探测而非假设。
 * 映射持久化到 quote_symbol_market 表，探测只在新符号首次出现时发生。
 */
export class MarketMap {
  private cache = new Map<string, number>()

  constructor(private db: Db, private probe: MarketProbe) {
    // 表由 store/db 的迁移建好（v1 含 quote_symbol_market），这里不再 create table：
    // 自建表会绕过版本化迁移，是 schema 漂移的源头。
    const rows = this.db
      .prepare('select symbol, market from quote_symbol_market')
      .all() as unknown as Array<{ symbol: string; market: number }>
    for (const r of rows) this.cache.set(r.symbol, r.market)
  }

  remember(symbol: string, market: number): void {
    this.cache.set(symbol, market)
    this.db
      .prepare(
        `insert into quote_symbol_market (symbol, market, updated_at) values (?,?,?)
         on conflict(symbol) do update set market=excluded.market, updated_at=excluded.updated_at`,
      )
      .run(symbol, market, Date.now())
  }

  get(symbol: string): number | undefined {
    return this.cache.get(symbol)
  }

  async resolve(symbols: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const s of symbols) {
      const hit = this.cache.get(s)
      if (hit !== undefined) {
        out[s] = hit
        continue
      }
      const probed = await this.probe(s).catch(() => null)
      if (probed !== null) {
        this.remember(s, probed)
        out[s] = probed
      }
    }
    return out
  }
}

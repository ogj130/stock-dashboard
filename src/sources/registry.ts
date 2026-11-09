import { CONFIG } from '../config'
import type { Quote } from '../types'
import type { QuoteSource } from './types'

interface Options {
  crossCheck?: boolean
}

/**
 * 梯队注册表：按优先级取源，连续失败则冷却降级，主备偏差过大时引入第三方裁决。
 *
 * 两个必须防住的静默事故（见 plan Task 8 的实测记录）：
 * 1. 东财 market 码错 → 整批 data:null → normalizeEastmoney 返回 [] 而不抛错，
 *    所以「返回条数 < 请求条数」必须算失败，不能只看有没有异常。
 * 2. 每个源都会 symbols.slice(0, maxBatch)，150 只直接截成 100 只且不报错，
 *    所以这里必须自己按 maxBatch 分片。
 */
export class QuoteRegistry {
  private failures = new Map<string, number>()
  private degradedUntil = new Map<string, number>()
  private conflicts: string[] = []

  constructor(private sources: QuoteSource[]) {
    if (sources.length === 0) throw new Error('registry needs at least one source')
  }

  /** 上一轮因主备冲突被拒绝写入的符号 */
  lastConflicts(): string[] {
    return [...this.conflicts]
  }

  /** 未降级的源排在前面；同组内保持构造时的优先级顺序 */
  private order(): QuoteSource[] {
    const now = Date.now()
    return [...this.sources].sort((a, b) => {
      const da = (this.degradedUntil.get(a.id) ?? 0) > now ? 1 : 0
      const db = (this.degradedUntil.get(b.id) ?? 0) > now ? 1 : 0
      return da - db
    })
  }

  private markFailure(id: string): void {
    const n = (this.failures.get(id) ?? 0) + 1
    this.failures.set(id, n)
    if (n >= CONFIG.degradeAfterFailures) {
      this.degradedUntil.set(id, Date.now() + CONFIG.degradeCooldownMs)
      this.failures.set(id, 0)
    }
  }

  async getQuotes(symbols: string[], opts: Options = {}): Promise<Map<string, Quote>> {
    this.conflicts = []
    // 去重后比较条数：同一只票被多个基金持有时会重复传进来，
    // 直接用 symbols.length 当分母会把正常响应误判成「缺票」。
    const wanted = [...new Set(symbols)]
    if (wanted.length === 0) return new Map()

    const order = this.order()
    let serving: QuoteSource | undefined
    let primaryMap: Map<string, Quote> | undefined

    for (const src of order) {
      try {
        const got = index(await fetchAll(src, wanted))
        // 条数不足同样是失败：东财 market 码错时整批返回 data:null 且不抛错
        if (got.size < wanted.length) throw new Error(`${src.id} incomplete ${got.size}/${wanted.length}`)
        primaryMap = got
        serving = src
        this.failures.set(src.id, 0)
        break
      } catch {
        this.markFailure(src.id)
      }
    }
    if (!primaryMap || !serving) throw new Error('all sources failed')

    if (!opts.crossCheck) return primaryMap

    // 交叉校验必须换一个源问：主源降级时被问过的源再问一遍毫无意义
    const candidates = order.filter((s) => s.id !== serving.id)
    const checker = candidates[0]
    if (!checker) return primaryMap

    let checkMap: Map<string, Quote>
    try {
      checkMap = index(await fetchAll(checker, wanted))
    } catch {
      return primaryMap
    }

    const arbiter = candidates[1]
    const result = new Map(primaryMap)
    for (const [sym, p] of primaryMap) {
      const c = checkMap.get(sym)
      if (!c || p.price === 0 || c.price === 0) continue
      const diff = Math.abs(p.price - c.price) / p.price
      if (diff <= CONFIG.conflictTolerance) continue

      // 偏差超限：必须第三方裁决，裁不了就不写，绝不靠猜
      if (!arbiter) {
        result.delete(sym)
        this.conflicts.push(sym)
        continue
      }
      try {
        const a = index(await fetchAll(arbiter, [sym])).get(sym)
        if (!a) {
          result.delete(sym)
          this.conflicts.push(sym)
          continue
        }
        const da = Math.abs(p.price - a.price) / p.price
        const dc = Math.abs(c.price - a.price) / c.price
        if (da <= dc) continue // 主源与第三方更接近，保留主源
        result.set(sym, c) // 备源更接近第三方，改用备源
      } catch {
        result.delete(sym)
        this.conflicts.push(sym)
      }
    }
    return result
  }
}

function index(list: Quote[]): Map<string, Quote> {
  return new Map(list.map((q) => [q.symbol, q]))
}

/** 按源声明的 maxBatch 分片，避免超过上限被源自己 slice 掉一半 */
async function fetchAll(source: QuoteSource, symbols: string[], timeoutMs = 5000): Promise<Quote[]> {
  const size = Math.max(1, source.maxBatch)
  const out: Quote[] = []
  for (let i = 0; i < symbols.length; i += size) {
    const chunk = symbols.slice(i, i + size)
    out.push(...(await withTimeout(source.fetchQuotes(chunk), timeoutMs)))
  }
  return out
}

/** 防挂死。不真正取消底层请求，但保证调用方能往下走。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`source timeout ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

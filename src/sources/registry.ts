import { CONFIG } from '../config'
import type { Quote } from '../types'
import type { QuoteSource } from './types'

interface Options {
  crossCheck?: boolean
}

/**
 * 梯队注册表：按优先级取源，连续失败则冷却降级，主备偏差过大时引入第三方裁决。
 *
 * getQuotes 的契约（Task 7.5 加固后）：
 * - 返回**实际拿到的**行情，允许少于请求；缺口用 `lastMissing()` 暴露。
 *   一只票取不到（港股、市场码未知、涨跌幅非法）不再连坐整批——实测 160644 同时持有
 *   美股与港股，旧实现「池化结果不足即抛 all sources failed」让所有基金都没有估值。
 * - 只有「问过至少一个源、却一条都没拿到」才抛 `all sources failed`，那才是真故障。
 * - `pct` 非有限的行直接丢弃：它是唯一被产品消费的字段，NaN 会静默污染 Σw·pct。
 * - 后一个源只补前一个源的缺口，避免重复请求已拿到的符号。
 *
 * 两个必须防住的静默事故（见 plan Task 8 的实测记录）：
 * 1. 东财 market 码错 → 整批 data:null → normalizeEastmoney 返回 [] 而不抛错，
 *    所以「问过却一条没回」必须算失败，不能只看有没有异常。
 * 2. 每个源都会 symbols.slice(0, maxBatch)，150 只直接截成 100 只且不报错，
 *    所以这里必须自己按 maxBatch 分片。
 */
export class QuoteRegistry {
  private failures = new Map<string, number>()
  private degradedUntil = new Map<string, number>()
  private conflicts: string[] = []
  private missing: string[] = []

  constructor(private sources: QuoteSource[]) {
    if (sources.length === 0) throw new Error('registry needs at least one source')
  }

  /** 上一轮因主备冲突被拒绝写入的符号 */
  lastConflicts(): string[] {
    return [...this.conflicts]
  }

  /** 上一轮没拿到的符号：市场码未知、所有源都缺、pct 非法、或冲突无法裁决 */
  lastMissing(): string[] {
    return [...this.missing]
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

  /** 源没声明 resolves 就当作「都能试」 */
  private canResolve(src: QuoteSource, symbol: string): boolean {
    return src.resolves ? src.resolves(symbol) : true
  }

  async getQuotes(symbols: string[], opts: Options = {}): Promise<Map<string, Quote>> {
    this.conflicts = []
    this.missing = []
    // 去重后比较条数：同一只票被多个基金持有时会重复传进来，
    // 直接用 symbols.length 当分母会把正常响应误判成「缺票」。
    const wanted = [...new Set(symbols)]
    if (wanted.length === 0) return new Map()

    const order = this.order()
    const merged = new Map<string, Quote>()
    const contributed = new Set<string>()
    // 问过、一条没回的源：等确认「确实有源能回」再记账。
    // 全军覆没时记谁都没意义（马上就要抛错），而只含港股的批次也不该把美股源降级。
    const emptyReply: string[] = []
    let attempted = false

    for (const src of order) {
      const gap = wanted.filter((s) => !merged.has(s) && this.canResolve(src, s))
      if (gap.length === 0) continue
      attempted = true
      try {
        const got = usable(await fetchAll(src, gap), gap)
        if (got.size === 0) {
          emptyReply.push(src.id)
          continue
        }
        this.failures.set(src.id, 0)
        contributed.add(src.id)
        for (const [sym, q] of got) merged.set(sym, q)
      } catch {
        this.markFailure(src.id)
      }
    }

    if (merged.size > 0) {
      for (const id of emptyReply) this.markFailure(id)
    } else if (attempted) {
      throw new Error('all sources failed')
    }

    const result =
      opts.crossCheck && merged.size > 0
        ? await this.crossCheck(order.filter((s) => !contributed.has(s.id)), merged)
        : merged

    this.missing = wanted.filter((s) => !result.has(s))
    return result
  }

  /**
   * 交叉校验必须换一个源问：提供过数据的源再问一遍毫无意义。
   *
   * 校验源缺票时必须整体作废：一个只回 1/3 的校验源，旧实现会把「它唯一返回的那只票」
   * 当成冲突删掉（无第三方裁决），而它漏掉的票反而「未校验通过」——行为完全反了。
   */
  private async crossCheck(candidates: QuoteSource[], base: Map<string, Quote>): Promise<Map<string, Quote>> {
    const checker = candidates[0]
    if (!checker) return base
    const targets = [...base.keys()].filter((s) => this.canResolve(checker, s))
    if (targets.length === 0) return base

    let checkMap: Map<string, Quote>
    try {
      checkMap = usable(await fetchAll(checker, targets), targets)
      if (checkMap.size < targets.length) {
        throw new Error(`${checker.id} check incomplete ${checkMap.size}/${targets.length}`)
      }
    } catch {
      this.markFailure(checker.id)
      return base
    }
    this.failures.set(checker.id, 0)

    const arbiter = candidates[1]
    const result = new Map(base)
    for (const [sym, p] of base) {
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
        const a = usable(await fetchAll(arbiter, [sym]), [sym]).get(sym)
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

/**
 * 建立 symbol → Quote 的索引，只认请求过的符号，并丢弃 pct 非有限的行。
 * pct 是唯一被产品消费的字段：NaN 传下去会让 Σw·pct 静默变成 NaN，整只基金的估值归零。
 */
function usable(list: Quote[], requested: string[]): Map<string, Quote> {
  const want = new Set(requested)
  const out = new Map<string, Quote>()
  for (const q of list) {
    if (!want.has(q.symbol)) continue
    if (!Number.isFinite(q.pct)) continue
    out.set(q.symbol, q)
  }
  return out
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

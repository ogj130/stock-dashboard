import { CONFIG } from '../config'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

const EASTMONEY_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const EASTMONEY_FIELDS = 'f2,f3,f4,f12,f14'

/**
 * 一条指数的规范定义。**顺序即界面从左往右的顺序**，也是合并时的排序依据。
 *
 * - `secid` 是东财 ulist 的 secid：1=沪、0=深，100=美股指数。
 * - `sinaCode` 是新浪 hq 的 list 代码，一次性全要（一个请求四条）。
 * - `layout` 是新浪两种报文布局之一：`gb`（美股指数，涨跌幅在 [2]、涨跌额在 [4]）
 *   与 `s`（A 股指数，点位 [1]、涨跌额 [2]、涨跌幅 [3]）。
 *
 * ⚠️ 东财必须是 `100.NDX100`，不是 `100.NDX`！东财的 `100.NDX` 名称显示「纳斯达克」，
 * 实际是**纳斯达克综合指数**（与新浪 gb_$ixic 完全一致），而国内 QDII 跟踪的是
 * 纳斯达克 100。实测同一时刻两者差 0.59pp（综合 +2.63% vs NDX100 +3.22%），
 * 用错会让所有纳指基金的估值系统性偏低。
 *
 * ⚠️ `name` 是**给界面用的标签**，按这张表固定，不随来源漂移：界面靠它把基金
 * 挂到「关联板块」上（精确匹配 + 最长前缀匹配，见 web/App.tsx 的 indexForBoard）。
 * 新浪把标普500叫「标普500指数」，若原样透出，`'标普500'.startsWith('标普500指数')`
 * 是 false，标普基金的板块列会突然变成「—」。
 */
export interface MarketIndexSpec {
  symbol: string
  name: string
  secid: string
  sinaCode: string
  layout: 'gb' | 's'
  /**
   * 盘前代理 ETF。
   *
   * 为什么盘前不能继续用「指数全量成分加权」：指数成分权重是**按市值归一化**算出来的，
   * 而纳斯达克 100 用的是修正市值加权（有封顶规则），两者在大盘股分化时能差 0.3pp 以上。
   * 实测 2026-11-10 盘前：成分加权 +0.07%，QQQ −0.21%，纳指期货 −0.21% —— 后两者一致，
   * 说明偏差来自权重口径而不是行情。
   *
   * 常规时段我们有官方指数涨跌幅可用；盘前官方指数不交易，于是退一步用跟踪同一指数的
   * 单只 ETF（价格里已经包含了权重信息，不需要我们再算一遍权重）。
   */
  preMarketProxy?: string
}

export const MARKET_INDEX_SPECS: readonly MarketIndexSpec[] = [
  { symbol: '000001', name: '上证指数', secid: '1.000001', sinaCode: 's_sh000001', layout: 's' },
  { symbol: '399001', name: '深证成指', secid: '0.399001', sinaCode: 's_sz399001', layout: 's' },
  {
    symbol: 'NDX100',
    name: '纳斯达克100',
    secid: '100.NDX100',
    sinaCode: 'gb_ndx',
    layout: 'gb',
    preMarketProxy: 'QQQ',
  },
  {
    symbol: 'SPX',
    name: '标普500',
    secid: '100.SPX',
    sinaCode: 'gb_$inx',
    layout: 'gb',
    preMarketProxy: 'SPY',
  },
]

/** 指数 key（基金表里的 index_key）→ 盘前代理 ETF */
export const PRE_MARKET_PROXY_BY_INDEX: Readonly<Record<string, string>> = Object.fromEntries(
  MARKET_INDEX_SPECS.filter((s) => s.preMarketProxy).map((s) => [
    s.symbol === 'NDX100' ? 'ndx' : 'sp500',
    s.preMarketProxy!,
  ]),
)

/** 东财一次 ulist 拿全部四条，顺序与界面一致 */
export const MARKET_INDEX_SECIDS: readonly string[] = MARKET_INDEX_SPECS.map((s) => s.secid)

/** 新浪一次 list 拿全部四条（它按 list 顺序回，这里仍然按代码取，不依赖回包顺序） */
export const SINA_INDEX_CODES: readonly string[] = MARKET_INDEX_SPECS.map((s) => s.sinaCode)

/** 取不到指数时最坏等 5 秒：底部条是锦上添花，不能把 5 秒轮询拖住 */
export const SINA_INDEX_TIMEOUT_MS = 5_000

export interface MarketIndex {
  /** 稳定的内部代码（'000001' / '399001' / 'NDX100' / 'SPX'），估值路由的 INDEX_SYMBOL 依赖它 */
  symbol: string
  /** 展示名，见 MARKET_INDEX_SPECS 的说明 */
  name: string
  /** 点位 */
  value: number
  /** 涨跌点数 */
  change: number
  /** 涨跌幅（百分数，0.32 表示 +0.32%） */
  pct: number
}

export interface UlIndexRow {
  f2?: unknown
  f3?: unknown
  f4?: unknown
  f12?: unknown
  f14?: unknown
}

export interface UlIndexResponse {
  data?: { diff?: UlIndexRow[] | null } | null
}

/**
 * 东财 ulist 报文 -> MarketIndex[]。f2(点位)/f4(涨跌点) 与 f3(涨跌幅) 都放大 100 倍：
 * 实测 2026-11-10 上证 f2=366079 → 3660.79、f4=1161 → 11.61、f3=32 → 0.32%。
 *
 * 五个字段缺一即丢整行：指数条上「点位在、涨跌幅缺席」比少一行更让人困惑，
 * 而把 '-' 当 0% 展示就是编数字。
 */
export function normalizeMarketIndices(raw: UlIndexResponse | null | undefined): MarketIndex[] {
  const rows = raw?.data?.diff ?? []
  const out: MarketIndex[] = []
  for (const row of rows) {
    const symbol = typeof row.f12 === 'string' ? row.f12.trim() : ''
    const name = typeof row.f14 === 'string' ? row.f14.trim() : ''
    const value = scaled(row.f2)
    const change = scaled(row.f4)
    const pct = scaled(row.f3)
    if (symbol === '' || name === '' || value === null || change === null || pct === null) continue
    out.push({ symbol, name, value, change, pct })
  }
  return out
}

/** 报文里的数字既可能是 number 也可能是字符串；'' 与 '-' 一律当缺失（Number('') === 0 会伪装成 0 点） */
function scaled(value: unknown): number | null {
  const raw =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : null
  if (raw === null || !Number.isFinite(raw)) return null
  return raw / 100
}

/** 真实网络取东财一次；失败直接抛，由 fetchMarketIndices 决定要不要换新浪 */
export async function fetchEastmoneyIndices(): Promise<MarketIndex[]> {
  const url = `${EASTMONEY_URL}?secids=${MARKET_INDEX_SECIDS.join(',')}&fields=${EASTMONEY_FIELDS}`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`eastmoney ulist http ${res.status}`)
  return normalizeMarketIndices((await res.json()) as UlIndexResponse)
}

/**
 * 新浪报文里取一条的报文体（GBK 已由调用方解码）。
 *
 * 不用正则：`gb_$inx` 带上 `$` 当字面量写正则会变成行尾锚点，得转义一次才安全。
 * 直接按 `var hq_str_<code>="` 找起点、再找收尾的引号，既没有转义坑，
 * 也不会被相邻条目的内容串味。报文里没有这条就返回 null（缺失行）。
 */
function sinaBody(raw: string, code: string): string | null {
  const key = `var hq_str_${code}="`
  const start = raw.indexOf(key)
  if (start < 0) return null
  const rest = raw.slice(start + key.length)
  const end = rest.indexOf('"')
  if (end < 0) return null
  return rest.slice(0, end)
}

/** 空串 / 缺失字段一律当 NaN（`Number('')` 是 0，会把缺失读成「涨跌 0」） */
function num(s: string | undefined): number {
  if (s === undefined) return NaN
  const t = s.trim()
  return t === '' ? NaN : Number(t)
}

/**
 * 涨跌点数。两条规则，按可信度排序：
 *
 * ① 源自己给了涨跌额（gb 的 [4]、s 的 [2]）且与 value/pct 自洽 → 用它。
 *    实测 2026-11-10：gb_ndx 27907.6251 / +3.40% / [4]=917.6336，
 *    27907.6251 − 26989.9915(昨收) = 917.6336；s_sh000001 3667.8157 / [2]=7.0240，
 *    昨收 3660.7917 同样是 value − change。所以 [2]/[4] 是真涨跌额，不是占位符。
 * ② 源没给（或给的数与 value/pct 差得离谱，说明字段语义变了）→ 由昨收恒等式反算：
 *    change = value − value/(1 + pct/100) = value·pct/(100 + pct)。
 *    pct = −100 时昨收为 0、恒等式失效，返回 null（该行宁可丢，也不编）。
 *
 * 容差取 max(0.5 点, 1%)：新浪的 pct 只保留两位小数，反算值天然有舍入差
 * （s_sh000001 实测 7.0240 vs 反算 6.9564），不能拿来做严格相等比较。
 */
function changeOf(value: number, pct: number, field: string | undefined): number | null {
  const reported = num(field)
  const derived = pct === -100 ? NaN : (value * pct) / (100 + pct)
  const tolerance = Math.max(0.5, Math.abs(derived) * 0.01)
  if (Number.isFinite(reported) && (!Number.isFinite(derived) || Math.abs(reported - derived) <= tolerance)) {
    return reported
  }
  return Number.isFinite(derived) ? derived : null
}

/**
 * 新浪 hq.sinajs.cn 的报文 -> MarketIndex[]（GBK 已在调用方解码成文本）。
 *
 * 同一份回包里两种布局，实测原文（2026-11-10 14:56 CST，美股已闭市）：
 *   `var hq_str_gb_ndx="纳斯达克100,27907.6251,3.40,2026-11-10 06:30:00,917.6336,27263.4269,...";`
 *   `var hq_str_gb_$inx="标普500指数,7549.9399,2.35,2026-11-10 06:13:19,173.0800,...";`
 *   `var hq_str_s_sh000001="上证指数,3667.8157,7.0240,0.19,3574899,60224721";`
 *   `var hq_str_s_sz399001="深证成指,11245.62,100.132,0.90,463904991,73972881";`
 *
 * gb： [0]名称 [1]点位 [2]涨跌幅% [3]时间 [4]涨跌额 … [26]昨收
 * s：  [0]名称 [1]点位 [2]涨跌额 [3]涨跌幅% [4]成交量 [5]成交额
 *
 * 缺点位或缺涨跌幅的条目整行丢弃（不产出 NaN、不拿 0 顶替）；只认规范表里的四条，
 * 回包里多出来的其它代码一律忽略。symbol/name 一律用规范表的值，不用新浪的名字。
 */
export function parseSinaIndices(raw: string): MarketIndex[] {
  const out: MarketIndex[] = []
  for (const spec of MARKET_INDEX_SPECS) {
    const body = sinaBody(raw, spec.sinaCode)
    if (body === null) continue

    const f = body.split(',')
    // 两种布局的点位都在 [1]，涨跌幅分别在 [2]（gb）与 [3]（s）
    const value = num(f[1])
    const pct = spec.layout === 'gb' ? num(f[2]) : num(f[3])
    // 点位必须是有意义的正数：0 是新浪「没有这一条」的占位符
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(pct)) continue
    const change = changeOf(value, pct, spec.layout === 'gb' ? f[4] : f[2])
    if (change === null) continue

    out.push({ symbol: spec.symbol, name: spec.name, value, change, pct })
  }
  return out
}

/**
 * 真实网络取新浪一次（四条一起）。缺 Referer 会被新浪直接拒（实测 2026-11-10），别删。
 * 失败直接抛，由 fetchMarketIndices 决定这本是主源还是备源。
 */
export async function fetchSinaIndices(): Promise<MarketIndex[]> {
  const url = `https://hq.sinajs.cn/list=${SINA_INDEX_CODES.join(',')}`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
    signal: AbortSignal.timeout(SINA_INDEX_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`sina index http ${res.status}`)
  // 新浪返回 GBK，直接 res.text() 会把中文名解成乱码
  return parseSinaIndices(new TextDecoder('gbk').decode(await res.arrayBuffer()))
}

/** 规范表里的四条是否都拿到了 */
export function coversAllIndices(list: readonly MarketIndex[]): boolean {
  const have = new Set(list.map((i) => i.symbol))
  return MARKET_INDEX_SPECS.every((s) => have.has(s.symbol))
}

/**
 * 两个来源做并集，**按 symbol 去重且主源优先**，最后按规范表顺序排。
 *
 * 为什么是合并而不是「有一个干净的结果就整份采信」：指数条既是展示、又是估值输入，
 * 少一行不会让谁算错，但会让界面空掉一格；而部分结果里那几行是真的，丢掉才是浪费。
 * 排序固定成规范表顺序，来源切换时界面不会跳来跳去。
 */
export function mergeMarketIndices(
  primary: readonly MarketIndex[],
  fill: readonly MarketIndex[],
): MarketIndex[] {
  const bySymbol = new Map<string, MarketIndex>()
  for (const row of [...primary, ...fill]) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, row)
  }
  const rank = (symbol: string): number => {
    const i = MARKET_INDEX_SPECS.findIndex((s) => s.symbol === symbol)
    // 规范表外的代码排最后（Array#sort 稳定，它们的相对顺序保持不变）
    return i < 0 ? MARKET_INDEX_SPECS.length : i
  }
  return [...bySymbol.values()].sort((a, b) => rank(a.symbol) - rank(b.symbol))
}

/**
 * 底部指数条取数：**东财优先，缺口用新浪补齐**。
 *
 * 为什么要两个源：东财 ulist 在美股闭市后（实测 2026-11-10 01:35 ET）整批返回**空 body**，
 * 而底部条里的 NDX100 正是估值路由 indexPctFor 的唯一输入。空了 → indexPct 变成
 * undefined → 纳指基金静默退回成分加权自算，数字看着正常，却随着盘后零星成交一直漂。
 * 新浪 hq 盘后照常有数（gb_ndx 就带着 +3.40%），补上这条腿就能把口径锁住。
 *
 * 契约：
 * - 东财四条齐全 → 直接返回，不打新浪（省一个请求）；
 * - 东财空/缺条 → 打新浪一次（四条一起），合并补缺，主源优先；
 * - 新浪挂了但东财有部分 → 返回那部分（合并优于丢弃）；
 * - 两边都没数据 → 谁都没抛错就返回空数组（界面不渲染指数条，诚实降级）；
 *   若东财是抛错退出来的，就把那个错抛出去，让路由记一条 warn（缓存层也据此记阴性缓存）。
 */
export async function fetchMarketIndices(): Promise<MarketIndex[]> {
  let primary: MarketIndex[] = []
  let primaryErr: unknown = null
  try {
    primary = await fetchEastmoneyIndices()
  } catch (err) {
    primaryErr = err
  }
  if (coversAllIndices(primary)) return primary

  try {
    const filled = await fetchSinaIndices()
    const merged = mergeMarketIndices(primary, filled)
    if (merged.length > 0) return merged
  } catch {
    // 新浪这条腿失败不影响已拿到的部分；两边都空时再看东财的错要不要上报
  }

  if (primary.length > 0) return primary
  if (primaryErr !== null) throw primaryErr
  return []
}

/**
 * 30 秒缓存 + 失败缓存。
 *
 * 两条都必须有：5 秒轮询不能每轮打 4 个指数；而失败若不记进缓存，
 * 接口挂掉的 30 秒里每 5 秒都会再打一次、每次刷一条 warn。
 * 失败时缓存空数组——界面拿到空数组就不渲染指数条，这是诚实的降级。
 *
 * 用工厂而不是模块级单例：测试各拿各的缓存，互不串味。
 */
export function createMarketIndicesCache(
  fetchIndices: () => Promise<MarketIndex[]> = fetchMarketIndices,
  ttlMs: number = CONFIG.staleMs.indices,
): () => Promise<MarketIndex[]> {
  let memo: { list: MarketIndex[]; atMs: number } | null = null
  return async () => {
    const now = Date.now()
    if (memo && now - memo.atMs < ttlMs) return memo.list
    try {
      const list = await fetchIndices()
      memo = { list, atMs: now }
      return list
    } catch (err) {
      memo = { list: [], atMs: now }
      throw err
    }
  }
}

import type { Quote } from '../types'
import { isUsTicker, type Capability, type QuoteSource } from './types'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/**
 * 新浪的一条行情，外加盘后那三个字段。
 *
 * 盘后字段一律「有就给，没有就不给」——绝不写 0 占位。这层区分是整条夜盘链路的地基：
 * 界面靠 `afterHours === undefined` 判断「今天没有夜盘」，写 0 会画出一个假的 0.00%。
 */
export interface SinaQuote extends Quote {
  /** [21] 盘后最新成交价，> 0 才给 */
  afterHoursPrice?: number
  /** [22]/[23] 盘后涨跌幅（百分数），基准是当日常规收盘价 [1] */
  afterHoursPct?: number
  /** [24]。无年份的报文时刻，推导见 parseAfterHoursMs */
  afterHoursMs?: number
}

/**
 * 空串 / 缺失字段一律当 NaN 处理。
 *
 * 不能直接用 Number(x)：`Number('')` 是 0 而不是 NaN。新浪报文是位置式字段，
 * 尾部字段缺失时 split(',') 会给出空串，裸用 Number 会把"缺失"读成"涨跌额 0"，
 * 于是 prevClose 被算成等于现价——一个静默的错值，比抛错更危险。
 */
function num(s: string | undefined): number {
  if (s === undefined) return NaN
  const t = s.trim()
  return t === '' ? NaN : Number(t)
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
}

const DAY_MS = 86_400_000

/** 美东当地年月日。Intl 自带时区库，冬夏令时切换不用手写规则 */
const ET_YMD = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
})

function etYmd(nowMs: number): { year: number; month: number; day: number } {
  const parts = ET_YMD.formatToParts(new Date(nowMs))
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '')
  return { year: get('year'), month: get('month') - 1, day: get('day') }
}

/**
 * 新浪的盘后时刻 -> epoch ms。报文形如 `Nov 09 07:59PM EST`：**没有年份**。
 *
 * 年份推导规则（这是这个函数唯一需要动脑的地方）：
 * 以「美东今天」为锚，先按今年的年月日拼一个候选；若该日期比美东今天还晚
 * 1 天以上，就说明它属于去年（跨年边界），减一年。
 * 容 1 天是因为盘后时刻可能落在今天，而「未来」超过一天只可能是年份错了。
 * 例：1 月 2 日收到 `Dec 31 07:59PM EST` → 今年的 Dec 31 在未来 ~363 天 → 减一年 → 去年 12 月 31 日。
 *
 * 时区：报文后缀 EST(-5) / EDT(-4) 直接参与换算。**刻意不做 DST 校验**：
 * 这个值只用于界面上的「盘后更新于 19:59 ET」，不参与任何数值计算，
 * 后缀与实际时令错配最多差 1 小时，为它引入一张时令表不值得。
 *
 * 最后 clamp 到 `<= now`：显示层绝不能出现「更新于未来」这种自证错误的文案。
 */
export function parseAfterHoursMs(raw: string, nowMs: number = Date.now()): number | undefined {
  const m = raw
    .trim()
    .match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])(?:\s+([A-Za-z]{2,4}))?$/)
  if (!m) return undefined

  const month = MONTH_INDEX[m[1]!.toLowerCase()]
  const day = Number(m[2])
  const hour12 = Number(m[3])
  const minute = Number(m[4])
  const isPm = m[5]!.toLowerCase() === 'pm'
  if (month === undefined || day < 1 || day > 31) return undefined
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined

  // 12AM -> 0 点，12PM -> 12 点，其余 PM 加 12
  const hour = (hour12 % 12) + (isPm ? 12 : 0)
  // 后缀缺省时按 EST 算（美东 11 月–3 月是 EST，年报文的出现概率更高）
  const offsetHours = (m[6] ?? 'EST').toUpperCase() === 'EDT' ? -4 : -5

  const today = etYmd(nowMs)
  let year = today.year
  // 只比日期，不带时刻：今天 19:59 与今天 05:00 都是"今天"，不该被当成未来
  if (Date.UTC(year, month, day) - Date.UTC(today.year, today.month, today.day) > DAY_MS) {
    year -= 1
  }

  const utcMs = Date.UTC(year, month, day, hour, minute) - offsetHours * 3_600_000
  if (!Number.isFinite(utcMs)) return undefined
  return Math.min(utcMs, nowMs)
}

/**
 * 盘后三件套。缺任何一件都必须整组丢弃——半个盘后价（有价无时间）在界面上
 * 只能写成「夜盘 +0.32%（更新时间未知）」，那比不显示更糟。
 *
 * 字段位置的实测结论（2026-11-10，`gb_aapl`，见 sina 的字段表）：
 *   [21] 350.5000（盘后价） / [22] -0.05（盘后涨跌幅 %） / [23] -0.19（盘后涨跌额）
 * 注意 [22]/[23] 与需求文档里的标注是**反的**：拿 [21] 与 [1] 常规收盘 350.69 一算，
 * (350.50/350.69−1)×100 = −0.0542 → 四舍五入正是 [22]=−0.05；而 350.50−350.69 = −0.19
 * 正是 [23]。英伟达（180.50 / 178.67 → +1.83 与 +1.02）与微软（543.79 / 545.18 → −1.39 与 −0.25）
 * 三条样本一致如此。所以这里以**定义式**为准（盘后价 / 常规收盘 − 1），
 * 只在 [22] 与定义式不矛盾时采用新浪自己的数（它是同源四舍五入，留着更贴近原文）；
 * 两者相差超过 0.5pp 说明字段语义变了，就退回定义式，绝不盲信位置。
 */
function afterHoursOf(
  f: string[],
  regularClose: number,
  nowMs: number,
): Pick<SinaQuote, 'afterHoursPrice' | 'afterHoursPct' | 'afterHoursMs'> | null {
  const price = num(f[21])
  // 0.00 是新浪「今天没有盘后成交」的占位符，不是价格
  if (!Number.isFinite(price) || price <= 0) return null

  const raw = f[24]?.trim() ?? ''
  if (raw === '') return null
  const tsMs = parseAfterHoursMs(raw, nowMs)
  if (tsMs === undefined) return null

  const derived = regularClose > 0 ? (price / regularClose - 1) * 100 : NaN
  const field = num(f[22])
  const pct =
    Number.isFinite(field) && (!Number.isFinite(derived) || Math.abs(field - derived) <= 0.5)
      ? field
      : derived
  if (!Number.isFinite(pct)) return null

  return { afterHoursPrice: price, afterHoursPct: pct, afterHoursMs: tsMs }
}

/**
 * 新浪 hq.sinajs.cn 的原始文本 -> Quote。兜底源（L5），价格精度 4 位最高。
 *
 * 实测报文（2026-11-10 验证，36 个字段）：
 * `var hq_str_gb_aapl="苹果,350.6900,2.43,2026-11-10 09:30:10,8.3200,344.9950,...,350.5000,-0.05,-0.19,Nov 09 07:59PM EST,Nov 09 04:00PM EST,342.3700,...";`
 * 字段位置（位置式，勿按名字取）：
 *   [0]名称 [1]现价 [2]涨跌幅% [3]时间(北京时间) [4]涨跌额
 *   [21]盘后价 [22]盘后涨跌幅% [23]盘后涨跌额 [24]盘后时刻 [25]常规收盘时刻 [26]昨收
 *
 * 新浪**没有直接的昨收字段**：优先 `price - change`，涨跌额缺失时用 `price / (1 + pct/100)` 反推。
 * 价格非有限数的条目直接丢弃，绝不产出 NaN。
 */
export function parseSina(raw: string, nowMs: number = Date.now()): SinaQuote[] {
  const out: SinaQuote[] = []
  for (const chunk of raw.split(';')) {
    // 变量名是小写 hq_str_gb_aapl，产出时统一转大写
    const m = chunk.match(/hq_str_gb_([a-z.\-]+)="([^"]*)"/)
    if (!m) continue
    const f = m[2]!.split(',')
    const price = num(f[1])
    if (!Number.isFinite(price)) continue
    const rawPct = num(f[2])
    const change = num(f[4])
    const prevClose = Number.isFinite(change)
      ? price - change
      : Number.isFinite(rawPct) && rawPct !== -100
        ? price / (1 + rawPct / 100)
        : price
    // 涨跌幅缺失时由昨收反算，保持两个字段自洽
    const pct = Number.isFinite(rawPct)
      ? rawPct
      : prevClose !== 0
        ? ((price - prevClose) / prevClose) * 100
        : 0
    const afterHours = afterHoursOf(f, price, nowMs)
    out.push({
      symbol: m[1]!.toUpperCase(),
      price,
      prevClose,
      pct,
      // [3] 是北京时间（无偏移），显式补 +08:00；解析失败退回当前时间，不当 NaN 传下去
      tsMs: f[3] ? Date.parse(`${f[3].trim().replace(' ', 'T')}+08:00`) || nowMs : nowMs,
      precision: 4,
      sourceId: 'sina',
      // 没有盘后数据时连键都不出现（不是 undefined 值），下游只认「有 / 没有」
      ...(afterHours ?? {}),
    })
  }
  return out
}

export class SinaSource implements QuoteSource {
  id = 'sina'
  maxBatch = 100
  sep = ','
  capabilities: Capability[] = ['quote']

  /** 只服务美股代码：港股（00992）这类纯数字代码它取不到，别让 registry 误记为失败 */
  resolves(symbol: string): boolean {
    return isUsTicker(symbol)
  }

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return []
    const list = symbols
      .slice(0, this.maxBatch)
      .map((s) => `gb_${s.toLowerCase()}`)
      .join(',')
    const res = await fetch(`https://hq.sinajs.cn/list=${list}`, {
      // 缺 Referer 会被新浪直接拒绝（实测 2026-11-10），别删
      headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
    })
    if (!res.ok) throw new Error(`sina http ${res.status}`)
    // 新浪返回 GBK，直接 res.text() 会把中文名解成乱码
    const text = new TextDecoder('gbk').decode(await res.arrayBuffer())
    return parseSina(text)
  }
}

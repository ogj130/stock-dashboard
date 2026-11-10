/**
 * 小部件（`?compact=1`）的纯逻辑。
 *
 * 340×480 的桌面窗口里：上半是六个汇总字段，下半是全部基金的滚动手风琴列表。
 * 「显示什么、缺数据时显示什么」必须先由纯函数定死，再交给 React 画。理由很实际：
 * 降级分支一旦散落在 JSX 的三元里，就没人能一眼看出「行情不可用」到底走到了哪一支——
 * 而这里最怕的正是把汇率腿算出来的 navPct 当成涨跌，糊一个看起来很正常、其实是假的数字。
 *
 * 这个文件不 import React、不 import CSS：node 里能直接单测。
 */

import { summarizeAfterHours, type AfterHoursLite } from './afterHours'
import { money, pctText, signedMoney, tone } from './format'

export const COMPACT_QUERY_KEY = 'compact'

/** 只认 1 / true：`?compact=0`、`?compact=`、`?compact` 都必须退回完整页面 */
const TRUTHY = new Set(['1', 'true'])

/**
 * 当前 URL 要不要进小部件模式。
 *
 * 入参是 `window.location.search`（通常是带前导 `?` 的串）。解析交给
 * URLSearchParams：手写 split('&') 在 `?compact=1&note=a=b` 这种值里带等号时
 * 会读错，而这类查询串以后一定会有人写。
 */
export function isCompactQuery(search: string): boolean {
  if (search === '') return false
  const query = search.startsWith('?') ? search : `?${search}`
  const raw = new URLSearchParams(query).get(COMPACT_QUERY_KEY)
  return raw !== null && TRUTHY.has(raw.trim().toLowerCase())
}

/**
 * 迷你曲线只画「今天这一场」的最后 40 个点。
 *
 * 后端 session 档位一次最多给 720 个点（30 秒一行，一整个交易日也就 780 个），
 * 在 292px 宽里全画出来只是一团墨；40 个点 ≈ 20 分钟，看趋势刚好。
 */
export const COMPACT_POINT_LIMIT = 40

/** 取末尾 N 个点，保持时间顺序（老 → 新）。不修改入参。 */
export function tailPoints<T>(points: readonly T[], limit = COMPACT_POINT_LIMIT): T[] {
  if (limit <= 0) return []
  return points.length <= limit ? [...points] : points.slice(points.length - limit)
}

export type Tone = 'up' | 'down' | 'flat'

/** 卡片只读 FundEstimate 的这几个字段，测试就不必造一整个回包 */
export interface CompactFund {
  code: string
  name: string
  marketValue: number
  amount: number
  holdingProfit: number
  /** 该只基金当日估算的净值涨跌幅（百分数）；覆盖率 0 时它只是汇率腿，不能当涨跌 */
  navPct: number
  /** 0 = 这一只没有可用行情（引擎仍会给一个由汇率腿算出的 navPct，那个不能当涨跌） */
  coveredWeight: number
  /** 夜盘（盘后）读数；没有就是 undefined，卡片脚注那一小段随之整体消失 */
  afterHours?: AfterHoursLite
}

/**
 * 列表里的一行。
 *
 * 全部字段都是「已经决定好怎么显示」的字符串：卡片 JSX 里不该再有
 * `coveredWeight > 0 ? pctText(...) : DASH` 这种三元——降级规则要能被单测钉住。
 */
export interface CompactFundRow {
  code: string
  /** 基金名称，拿不到名称时退回代码（宁可显示 162411，也不要一行空白） */
  name: string
  /** 排序用的原值，渲染不用 */
  marketValue: number
  /** '+2.92%'；覆盖率为 0 时是 '—' */
  pctText: string
  pctTone: Tone
  /** '+1,568.20'；覆盖率为 0 时同样是 '—' */
  amountText: string
  amountTone: Tone
  /** false = 这一只没有可用行情，行内两个数字都是 '—' */
  covered: boolean
}

const BY_CODE = (a: CompactFund, b: CompactFund) => a.code.localeCompare(b.code)

/**
 * 把基金列表压成「按市值从大到小、每只一行」的展示行。
 *
 * 两条规则：
 *   · 排序用市值降序，同值时按代码排（稳定、可测；不依赖 sort 的稳定性）；
 *   · coveredWeight === 0 的那只，百分比与金额都写 '—'。只把百分比写 '—' 而金额
 *     照给是个陷阱：此时 navPct 只剩汇率腿，amount = 市值 × 那个数，两个数字同源，
 *     一个认账一个不认账只会让人以为金额是可信的。整行的两个数字一起弃用。
 *     它的市值仍计入总资产——持仓是真的，估值不是。
 */
export function deriveFundRows(funds: readonly CompactFund[]): CompactFundRow[] {
  return [...funds]
    .sort((a, b) => b.marketValue - a.marketValue || BY_CODE(a, b))
    .map((f) => {
      const covered = f.coveredWeight > 0
      return {
        code: f.code,
        name: f.name.trim() === '' ? f.code : f.name.trim(),
        marketValue: f.marketValue,
        pctText: covered ? pctText(f.navPct) : DASH,
        pctTone: covered ? tone(f.navPct) : 'flat',
        amountText: covered ? signedMoney(f.amount) : DASH,
        amountTone: covered ? tone(f.amount) : 'flat',
        covered,
      }
    })
}

export interface CompactInput {
  funds: readonly CompactFund[]
  phase: 'live' | 'settled'
  /** 最后一轮**成功**取数的时刻；null = 还没成功过 */
  updatedAt: number | null
  /** 首轮请求是否已经回来：用来区分「还在读」和「真的没有基金」 */
  loaded: boolean
  /** 非 null = 这一轮失败了。数字沿用上一轮，但脚注必须认账 */
  error: string | null
}

export interface CompactView {
  /** 总资产，最大的那个数 */
  totalText: string
  /** 今日估算的金额；无可用行情时是「行情不可用」，不是 0，也不是一个假数 */
  deltaText: string
  /** 今日估算的百分比；分母是**有行情那几只**的市值，null 表示无法计算 */
  deltaPctText: string | null
  deltaTone: Tone
  /** 持有收益：比今日估算更小、更淡，它不随 5 秒跳 */
  holdText: string
  /** 相位戳：'盘中 · 5秒刷新' / '待公布' */
  phaseText: string
  /** 更新时刻 '04:32'，还没取到数据时是 '—' */
  clockText: string
  /** 脚注第三段 '夜盘 +0.32%'；没有任何夜盘数据时是 null（整段不渲染，不写「—」） */
  afterHoursText: string | null
  /** 降级说明（还没有基金 / 连不上后端 / 正在读取…）；正常时为 null */
  note: string | null
  /** 没有可用行情的只数；>0 且 quotesAvailable 时脚注提示，避免让人以为只算了全部 */
  blindCount: number
  /** 是否至少有一只基金有可用行情（false 时今日估算整块是「行情不可用」） */
  quotesAvailable: boolean
  /**
   * 列表区：全部基金，市值降序。空数组时列表区不渲染行，改为显示 note
   * （「还没有基金」/「正在读取…」/「连不上后端」），所以空态文案只有一处来源。
   */
  rows: CompactFundRow[]
}

export const PHASE_LIVE_TEXT = '盘中 · 5秒刷新'
export const PHASE_SETTLED_TEXT = '待公布'

export const DASH = '—'

/**
 * 本地时刻 HH:MM。`hourCycle: 'h23'` 而不是 `hour12: false`：
 * 后者在部分实现里午夜会给出 "24:05"。
 */
const CLOCK = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** '04:32'；没有成功取数过就写 '—'，不要写一个假的时间。 */
export function compactClock(atMs: number | null): string {
  if (atMs === null || !Number.isFinite(atMs)) return DASH
  return CLOCK.format(new Date(atMs))
}

/** 脚注那一段的文案 '夜盘 +0.32%'；没有数据时 null */
function nightLine(funds: readonly CompactFund[]): string | null {
  const night = summarizeAfterHours(funds)
  return night === null ? null : `夜盘 ${pctText(night.pct)}`
}

/**
 * 把一轮数据压成卡片要显示的那几个字符串。
 *
 * 三条降级规则（都是「宁可难看，不许说谎」）：
 *   · 一只基金都没有 → '还没有基金'，数字全部 '—'；
 *   · 所有持仓 coveredWeight === 0 → 今日估算位置直接写「行情不可用」，不渲染数字；
 *   · 部分无覆盖 → 只在有覆盖的那几只上求和，百分比的分母也只取它们的市值，
 *     脚注再补一句「N 只无覆盖」。
 */
export function deriveCompactView(input: CompactInput): CompactView {
  const { funds, phase, updatedAt, loaded, error } = input

  const base: CompactView = {
    totalText: DASH,
    deltaText: DASH,
    deltaPctText: null,
    deltaTone: 'flat',
    holdText: DASH,
    phaseText: phase === 'live' ? PHASE_LIVE_TEXT : PHASE_SETTLED_TEXT,
    clockText: compactClock(updatedAt),
    afterHoursText: null,
    note: null,
    blindCount: 0,
    quotesAvailable: false,
    rows: [],
  }

  if (funds.length === 0) {
    return {
      ...base,
      // 空列表 + 请求失败时说「还没有基金」是在骗人，先认错
      note: error !== null ? '连不上后端' : loaded ? '还没有基金' : '正在读取…',
    }
  }

  const covered = funds.filter((f) => f.coveredWeight > 0)
  const blindCount = funds.length - covered.length
  const totalValue = funds.reduce((sum, f) => sum + f.marketValue, 0)
  const holdProfit = funds.reduce((sum, f) => sum + f.holdingProfit, 0)

  // 分母只能是「有行情那几只」的市值：拿全部市值当分母，覆盖率低的那天
  // 折出来的百分比会把跌幅算轻，那是算错，不是保守。
  const coveredValue = covered.reduce((sum, f) => sum + f.marketValue, 0)
  const amount = covered.reduce((sum, f) => sum + f.amount, 0)
  const pct = coveredValue > 0 ? (amount / coveredValue) * 100 : null
  const quotesAvailable = covered.length > 0

  return {
    ...base,
    totalText: money(totalValue),
    deltaText: quotesAvailable ? signedMoney(amount) : '行情不可用',
    deltaPctText: quotesAvailable && pct !== null ? pctText(pct) : null,
    deltaTone: quotesAvailable ? tone(amount) : 'flat',
    holdText: signedMoney(holdProfit),
    note: error !== null ? '连不上后端' : null,
    // 夜盘汇总只认「确实有盘后行情」的基金；一只都没有时整段消失
    afterHoursText: nightLine(funds),
    blindCount,
    quotesAvailable,
    rows: deriveFundRows(funds),
  }
}

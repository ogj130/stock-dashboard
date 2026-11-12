/**
 * 东财 7×24 快讯（卡片「大事」Tab 的唯一数据源）。
 *
 * 两个必须记住的事实：
 *
 * 1. **这是非官方接口**，形状随时可能变：
 *    `https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_1_.html`
 *    响应不是 JSON，而是 `var ajaxResult={...};` 的 JS 赋值——先截第一个 `{`
 *    到最后一个 `}` 再 parse。解析器单独成文件 + 夹具测试，失败只降级。
 *
 * 2. **它跟估值主链路没有任何耦合**。新闻挂了，卡片只是「大事」Tab 显示
 *    「资讯暂不可用」，个股与基金照常跳数字。
 *
 * 时间字段是北京时间字符串（"2026-11-12 01:30:47"）。中国没有夏令时，
 * 所以直接按固定 +08:00 换算，比塞一个时区库诚实，也比依赖运行环境的
 * 本地时区可测。
 */

const NEWS_URL = 'https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_1_.html'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const FETCH_TIMEOUT_MS = 8000

/** 北京时间的固定偏移（中国不实行夏令时） */
const CN_OFFSET_MS = 8 * 3600_000

export interface NewsItem {
  id: string
  title: string
  url: string
  source: 'eastmoney'
  /** 北京时间毫秒 */
  tsMs: number
  /** 源标记的重要事件（titlestyle 不是 "0"） */
  important: boolean
}

export interface NewsPayload {
  items: NewsItem[]
  /** 这批数据是什么时候拿到的；从没成功过时是 0 */
  tsMs: number
  /** true = 这一轮没拉到，返回的是上一轮缓存（或空数组） */
  stale: boolean
}

/**
 * "2026-11-12 01:30:47"（北京时间）→ epoch 毫秒。
 * 缺字段 / 格式不对返回 null——调用方丢弃这一条，而不是编一个「现在」的时间。
 */
export function parseEastmoneyTime(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text.trim())
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  const ms =
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) -
    CN_OFFSET_MS
  return Number.isFinite(ms) ? ms : null
}

/** 去 HTML 标签、解常见实体、压缩空白；空串表示这条没法显示 */
export function cleanNewsTitle(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** 优先 https 的移动端地址，退回 PC 地址；都没有就给空串（卡片不渲染成链接） */
function pickUrl(row: Record<string, unknown>): string {
  const mobile = typeof row.url_m === 'string' ? row.url_m.trim() : ''
  if (mobile.startsWith('https://')) return mobile
  const web = typeof row.url_w === 'string' ? row.url_w.trim() : ''
  if (web !== '') return web
  const unique = typeof row.url_unique === 'string' ? row.url_unique.trim() : ''
  return unique
}

/**
 * 解析 `var ajaxResult={...};`。
 *
 * 任何解析失败都返回空数组，绝不抛错：这张卡片没有「因为新闻挂了整块白掉」
 * 这个状态。字段缺失的行整条丢弃；同 id 只留第一条。
 */
export function parseEastmoneyNews(body: string): NewsItem[] {
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return []

  let payload: unknown
  try {
    payload = JSON.parse(body.slice(start, end + 1))
  } catch {
    return []
  }

  const rows = (payload as { LivesList?: unknown } | null)?.LivesList
  if (!Array.isArray(rows)) return []

  const out: NewsItem[] = []
  const seen = new Set<string>()
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    const title = cleanNewsTitle(typeof row.title === 'string' ? row.title : '')
    const tsMs = parseEastmoneyTime(typeof row.showtime === 'string' ? row.showtime : '')
    if (id === '' || title === '' || tsMs === null) continue
    if (seen.has(id)) continue
    seen.add(id)

    const style = typeof row.titlestyle === 'string' ? row.titlestyle.trim() : ''
    out.push({
      id,
      title,
      url: pickUrl(row),
      source: 'eastmoney',
      tsMs,
      // 缺 titlestyle 时当作普通事件：宁可少标「重要」，也不要把 50 条全标成重要
      important: style !== '' && style !== '0',
    })
  }
  return out
}

/** 重要事件优先，其余按时间降序；这条次序就是卡片「大事」Tab 的显示顺序 */
export function pickNews(items: readonly NewsItem[], limit: number): NewsItem[] {
  const n = Math.max(1, Math.trunc(limit))
  return [...items]
    .sort((a, b) => Number(b.important) - Number(a.important) || b.tsMs - a.tsMs)
    .slice(0, n)
}

async function fetchEastmoneyNews(): Promise<NewsItem[]> {
  const res = await fetch(NEWS_URL, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`eastmoney news http ${res.status}`)
  return parseEastmoneyNews(await res.text())
}

export interface NewsReaderDeps {
  /** 默认打东财；单测注入桩函数即可完全离线 */
  fetchNews?: () => Promise<NewsItem[]>
  now?: () => number
  /** 缓存时长；60 秒 = 卡片 60 秒轮询一次，正常情况下一轮只打一次外网 */
  ttlMs?: number
  /** 失败回调（路由层接 fastify logger）；同一 TTL 内最多叫一次，避免日志刷屏 */
  onWarn?: (error: unknown) => void
}

/**
 * 60 秒缓存 + 失败回退。
 *
 * 语义（三条都是给卡片用的，别随意改）：
 *   · 缓存新鲜 → 直接用，不打外网；
 *   · 拉取失败但有旧缓存 → 返回旧条目 + `stale: true`；
 *   · 拉取失败且从未成功 → 空数组 + `stale: true`（HTTP 仍是 200）。
 *
 * 并发合并：两轮 tick 撞在一起时只发一次请求，否则 5 秒一次的重渲染会把
 * 快讯源打成 DDoS。
 */
export class NewsReader {
  private items: NewsItem[] | null = null
  private fetchedAt = 0
  private lastWarnAt = Number.NEGATIVE_INFINITY
  private inflight: Promise<NewsItem[]> | null = null

  private readonly fetchNews: () => Promise<NewsItem[]>
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly onWarn?: (error: unknown) => void

  constructor(deps: NewsReaderDeps = {}) {
    this.fetchNews = deps.fetchNews ?? fetchEastmoneyNews
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? 60_000
    this.onWarn = deps.onWarn
  }

  /** 当前缓存（测试与调试用）；从未成功过是 null */
  peek(): NewsItem[] | null {
    return this.items
  }

  async read(limit: number): Promise<NewsPayload> {
    const age = this.now() - this.fetchedAt
    const fresh = this.items !== null && age >= 0 && age < this.ttlMs

    if (!fresh) {
      try {
        const items = await this.load()
        this.items = items
        this.fetchedAt = this.now()
      } catch (err) {
        const at = this.now()
        if (at - this.lastWarnAt >= this.ttlMs) {
          this.lastWarnAt = at
          this.onWarn?.(err)
        }
        return {
          items: this.items === null ? [] : pickNews(this.items, limit),
          tsMs: this.fetchedAt,
          stale: true,
        }
      }
    }

    return {
      items: pickNews(this.items ?? [], limit),
      tsMs: this.fetchedAt,
      stale: false,
    }
  }

  private load(): Promise<NewsItem[]> {
    this.inflight ??= this.fetchNews().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }
}

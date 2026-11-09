import type { Db } from '../store/db'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

export interface FxRate {
  pair: string
  rate: number
  prevClose: number
  tsMs: number
  sourceId: string
}

/** 东财离岸人民币：f43/f60 放大 10000 倍（实测 2026-11-10：66716 → 6.6716） */
export async function fetchUsdCny(): Promise<FxRate> {
  const url = 'https://push2.eastmoney.com/api/qt/stock/get?secid=133.USDCNH&fields=f43,f60,f86'
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`fx http ${res.status}`)
  const d = ((await res.json()) as { data?: { f43?: number; f60?: number; f86?: number } | null })?.data
  // f43 缺失/为 0 一律当失败：0 汇率会让 fxPct 变成 -100%，比没有汇率危险得多
  if (!d?.f43 || !Number.isFinite(d.f43)) throw new Error('fx empty')
  const rate = d.f43 / 10000
  const prevClose = Number.isFinite(d.f60) && d.f60! > 0 ? d.f60! / 10000 : rate
  return {
    pair: 'USDCNY',
    rate,
    prevClose,
    tsMs: (d.f86 ?? 0) * 1000 || Date.now(),
    sourceId: 'eastmoney',
  }
}

/** 新浪在岸人民币兜底：字段 1 为现价，字段 8 为昨收（实测报文） */
export async function fetchUsdCnyFallback(): Promise<FxRate> {
  const res = await fetch('https://hq.sinajs.cn/list=fx_susdcny', {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
  })
  if (!res.ok) throw new Error(`fx fallback http ${res.status}`)
  const text = new TextDecoder('gbk').decode(await res.arrayBuffer())
  const f = text.split('"')[1]?.split(',') ?? []
  const rate = Number(f[1])
  const prevClose = Number(f[8] ?? f[1])
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('fx fallback parse failed')
  // 新浪偶发把昨收留空：缺失时退化成现价（fxPct = 0），不要编一个昨收出来
  return {
    pair: 'USDCNY',
    rate,
    prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : rate,
    tsMs: Date.now(),
    sourceId: 'sina',
  }
}

/**
 * 汇率落库，供两个源都失败时兜底。
 *
 * 为什么需要：汇率不可用不该让整条估值 500，也不该静默按「汇率不变」算——
 * 后者会把汇率那条腿的涨跌悄悄抹掉。用上一次真实汇率（并带上它的 sourceId/ts）
 * 至少是个有据可查的数值，界面也能标出"汇率可能滞后"。
 */
export function saveFx(db: Db, fx: FxRate): void {
  db.prepare(
    `insert into fx_cache (pair, rate, prev_close, ts_ms, source_id, fetched_at)
     values (?,?,?,?,?,?)
     on conflict(pair, source_id) do update set
       rate=excluded.rate, prev_close=excluded.prev_close,
       ts_ms=excluded.ts_ms, fetched_at=excluded.fetched_at`,
  ).run(fx.pair, fx.rate, fx.prevClose, fx.tsMs, fx.sourceId, Date.now())
}

/** 最近一次落库的汇率；库里没有（或值非法）时返回 null */
export function loadCachedFx(db: Db, pair = 'USDCNY'): FxRate | null {
  const row = db
    .prepare(
      `select pair, rate, prev_close, ts_ms, source_id from fx_cache
       where pair = ? order by fetched_at desc limit 1`,
    )
    .get(pair) as
    | { pair: string; rate: number; prev_close: number; ts_ms: number; source_id: string }
    | undefined
  if (!row || !(row.rate > 0) || !(row.prev_close > 0)) return null
  return {
    pair: row.pair,
    rate: row.rate,
    prevClose: row.prev_close,
    tsMs: row.ts_ms,
    sourceId: row.source_id,
  }
}

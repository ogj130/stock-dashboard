import type { Db } from './db'

/**
 * fund 表的一行。字段与 schema 一一对应，UI 直接用（`calibrated_at` 为 null
 * 表示尚未校准，界面据此打灰标）。
 */
export interface FundRow {
  id: number
  code: string
  name: string
  kind: string
  target_etf_code: string | null
  index_key: string | null
  asset_class: string
  shares: number
  cost_basis: number
  exposure: number
  lag_days: number
  calibrated_at: number | null
  created_at: number
}

export interface InsertFundInput {
  code: string
  name?: string
  /** 跟踪指数键（如 'ndx'）。不传则沿用库里已有的值，避免重录时把全量权重来源抹掉 */
  indexKey?: string | null
  shares: number
  costBasis: number
  exposure?: number
  lagDays?: number
}

/**
 * 按 code upsert 一只基金。
 *
 * created_at 没有默认值，必须显式传 Date.now()；只在插入分支用得上，更新分支
 * 不动它（建仓时间不因重录而漂移）。exposure/lag_days 同理只在插入时写入默认值：
 * 它们是校准产物，重录持仓数不该把它们打回默认，那会静默改掉估值口径。
 */
export function insertFund(db: Db, input: InsertFundInput): FundRow {
  db.prepare(
    `insert into fund (code, name, index_key, shares, cost_basis, exposure, lag_days, created_at)
     values (?,?,?,?,?,?,?,?)
     on conflict(code) do update set
       -- 显式给了 name 就更新；空串视为「没提供」，别把已有名称擦成空
       name=case when excluded.name <> '' then excluded.name else fund.name end,
       -- 没传 indexKey 时保留旧值（coalesce 顶住 null）
       index_key=coalesce(excluded.index_key, fund.index_key),
       shares=excluded.shares,
       cost_basis=excluded.cost_basis`,
  ).run(
    input.code,
    input.name ?? '',
    input.indexKey ?? null,
    input.shares,
    input.costBasis,
    input.exposure ?? 0.95,
    input.lagDays ?? 1,
    Date.now(),
  )
  return db.prepare('select * from fund where code = ?').get(input.code) as unknown as FundRow
}

export function listFunds(db: Db): FundRow[] {
  return db.prepare('select * from fund order by id').all() as unknown as FundRow[]
}

export function getFundByCode(db: Db, code: string): FundRow | null {
  const row = db.prepare('select * from fund where code = ?').get(code)
  return row ? (row as unknown as FundRow) : null
}

export function deleteFund(db: Db, id: number): number {
  const res = db.prepare('delete from fund where id = ?').run(id)
  return Number(res.changes)
}

/**
 * 写入/覆盖某日净值。
 *
 * 用 do update 而非 do nothing：官方偶尔会重述净值，而 nav_history.pct 是
 * 校准与残差的地面真值，留着旧值会让校准系统性偏斜。
 */
export function upsertNav(db: Db, code: string, date: string, nav: number, pct: number): void {
  db.prepare(
    `insert into nav_history (fund_code, nav_date, nav, pct, fetched_at) values (?,?,?,?,?)
     on conflict(fund_code, nav_date) do update set
       nav=excluded.nav, pct=excluded.pct, fetched_at=excluded.fetched_at`,
  ).run(code, date, nav, pct, Date.now())
}

/**
 * 官方净值的「日期」部分。
 *
 * 和 `latestNavOf` 分开取是因为语义不同：这个日期是**口径的锚点**——
 * 估值是「相对这个净值再往后涨了多少」，没有它就说不清当前市值代表哪一天。
 */
export function latestNavDate(db: Db, code: string): string | null {
  const row = db
    .prepare('select nav_date from nav_history where fund_code = ? order by nav_date desc limit 1')
    .get(code) as { nav_date: string } | undefined
  return row?.nav_date ?? null
}

/**
 * 官方净值日之后、目标净值日之前，每一场美股的估算涨跌。
 *
 * QDII 净值天然滞后（T+1/T+2）：官方净值停在 11-06 时，我们算的「当日涨跌」
 * 只是 11-10 这一场，而 11-09 那一场（+3.18%）已经发生、还没体现在净值里。
 * 不把这段串起来，界面上的总资产就会少算这一段，看起来像凭空亏了一万。
 *
 * 同一天可能有多个相位的留痕（pre/live/settled），取**最接近收盘**的那条：
 * settled > live > pre。settled 是那一场走完之后记的，才代表这一场的最终结果。
 */
export function sessionsSinceNav(
  db: Db,
  code: string,
  navDate: string | null,
  beforeDate: string,
): Array<{ date: string; pct: number }> {
  if (!navDate) return []
  const rows = db
    .prepare(
      `select target_nav_date as date, phase, model_pct as pct, model_ts
         from estimate_log
        where fund_code = ? and target_nav_date > ? and target_nav_date < ?
        order by target_nav_date asc, model_ts desc`,
    )
    .all(code, navDate, beforeDate) as unknown as Array<{
    date: string
    phase: string
    pct: number
    model_ts: number
  }>

  const rank: Record<string, number> = { settled: 3, live: 2, pre: 1 }
  const best = new Map<string, { date: string; pct: number; rank: number }>()
  for (const r of rows) {
    const score = rank[r.phase] ?? 0
    const prev = best.get(r.date)
    if (!prev || score > prev.rank) best.set(r.date, { date: r.date, pct: r.pct, rank: score })
  }
  // 已经按日期升序扫过，这里按日期再排一次，避免 Map 顺序被覆盖影响
  return [...best.values()].sort((a, b) => a.date.localeCompare(b.date)).map(({ date, pct }) => ({ date, pct }))
}

/** 按净值日倒序返回，供校准窗口取最近 N 天 */
export function getNavHistory(
  db: Db,
  code: string,
  limit = 90,
): Array<{ nav_date: string; pct: number }> {
  return db
    .prepare('select nav_date, pct from nav_history where fund_code = ? order by nav_date desc limit ?')
    .all(code, limit) as unknown as Array<{ nav_date: string; pct: number }>
}

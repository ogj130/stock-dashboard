import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export type Db = DatabaseSync

/**
 * 有序迁移。每一项是「从版本 N 升到 N+1」的增量。
 * 永远不要改已发布的迁移——新增列就追加新的一项。
 * 用 create table if not exists 初始化已有库是静默 no-op，所以必须靠版本号驱动。
 */
const MIGRATIONS: Array<(db: Db) => void> = [
  // v1：初始 schema
  (db) => {
    db.exec(`
      create table fund (
        id integer primary key autoincrement,
        code text not null unique,
        name text not null default '',
        kind text not null default 'index',
        target_etf_code text,
        index_key text,
        asset_class text not null default 'us_equity',
        shares real not null default 0 check (shares >= 0),
        cost_basis real not null default 0,
        exposure real not null default 0.95 check (exposure between 0 and 1.5),
        lag_days integer not null default 1 check (lag_days in (0, 1, 2)),
        calibrated_at integer,
        created_at integer not null
      );

      create table constituent (
        id integer primary key autoincrement,
        owner_type text not null,
        owner_key text not null,
        symbol text not null,
        name text not null default '',
        weight real not null check (weight >= 0 and weight <= 1),
        as_of text not null,
        source text not null,
        fetched_at integer not null,
        unique(owner_type, owner_key, symbol, as_of)
      );
      create index idx_constituent_latest on constituent(owner_type, owner_key, as_of desc);

      create table quote_cache (
        symbol text not null,
        asset_class text not null default 'us_equity',
        price real not null check (price >= 0),
        prev_close real not null check (prev_close >= 0),
        pct real not null check (pct between -1000 and 1000),
        precision integer not null default 2,
        ts_ms integer not null,
        source_id text not null,
        fetched_at integer not null,
        primary key (symbol, source_id)
      );

      create table fx_cache (
        pair text not null,
        rate real not null check (rate > 0),
        prev_close real not null check (prev_close > 0),
        ts_ms integer not null,
        source_id text not null,
        fetched_at integer not null,
        primary key (pair, source_id)
      );

      create table nav_history (
        fund_code text not null references fund(code) on delete cascade,
        nav_date text not null,
        nav real not null check (nav > 0),
        pct real not null,
        fetched_at integer not null,
        primary key (fund_code, nav_date)
      );

      create table estimate_log (
        id integer primary key autoincrement,
        fund_code text not null references fund(code) on delete cascade,
        model_ts integer not null,
        target_nav_date text not null,
        phase text not null check (phase in ('live', 'settled')),
        model_pct real not null,
        model_amount real not null default 0,
        covered_weight real not null check (covered_weight >= 0 and covered_weight <= 1),
        lag_days integer not null,
        exposure real not null
      );
      create index idx_estimate_lookup on estimate_log(fund_code, target_nav_date, phase);
      create index idx_estimate_ts on estimate_log(model_ts);

      create table residual (
        id integer primary key autoincrement,
        fund_code text not null references fund(code) on delete cascade,
        nav_date text not null,
        model_pct real not null,
        actual_pct real not null,
        diff real not null,
        nav_ts integer not null,
        unique(fund_code, nav_date)
      );

      create table quote_symbol_market (
        symbol text primary key,
        market integer not null,
        updated_at integer not null
      );
    `)
  },
  // v2：估算留痕按 (基金, 净值日, 相位) 唯一。
  // 5 秒轮询如果每跳都追加，单基金每天 4680 行、全年约 70GB；
  // 而且对账时无法确定"哪一行才是收盘估值"。改为原地覆盖，每天最多两行。
  (db) => {
    db.exec(`
      delete from estimate_log as a where exists (
        select 1 from estimate_log b
        where a.fund_code = b.fund_code
          and a.target_nav_date = b.target_nav_date
          and a.phase = b.phase
          and a.id < b.id
      );
      create unique index idx_estimate_day
        on estimate_log(fund_code, target_nav_date, phase);
    `)
  },
  // v3：covered_weight 的精确上界会让浮点漂移误伤。
  // 100 个归一化权重求和，实测 38% 的概率 > 1.0（2000 次模拟 764 次，本例 sum=1.0000000000000007），
  // 而 CHECK 失败会 abort 整个 logEstimates 事务，路由直接 500。
  // SQLite 不能改 CHECK，只能重建表：建新表 → 搬数据 → 换名 → 重建索引。
  (db) => {
    db.exec(`
      create table estimate_log_new (
        id integer primary key autoincrement,
        fund_code text not null references fund(code) on delete cascade,
        model_ts integer not null,
        target_nav_date text not null,
        phase text not null check (phase in ('live', 'settled')),
        model_pct real not null,
        model_amount real not null default 0,
        covered_weight real not null check (covered_weight >= 0 and covered_weight <= 1.000001),
        lag_days integer not null,
        exposure real not null
      );
      insert into estimate_log_new select id, fund_code, model_ts, target_nav_date, phase,
        model_pct, model_amount, covered_weight, lag_days, exposure from estimate_log;
      drop table estimate_log;
      alter table estimate_log_new rename to estimate_log;
      create index idx_estimate_lookup on estimate_log(fund_code, target_nav_date, phase);
      create unique index idx_estimate_day on estimate_log(fund_code, target_nav_date, phase);
      create index idx_estimate_ts on estimate_log(model_ts);
    `)
  },
  // v4：组合市值时间序列，用于前端折线图。
  // 5 秒轮询全量落库会达到每天 17k 行，所以写入侧做节流（见 estimate 路由）。
  (db) => {
    db.exec(`
      create table portfolio_snapshot (
        id integer primary key autoincrement,
        ts_ms integer not null,
        total_value real not null,
        total_amount real not null,
        fund_count integer not null
      );
      create index idx_portfolio_ts on portfolio_snapshot(ts_ms);
    `)
  },
  // v5：曲线要能看「赚了多少」——持有收益 = Σ(市值 − 成本)。历史行没有这个值，
  // 用 0 回填；旧点在新指标下会显示为贴零的直线，这是如实反映「当时没记录」。
  (db) => {
    db.exec(`alter table portfolio_snapshot add column total_profit real not null default 0`)
  },
  // v6：相位多出「盘前」。
  // 盘前必须与 live 分开记：那一段的常规行情是**上一交易日收盘**，
  // 混进 live 会让对账时把「昨天收盘的涨跌」和「今天盘前的涨跌」当成同一条序列。
  // CHECK 约束不能改，只能照 v3 的办法重建；独有的索引要跟着重建。
  (db) => {
    db.exec(`
      create table estimate_log_new (
        id integer primary key autoincrement,
        fund_code text not null references fund(code) on delete cascade,
        model_ts integer not null,
        target_nav_date text not null,
        phase text not null check (phase in ('pre', 'live', 'settled')),
        model_pct real not null,
        model_amount real not null default 0,
        covered_weight real not null check (covered_weight >= 0 and covered_weight <= 1.000001),
        lag_days integer not null,
        exposure real not null
      );
      insert into estimate_log_new select id, fund_code, model_ts, target_nav_date, phase,
        model_pct, model_amount, covered_weight, lag_days, exposure from estimate_log;
      drop table estimate_log;
      alter table estimate_log_new rename to estimate_log;
      create index idx_estimate_lookup on estimate_log(fund_code, target_nav_date, phase);
      create unique index idx_estimate_day on estimate_log(fund_code, target_nav_date, phase);
      create index idx_estimate_ts on estimate_log(model_ts);
    `)
  },
  // v7：盘前的第二组快照。
  // 盘前时段「收盘口径」的总市值是个常数（上一场收盘估出来的），曲线要画的是
  // 今天盘前这一段怎么走的，那就得单独落一列盘前口径的市值/收益。
  // 允许为 NULL：v6 之前落的历史行没有这个口径，编一个 0 会在图上画出断崖。
  (db) => {
    db.exec(`
      alter table portfolio_snapshot add column total_value_pre real;
      alter table portfolio_snapshot add column total_amount_pre real;
    `)
  },
]

export const SCHEMA_VERSION = MIGRATIONS.length

export function migrate(db: Db): void {
  const row = db.prepare('pragma user_version').get() as { user_version: number }
  const current = row.user_version
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('begin')
    try {
      MIGRATIONS[v]!(db)
      db.exec(`pragma user_version = ${v + 1}`)
      db.exec('commit')
    } catch (e) {
      db.exec('rollback')
      throw e
    }
  }
}

export function openDb(path: string): Db {
  const isMemory = path === ':memory:'
  if (!isMemory) mkdirSync(dirname(resolve(path)), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('pragma busy_timeout = 5000')
  db.exec('pragma foreign_keys = on')
  db.exec('pragma journal_mode = wal')
  migrate(db)
  return db
}

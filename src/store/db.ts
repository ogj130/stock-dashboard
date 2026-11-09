import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = DatabaseSync

const SCHEMA = `
create table if not exists fund (
  id integer primary key autoincrement,
  code text not null unique,
  name text not null default '',
  kind text not null default 'index',
  target_etf_code text,
  index_key text,
  asset_class text not null default 'us_equity',
  shares real not null default 0,
  cost_basis real not null default 0,
  exposure real not null default 0.95,
  lag_days integer not null default 1,
  calibrated_at text,
  created_at text not null default (datetime('now'))
);

create table if not exists constituent (
  id integer primary key autoincrement,
  owner_type text not null,
  owner_key text not null,
  symbol text not null,
  name text not null default '',
  weight real not null,
  as_of text not null,
  source text not null,
  unique(owner_type, owner_key, symbol, as_of)
);

create table if not exists quote_cache (
  symbol text not null,
  asset_class text not null default 'us_equity',
  price real not null,
  prev_close real not null,
  pct real not null,
  ts_ms integer not null,
  source_id text not null,
  fetched_at integer not null,
  primary key (symbol, source_id)
);

create table if not exists fx_cache (
  pair text not null,
  rate real not null,
  ts_ms integer not null,
  source_id text not null,
  primary key (pair, source_id)
);

create table if not exists nav_history (
  fund_code text not null,
  nav_date text not null,
  nav real not null,
  pct real not null,
  primary key (fund_code, nav_date)
);

create table if not exists estimate_log (
  id integer primary key autoincrement,
  fund_code text not null,
  model_ts integer not null,
  phase text not null,
  model_pct real not null,
  model_amount real not null default 0,
  covered_weight real not null,
  constituents_json text not null,
  lag_days integer not null,
  exposure real not null
);

create table if not exists residual (
  id integer primary key autoincrement,
  fund_code text not null,
  nav_date text not null,
  model_pct real not null,
  actual_pct real not null,
  diff real not null,
  nav_ts integer not null,
  unique(fund_code, nav_date)
);

create index if not exists idx_constituent_owner on constituent(owner_type, owner_key);
create index if not exists idx_estimate_fund_ts on estimate_log(fund_code, model_ts);
`

export function migrate(db: Db): void {
  db.exec(SCHEMA)
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal')
  migrate(db)
  return db
}

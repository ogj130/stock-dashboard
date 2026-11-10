import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './db'

/**
 * 日常维护：备份 + 修剪。
 *
 * 备份先行：`data/app.db` 里是你真实的持仓与全部对账原料，而它此前**没有任何备份**。
 * 这个程序每天写上千行快照，一次误删/一次磁盘满就是不可恢复的损失，
 * 相比之下"再多一个功能"根本不重要。
 */

/** 保留多少天的快照。7 日档要 7 天，留 90 天足够回看，也拦住了无限增长 */
export const SNAPSHOT_KEEP_DAYS = 90

/** 备份保留份数 */
export const BACKUP_KEEP = 7

/**
 * 用 SQLite 官方的 `vacuum into` 做备份，而不是复制文件。
 *
 * WAL 模式下直接 `cp app.db` 复制到的是**不完整**的库（最新数据还在 -wal 里，
 * 甚至可能复制到写了一半的页）。`vacuum into` 走的是一致的读事务，
 * 产出一个可直接打开的单文件快照，这是官方推荐的备份方式。
 */
export function backupDb(
  db: Db,
  dir: string,
  now: Date = new Date(),
  keep: number = BACKUP_KEEP,
): string {
  mkdirSync(dir, { recursive: true })
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('')
  const file = join(dir, `app-${stamp}.db`)
  // 同一天重复调用就覆盖：一天一份，不是一小时一份
  rmSync(file, { force: true })
  db.exec(`vacuum into '${file.replace(/'/g, "''")}'`)

  // 只留最近 keep 份：按文件名（日期）排序即可，YYYYMMDD 天然可比
  const all = readdirSync(dir)
    .filter((n) => /^app-\d{8}\.db$/.test(n))
    .sort()
  for (const name of all.slice(0, Math.max(0, all.length - keep))) {
    rmSync(join(dir, name), { force: true })
  }
  return file
}

/**
 * 修剪过期快照。返回删掉的行数。
 *
 * 每天约 2880 行（30 秒一条），一年百万行；曲线最长只看到 7 日档，
 * 留 90 天是为了**日后想加长周期时还有原料**，不是为了现在显示。
 */
export function pruneSnapshots(
  db: Db,
  now: number = Date.now(),
  keepDays: number = SNAPSHOT_KEEP_DAYS,
): number {
  const cutoff = now - keepDays * 86_400_000
  const res = db.prepare('delete from portfolio_snapshot where ts_ms < ?').run(cutoff)
  return Number(res.changes ?? 0)
}

export interface MaintenanceResult {
  backupFile: string | null
  pruned: number
  error: string | null
}

/** 启动时与定时各跑一次；任何一步失败都不许影响主业务 */
export function runMaintenance(db: Db, dir: string, now: number = Date.now()): MaintenanceResult {
  let backupFile: string | null = null
  let pruned = 0
  let error: string | null = null
  try {
    backupFile = backupDb(db, dir, new Date(now))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  try {
    pruned = pruneSnapshots(db, now)
  } catch (e) {
    error = error ?? (e instanceof Error ? e.message : String(e))
  }
  return { backupFile, pruned, error }
}

/** 备份目录里现有份数（供自检脚本/日志用） */
export function countBackups(dir: string): number {
  try {
    return readdirSync(dir).filter((n) => /^app-\d{8}\.db$/.test(n)).length
  } catch {
    return 0
  }
}

/** 最新一份备份的绝对路径；没有则 null */
export function latestBackup(dir: string): string | null {
  try {
    const all = readdirSync(dir)
      .filter((n) => /^app-\d{8}\.db$/.test(n))
      .sort()
    const last = all[all.length - 1]
    if (!last) return null
    const file = join(dir, last)
    return statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/store/db'
import {
  BACKUP_KEEP,
  backupDb,
  countBackups,
  latestBackup,
  pruneSnapshots,
  runMaintenance,
} from '../../src/store/maintenance'

/**
 * 备份是这份程序里唯一「不做就会永久损失数据」的功能，所以几条边界都要钉：
 * 备份出来的库能独立打开、同日只留一份、只保留最近 N 份、修剪只删过期行。
 */
/** 每个用例一个独立临时目录：互不干扰，也让"保留份数"这类断言不受其他用例污染 */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'qdii-maint-'))
}

describe('backupDb', () => {
  it('产出一个可直接打开的独立库（WAL 里的数据也在里面）', () => {
    const db = openDb(':memory:')
    db.prepare('insert into fund (code, created_at) values (?,?)').run('270042', 1)
    const out = join(freshDir(), 'backups')
    const file = backupDb(db, out, new Date(2026, 10, 11))
    expect(file.endsWith('app-20261111.db')).toBe(true)
    expect(statSync(file).size).toBeGreaterThan(0)

    // 独立打开：能读到刚才那一行，说明备份不是空壳
    const copy = openDb(file)
    const row = copy.prepare('select count(*) c from fund').get() as { c: number }
    expect(row.c).toBe(1)
    copy.close()
  })

  it('同一天重复备份只留一份（覆盖，不是堆一堆）', () => {
    const db = openDb(':memory:')
    const out = join(freshDir(), 'backups-dup')
    backupDb(db, out, new Date(2026, 10, 11))
    backupDb(db, out, new Date(2026, 10, 11, 18))
    expect(countBackups(out)).toBe(1)
  })

  it('超过保留份数时删最旧的', () => {
    const db = openDb(':memory:')
    const out = join(freshDir(), 'backups-keep')
    for (let d = 1; d <= BACKUP_KEEP + 3; d++) {
      backupDb(db, out, new Date(2026, 10, d))
    }
    expect(countBackups(out)).toBe(BACKUP_KEEP)
    const files = readdirSync(out).sort()
    // 最早的三份应该没了
    expect(files[0]).toBe('app-20261104.db')
    expect(latestBackup(out)?.endsWith('app-20261110.db')).toBe(true)
  })
})

describe('pruneSnapshots', () => {
  it('只删超过保留天数的行，近期一行不动', () => {
    const db = openDb(':memory:')
    const now = Date.UTC(2026, 10, 11, 12)
    const day = 86_400_000
    const stmt = db.prepare(
      'insert into portfolio_snapshot (ts_ms, total_value, total_amount, fund_count) values (?,?,?,?)',
    )
    stmt.run(now - 200 * day, 1, 0, 1) // 过期
    stmt.run(now - 91 * day, 1, 0, 1) // 过期
    stmt.run(now - 89 * day, 1, 0, 1) // 保留
    stmt.run(now - 1 * day, 1, 0, 1) // 保留

    expect(pruneSnapshots(db, now)).toBe(2)
    const left = db.prepare('select count(*) c from portfolio_snapshot').get() as { c: number }
    expect(left.c).toBe(2)
  })
})

describe('runMaintenance', () => {
  it('备份与修剪都跑，失败不抛（主业务不能被维护搞挂）', () => {
    const db = openDb(':memory:')
    const out = join(freshDir(), 'backups-run')
    const r = runMaintenance(db, out, Date.UTC(2026, 10, 11, 12))
    expect(r.error).toBeNull()
    expect(r.backupFile).not.toBeNull()
    expect(r.pruned).toBe(0)
  })

  it('目录不可写时 error 有值但不抛异常', () => {
    const db = openDb(':memory:')
    const r = runMaintenance(db, '/dev/null/not-a-dir', Date.UTC(2026, 10, 11, 12))
    expect(r.error).not.toBeNull()
  })
})

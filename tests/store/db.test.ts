import { describe, it, expect } from 'vitest'
import { openDb, migrate } from '../../src/store/db'

describe('db', () => {
  it('建表后六张表都存在', () => {
    const db = openDb(':memory:')
    const names = db
      .prepare("select name from sqlite_master where type='table' order by name")
      .all()
      .map((r: any) => r.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'fund', 'constituent', 'quote_cache', 'fx_cache', 'nav_history', 'estimate_log', 'residual',
      ]),
    )
  })

  it('重复建表不报错（幂等迁移）', () => {
    const db = openDb(':memory:')
    expect(() => migrate(db)).not.toThrow()
  })
})

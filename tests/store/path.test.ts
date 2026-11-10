import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { defaultDbPath, userDataDir } from '../../src/store/path'

// 这一条是「分享 exe = 分享持仓」那个坑的闸门：
// 数据库一旦落在程序目录，就会被连同文件夹一起打包发出去。
let dir = ''
const savedPath = process.env.DB_PATH

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qdii-path-'))
  delete process.env.DB_PATH
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (savedPath === undefined) delete process.env.DB_PATH
  else process.env.DB_PATH = savedPath
})

describe('defaultDbPath', () => {
  it('DB_PATH 优先，别的规则都不看', () => {
    process.env.DB_PATH = '/tmp/explicit.db'
    expect(defaultDbPath(dir)).toBe('/tmp/explicit.db')
  })

  it('cwd 下已经有 data/app.db → 原地兼容（开发机升级不丢数据）', () => {
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, 'data'), { recursive: true })
    writeFileSync(join(repo, 'data', 'app.db'), '')
    expect(defaultDbPath(repo)).toBe(join(repo, 'data', 'app.db'))
  })

  it('全新安装 → 落到用户数据目录，程序目录保持干净', () => {
    const fresh = join(dir, 'green')
    mkdirSync(fresh, { recursive: true })
    const p = defaultDbPath(fresh)
    expect(p).toBe(join(userDataDir(), 'app.db'))
    expect(p.startsWith(fresh)).toBe(false)
  })

  it('空白 DB_PATH 视为未设置（空字符串会让人以为自己在用临时库）', () => {
    process.env.DB_PATH = '   '
    expect(defaultDbPath(dir)).toContain('app.db')
    expect(defaultDbPath(dir)).not.toBe('   ')
  })
})

describe('userDataDir', () => {
  it('按平台给一个稳定的私有目录', () => {
    const d = userDataDir()
    if (process.platform === 'darwin') expect(d).toBe(join(homedir(), 'Library', 'Application Support', 'QDII'))
    else expect(d.length).toBeGreaterThan(0)
  })

  it('Windows 走 %APPDATA%（那里不会被打进 zip）', () => {
    const saved = process.env.APPDATA
    process.env.APPDATA = 'C:\\Users\\x\\AppData\\Roaming'
    // platform 在测试进程里改不了，只验 APPDATA 分支的实际行为靠这一点：
    // 非 win32 时不该用 APPDATA，避免 mac 上 APPDATA 恰好被设过就跑偏
    const d = userDataDir()
    if (process.platform === 'win32') expect(d).toContain('QDII')
    else expect(d).not.toContain('AppData')
    if (saved === undefined) delete process.env.APPDATA
    else process.env.APPDATA = saved
  })
})

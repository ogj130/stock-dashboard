import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 数据库放哪。
 *
 * 老毛病：默认 `data/app.db` 是**相对当前工作目录**的。在仓库里跑没问题，
 * 但打包成绿色版之后，数据库会落在 exe 旁边——那个文件夹是会被整个 zip
 * 发给别人的，于是「分享一个程序」变成「分享你的全部持仓」。
 *
 * 三级取值：
 * 1. `DB_PATH` —— 显式指定，一切以它为准（测试、双开都用它）
 * 2. `<cwd>/data/app.db` 已存在 —— 原地兼容：开发机上的数据不能因为升级就消失
 * 3. 平台用户目录 —— 新装/绿色版走这条，程序目录保持干净
 */
export function defaultDbPath(cwd: string = process.cwd()): string {
  const explicit = process.env.DB_PATH
  if (explicit && explicit.trim().length > 0) return explicit

  const inRepo = join(cwd, 'data', 'app.db')
  if (existsSync(inRepo)) return inRepo

  return join(userDataDir(), 'app.db')
}

/** 用户数据目录：Windows 走 %APPDATA%，macOS 走 Application Support，其余 XDG */
export function userDataDir(): string {
  const appdata = process.env.APPDATA
  if (process.platform === 'win32' && appdata) return join(appdata, 'QDII')
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'QDII')
  }
  const xdg = process.env.XDG_DATA_HOME
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share'), 'qdii')
}

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 前端产物目录（dist/）怎么找。
 *
 * 为什么不能只写一句 `new URL('../dist', import.meta.url)`：
 * 开发时这个文件是 `src/server.ts`，上一级正好是仓库根的 dist/；
 * 但 Windows 绿色版把它用 esbuild 打成了**包目录里的单文件 `server.mjs`**，
 * 此时 `../dist` 指的是「包目录的上一级」——那儿什么都没有。
 * @fastify/static 遇到不存在的 root 只打一条 warning 不注册路由，
 * 于是 `/` 变 404、`/api/*` 一切正常，正好是那次报障的样子。
 *
 * 所以改成按候选列表找，并**要求目录里真的有 index.html**：
 * 空目录/半截产物同样会打出 404，不能算可用。
 */
export interface DistCandidate {
  /** 绝对路径 */
  path: string
  /** 为什么会看这个目录（出错时原样打给人看） */
  why: string
}

export interface DistRootPick {
  /** 可用的产物目录；找不到就是 null（此时只提供 API） */
  root: string | null
  checked: DistCandidate[]
  /** 目录存在但缺 index.html：多半是 vite 没跑或产物没拷全 */
  incomplete: string[]
}

/**
 * 候选顺序 = 可信度顺序：
 * 1. `DIST_DIR` —— 显式指定，永远优先（测试、移植、反代静态资源时用）
 * 2. `<模块目录>/dist` —— 打包版：server.mjs 与 dist/ 同级，和启动方式无关
 * 3. `<模块目录>/../dist` —— 开发版：src/server.ts 的上一级
 * 4. `<cwd>/dist` —— 从仓库根或包目录直接 `node server.mjs` 启动
 */
export function distRootCandidates(
  moduleDir: string,
  cwd: string,
  envDistDir?: string,
): DistCandidate[] {
  const raw: Array<DistCandidate | null> = [
    envDistDir && envDistDir.trim().length > 0
      ? { path: resolve(cwd, envDistDir), why: 'DIST_DIR 环境变量' }
      : null,
    { path: join(moduleDir, 'dist'), why: '服务端文件同级的 dist/（打包版）' },
    { path: resolve(moduleDir, '..', 'dist'), why: '服务端文件上一级的 dist/（开发版）' },
    { path: resolve(cwd, 'dist'), why: '当前工作目录下的 dist/' },
  ]
  const out: DistCandidate[] = []
  for (const c of raw) {
    if (c && !out.some((o) => o.path === c.path)) out.push(c)
  }
  return out
}

/** 取第一个「目录存在且含 index.html」的候选；都没有就返回 null。 */
export function pickDistRoot(
  candidates: DistCandidate[],
  exists: (p: string) => boolean = existsSync,
): DistRootPick {
  const usable = candidates.find((c) => exists(join(c.path, 'index.html')))
  const incomplete = candidates
    .filter((c) => !usable || c.path !== usable.path)
    .filter((c) => exists(c.path))
    .map((c) => c.path)
  return { root: usable?.path ?? null, checked: candidates, incomplete }
}

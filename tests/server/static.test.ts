import { distRootCandidates, pickDistRoot } from '../../src/static'

/** 用一个假的文件系统，避免测试依赖仓库里真实的 dist/ */
function fakeExists(files: string[]) {
  const set = new Set(files.map((f) => f.replace(/\/+$/, '')))
  return (p: string) => set.has(p)
}

describe('distRootCandidates', () => {
  it('打包版候选：模块目录同级的 dist/ 排在模块上一级之前', () => {
    const c = distRootCandidates('/pkg', '/pkg')
    expect(c[0]?.path).toBe('/pkg/dist')
    expect(c[1]?.path).toBe('/dist')
  })

  it('DIST_DIR 永远排第一，且做绝对化', () => {
    const c = distRootCandidates('/pkg', '/elsewhere', 'static-dist')
    expect(c[0]).toEqual({ path: '/elsewhere/static-dist', why: 'DIST_DIR 环境变量' })
  })

  it('去重：打包版里 cwd 与模块目录相同时不重复检查', () => {
    const paths = distRootCandidates('/pkg', '/pkg').map((c) => c.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('空白 DIST_DIR 视为未设置', () => {
    const paths = distRootCandidates('/repo/src', '/repo', '   ').map((c) => c.path)
    expect(paths).not.toContain('/repo')
  })
})

describe('pickDistRoot', () => {
  // 线上事故形态：server.mjs 在 /pkg/，dist 在 /pkg/dist/，上一级的 /dist 不存在
  it('单文件 bundle：选 server.mjs 同级的 dist/', () => {
    const candidates = distRootCandidates('/pkg', '/pkg')
    const pick = pickDistRoot(candidates, fakeExists(['/pkg/dist/index.html']))
    expect(pick.root).toBe('/pkg/dist')
  })

  it('开发版（src/server.ts）：退回上一级的 dist/', () => {
    const candidates = distRootCandidates('/repo/src', '/repo')
    const pick = pickDistRoot(candidates, fakeExists(['/repo/dist/index.html']))
    expect(pick.root).toBe('/repo/dist')
  })

  it('空目录不算可用：没有 index.html 就不能算前端产物', () => {
    const candidates = distRootCandidates('/pkg', '/pkg')
    const pick = pickDistRoot(candidates, fakeExists(['/dist', '/pkg/dist']))
    expect(pick.root).toBeNull()
    expect(pick.incomplete).toContain('/pkg/dist')
  })
})

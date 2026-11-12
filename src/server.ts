import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { openDb } from './store/db'
import { registerFundRoutes } from './routes/funds'
import { registerEstimateRoutes } from './routes/estimate'
import { registerPortfolioRoutes } from './routes/portfolio'
import { registerAccuracyRoutes } from './routes/accuracy'
import { QuoteRegistry } from './sources/registry'
import { EastmoneySource, probeMarket } from './sources/eastmoney'
import { MarketMap } from './sources/marketMap'
import { TencentSource } from './sources/tencent'
import { CnbcSource } from './sources/cnbc'
import { SinaSource } from './sources/sina'
import { derivePhaseLocal } from './engine/phase'
import { defaultDbPath } from './store/path'
import { runMaintenance } from './store/maintenance'
import { loadOrCreateToken, registerAccessGate, resolveHost } from './net/access'
import { distRootCandidates, pickDistRoot } from './static'
import { dirname, join } from 'node:path'

const dbPath = defaultDbPath()
const db = openDb(dbPath)
const app = Fastify({ logger: true })

// 前端构建产物。路径必须按候选列表找：单文件 bundle 之后 import.meta.url 指向包目录里的
// server.mjs，裸写 `../dist` 会飘到包目录上一级——线上那次「访问 / 404、API 正常」就是这么来的。
// 找不到时只提供 API，并把查过哪些路径写进日志，而不是静默 404。
const distPick = pickDistRoot(
  distRootCandidates(dirname(fileURLToPath(import.meta.url)), process.cwd(), process.env.DIST_DIR),
)
const distRoot = distPick.root
if (distRoot) {
  await app.register(fastifyStatic, { root: distRoot, wildcard: false })
} else {
  app.log.error(
    { checked: distPick.checked.map((c) => c.path), missingIndexHtml: distPick.incomplete },
    '找不到前端产物（dist/index.html）：本次只提供 /api/*，访问 / 会是 404',
  )
}

registerFundRoutes(app, db)
registerPortfolioRoutes(app, db)
registerAccuracyRoutes(app, db)
// 快讯只服务菜单栏卡片的「大事」Tab；与估值链路完全解耦，挂了不影响任何数字

/**
 * 市场码来自持仓报文的 NEWTEXCH（免费、准确），由 ensureMarkets 提前灌进这张表。
 *
 * 绝不要写 `?? MARKET.NASDAQ` 兜底——实测 162411（全 NYSE）用默认 105 会拿到 0/10。
 * 市场未知时让东财跳过该票，也不能带着猜出来的前缀整批失败。
 */
const symbolMarket = new Map<string, number>()
const marketMap = new MarketMap(db, probeMarket) // 仅作持仓报文没有 NEWTEXCH 时的兜底
const cnbc = new CnbcSource()

const registry = new QuoteRegistry([
  new EastmoneySource((symbol) => symbolMarket.get(symbol) ?? marketMap.get(symbol)),
  new TencentSource(),
  cnbc,
  new SinaSource(),
])

registerEstimateRoutes(app, {
  db,
  registry,
  /**
   * 必须在取行情之前调用：先灌已知市场码，再对缺口逐个探测。
   * 探测失败的符号保持「未知」，东财会跳过它，缺口由 registry 记入 lastMissing()。
   */
  ensureMarkets: async (symbols, known) => {
    for (const [symbol, market] of Object.entries(known)) symbolMarket.set(symbol, market)
    const unknown = symbols.filter((s) => !symbolMarket.has(s))
    if (unknown.length === 0) return
    const probed = await marketMap.resolve(unknown)
    for (const [symbol, market] of Object.entries(probed)) symbolMarket.set(symbol, market)
  },
  // CNBC 拿不到状态时退回本地美东时钟，不默认 CLOSED（会把盘中误判成已收盘）
  status: async () => {
    try {
      return (await cnbc.fetchMarketStatus()).status
    } catch {
      return derivePhaseLocal(new Date())
    }
  },
})

app.get('/api/health', async () => ({ ok: true }))

/**
 * 备份与修剪：启动跑一次，之后每 6 小时一次。
 *
 * 备份目录放在用户数据目录（与库同源），而不是程序目录：
 * 程序目录会被打包/清理，而备份的目的正是防止程序目录出事。
 */
const backupDir = join(dirname(dbPath), 'backups')
const MAINTENANCE_MS = 6 * 3600_000
function maintain(): void {
  const r = runMaintenance(db, backupDir)
  if (r.error) app.log.warn({ err: r.error }, 'maintenance partial failure')
  else console.log(`backup   ${r.backupFile}（清理快照 ${r.pruned} 行）`)
}
maintain()
setInterval(maintain, MAINTENANCE_MS).unref()

const port = Number(process.env.PORT ?? 5178)
// 局域网默认关：手机要看得显式开（--lan 或 LAN=1）。忘了关的代价是全屋都能看你的持仓
const lan = process.argv.includes('--lan') || process.env.LAN === '1'
const host = resolveHost(lan)
let token = ''
if (lan) {
  token = loadOrCreateToken(dirname(dbPath))
  registerAccessGate(app, token)
}

await app.listen({ port, host })
console.log(`db       ${dbPath}`)
console.log(`ui       http://127.0.0.1:${port}`)
console.log(`web      ${distRoot ?? '未找到 dist/index.html，只提供 /api/*'}`)
if (lan) {
  const nets = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n!.address)
  for (const ip of nets) console.log(`lan      http://${ip}:${port}/?token=${token}`)
  console.log(`token    ${token}  （保存在 ${dirname(dbPath)}，手机首次访问带一次即可）`)
} else {
  console.log('lan      关闭（只监听本机）；手机访问请加 --lan')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .catch(() => {})
      .finally(() => {
        db.close()
        process.exit(0)
      })
  })
}

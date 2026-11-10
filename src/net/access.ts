import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'

/**
 * 访问口令。
 *
 * 只有开了局域网才需要。理由很直接：这台机器上的 `/api/estimate` 会把你全部持仓、
 * 成本、总金额原样吐出来，而库里一处鉴权都没有。同一个 Wi-Fi 下的任何人
 * （咖啡店、公司、合租）都能 GET 到，还能 POST/DELETE 改你的基金。
 *
 * 不做用户体系：单人工具，一个口令够了。口令落成文件而不是库表，
 * 免得为了一个 24 位随机串去加一次 migration。
 */
export const TOKEN_FILE = 'access-token.txt'
export const TOKEN_COOKIE = 'qdii_token'
export const TOKEN_QUERY = 'token'

/** 读已有口令；没有就生成一个 32 位 hex 写下来（权限 0600） */
export function loadOrCreateToken(dir: string): string {
  const file = join(dir, TOKEN_FILE)
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing.length >= 16) return existing
  }
  mkdirSync(dir, { recursive: true })
  const token = randomBytes(16).toString('hex')
  writeFileSync(file, token + '\n', { mode: 0o600 })
  return token
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  // timingSafeEqual 长度不等会抛错；长度本身不是秘密，可以先比
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

/** 本机回环访问：只有这台机器上的进程能连到这个地址，天然不需要口令 */
export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false
  // Node 在 IPv6 socket 上会把 v4 地址报成 ::ffff:127.0.0.1
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  return v4 === '127.0.0.1' || v4 === '::1' || v4.startsWith('127.')
}

interface CookieLike {
  headers: { cookie?: string }
}

/** 从 Cookie 头里挑出 qdii_token（不引 @fastify/cookie：只要读一个键） */
export function tokenFromCookie(req: CookieLike): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === TOKEN_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return null
}

/** 从 query 里取口令（首次访问用 `?token=xxx` 换 Cookie） */
export function tokenFromQuery(req: FastifyRequest): string | null {
  const url = req.raw.url ?? ''
  const q = url.indexOf('?')
  if (q < 0) return null
  const params = new URLSearchParams(url.slice(q + 1))
  const v = params.get(TOKEN_QUERY)
  return v && v.length > 0 ? v : null
}

/**
 * 口令门禁。挂在 onRequest 上，覆盖所有路由（含静态资源）。
 *
 * 为什么静态页也要拦：前端是 SPA，页面本身不含数据，但把入口藏起来能少一半噪音；
 * 更重要的是「打开就能看见登录框之外的东西」会让人误以为没有保护。
 *
 * 校验通过时不下发 Cookie 的路径只有一个：口令来自 query。其余请求靠已有 Cookie。
 */
export function registerAccessGate(app: FastifyInstance, token: string): void {
  app.addHook('onRequest', async (req, reply) => {
    // 本机访问放行：菜单栏小卡片、浏览器、curl 都打 127.0.0.1，
    // 让它们也带口令只会把「手机上要输一次」变成「每处都要配一次」。
    // 回环地址只对本机进程可达，不是暴露面。
    if (isLoopback(req.ip)) return
    if (safeEqual(tokenFromCookie(req) ?? '', token)) return

    const fromQuery = tokenFromQuery(req)
    if (fromQuery && safeEqual(fromQuery, token)) {
      // HttpOnly + SameSite=Lax：前端 JS 拿不到，也不需要拿
      reply.header(
        'set-cookie',
        `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
      )
      return
    }

    // 401 而不是 404：让人知道是没口令，不是服务没了
    return reply.code(401).send({
      error: 'unauthorized',
      hint: `局域网模式需要口令：打开 http://<本机IP>:<端口>/?${TOKEN_QUERY}=<口令>`,
    })
  })
}

/** 绑定地址：默认只听本机。数字设备/手机要看得显式开 —— 忘了关也不会裸奔 */
export function resolveHost(lan: boolean): string {
  return lan ? '0.0.0.0' : '127.0.0.1'
}

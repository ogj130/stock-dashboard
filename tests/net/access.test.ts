import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  TOKEN_COOKIE,
  loadOrCreateToken,
  registerAccessGate,
  resolveHost,
  tokenFromCookie,
  tokenFromQuery,
} from '../../src/net/access'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qdii-token-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('口令文件', () => {
  it('首次生成 32 位 hex 并落盘（0600）', () => {
    const token = loadOrCreateToken(dir)
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(readFileSync(join(dir, 'access-token.txt'), 'utf8').trim()).toBe(token)
    expect(statSync(join(dir, 'access-token.txt')).mode & 0o777).toBe(0o600)
  })

  it('第二次读到同一个口令（重启不会把手机踢下线）', () => {
    const a = loadOrCreateToken(dir)
    const b = loadOrCreateToken(dir)
    expect(b).toBe(a)
  })

  it('文件被清空就重新生成，不会拿空串当口令', () => {
    loadOrCreateToken(dir)
    const file = join(dir, 'access-token.txt')
    writeFileSync(file, '\n')
    expect(loadOrCreateToken(dir)).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('从请求里取口令', () => {
  it('Cookie 头里挑出 qdii_token，不被别的键干扰', () => {
    expect(tokenFromCookie({ headers: { cookie: 'a=1; qdii_token=deadbeef; b=2' } })).toBe('deadbeef')
  })
  it('没有 Cookie 头 / 没有那个键 → null', () => {
    expect(tokenFromCookie({ headers: {} })).toBeNull()
    expect(tokenFromCookie({ headers: { cookie: 'a=1; b=2' } })).toBeNull()
  })
})

describe('局域网门禁', () => {
  const TOKEN = 'a'.repeat(32)
  // 从局域网地址发起的请求（inject 默认 127.0.0.1，会被回环放行）
  const LAN_IP = '192.168.1.50'
  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify()
    registerAccessGate(app, TOKEN)
    app.get('/api/estimate', async () => ({ funds: [{ code: '270042', shares: 149514 }] }))
    app.get('/', async () => 'ui')
    app.delete('/api/funds/:id', async () => ({ ok: true }))
    await app.ready()
  })
  afterEach(async () => {
    await app.close()
  })

  it('没有口令 → 401，且不吐任何持仓（这是整件事的重点）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/estimate', remoteAddress: LAN_IP })
    expect(res.statusCode).toBe(401)
    expect(res.body).not.toContain('270042')
  })

  it('口令错 → 401（长度不等也不炸，timingSafeEqual 会抛）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/estimate?token=bbb',
      remoteAddress: LAN_IP,
    })
    expect(res.statusCode).toBe(401)
  })

  it('口令对 → 200 并下发 HttpOnly Cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/estimate?token=${TOKEN}`,
      remoteAddress: LAN_IP,
    })
    expect(res.statusCode).toBe(200)
    const cookie = String(res.headers['set-cookie'])
    expect(cookie).toContain(`${TOKEN_COOKIE}=${TOKEN}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Path=/')
  })

  it('第二次带 Cookie 就不必再带 query（SPA 轮询靠这条路）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/estimate',
      remoteAddress: LAN_IP,
      headers: { cookie: `${TOKEN_COOKIE}=${TOKEN}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('静态页也拦：别让人以为「打不开数据就还没被保护」', async () => {
    const res = await app.inject({ method: 'GET', url: '/', remoteAddress: LAN_IP })
    expect(res.statusCode).toBe(401)
  })

  it('写接口同样在门禁后面（原先局域网里谁都能 DELETE 基金）', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/funds/1', remoteAddress: LAN_IP })
    expect(res.statusCode).toBe(401)
  })
})

describe('resolveHost', () => {
  it('默认只听本机；显式开才暴露到局域网', () => {
    expect(resolveHost(false)).toBe('127.0.0.1')
    expect(resolveHost(true)).toBe('0.0.0.0')
  })
})

describe('回环放行', () => {
  it('本机 127.0.0.1 免口令直接可读（菜单栏卡片依赖它）', async () => {
    const app = Fastify()
    registerAccessGate(app, 'a'.repeat(32))
    app.get('/api/estimate', async () => ({ funds: [] }))
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/estimate' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  // 菜单栏小卡片和本机浏览器都打 127.0.0.1。若这条也拦，
  // 局域网模式一开，本机的卡片就同时瞎掉——把便利和安全一起弄丢。
  it('127.0.0.1 免口令，局域网地址仍要口令', async () => {
    const { isLoopback } = await import('../../src/net/access')
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('192.168.1.50')).toBe(false)
    expect(isLoopback(undefined)).toBe(false)
  })
})

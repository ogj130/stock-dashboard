import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { openDb } from './store/db'
import { registerFundRoutes } from './routes/funds'

const db = openDb(process.env.DB_PATH ?? 'data/app.db')
const app = Fastify({ logger: true })

// 前端构建产物；dist 不存在时 @fastify/static 只告警不注册路由，API 照常可用
await app.register(fastifyStatic, {
  root: fileURLToPath(new URL('../dist', import.meta.url)),
  wildcard: false,
})

registerFundRoutes(app, db)

app.get('/api/health', async () => ({ ok: true }))

const port = Number(process.env.PORT ?? 5178)
await app.listen({ port, host: '0.0.0.0' })
console.log(`listening on http://127.0.0.1:${port}`)

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

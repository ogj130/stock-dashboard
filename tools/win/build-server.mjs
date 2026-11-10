/**
 * 把服务端打成一个单文件 bundle（ESM）。
 *
 * 为什么是 ESM 而不是 CJS：server.ts 顶部有 await（注册插件、listen），
 * CJS 不支持顶层 await，硬转会把启动顺序打乱。Node 24 原生跑 ESM，没有理由绕。
 * 打完之后运行只需要 node + 这个文件，不用 node_modules。
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outfile = process.argv[2] ?? resolve(root, 'dist-win/server.mjs')

await build({
  entryPoints: [resolve(root, 'src/server.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      'const require = __cr(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
})

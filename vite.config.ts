import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    // 手机会从局域网 IP 打开这个页面，只监听 localhost 就白配了。
    // 代理的目标仍是本机的 5178：代理发生在 dev server 进程里，与手机无关。
    host: true,
    proxy: { '/api': 'http://127.0.0.1:5178' },
  },
})

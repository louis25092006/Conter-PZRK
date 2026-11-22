import { defineConfig } from 'vite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Middleware лише для dev-сервера: імітує повільну й ненадійну мережу,
// щоб перевірити прогрес-бар, таймаути й повтори (див. src/assets/test-flags.js).
//   ?delay=1500        — відповісти через 1.5 с
//   ?fail=2&run=abc    — перші 2 запити з цим run отримують 503, далі — нормальна відповідь
// Плюс: справжній 404 для відсутніх файлів у /assets/ і /api/. Без цього Vite віддає
// на будь-яку невідому адресу index.html зі статусом 200 (SPA fallback), і загрузчик
// бачив би "зіпсовану картинку" замість 404.
function testNetwork() {
  const failures = new Map()
  return {
    name: 'test-network',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://localhost')
        const delay = Number(url.searchParams.get('delay') ?? 0)
        const fail = Number(url.searchParams.get('fail') ?? 0)
        const isData = url.pathname.startsWith('/assets/') || url.pathname.startsWith('/api/')
        const missing = isData && !existsSync(join(server.config.publicDir, decodeURIComponent(url.pathname)))
        const send404 = () => {
          res.statusCode = 404
          res.end('Not Found')
        }

        if (fail > 0) {
          const key = url.pathname + url.searchParams.get('run')
          const count = failures.get(key) ?? 0
          if (count < fail) {
            failures.set(key, count + 1)
            setTimeout(() => {
              res.statusCode = 503
              res.end('Service Unavailable (test)')
            }, delay)
            return
          }
        }
        const proceed = missing ? send404 : next
        if (delay > 0) setTimeout(proceed, delay)
        else proceed()
      })
    },
  }
}

export default defineConfig({
  plugins: [testNetwork()],
})

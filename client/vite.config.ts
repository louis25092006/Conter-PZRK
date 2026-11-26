import { defineConfig, type Plugin } from 'vite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

// Lab 8: штамп версії — короткий git SHA (у Docker його передає збірка через GIT_SHA)
function gitSha(): string {
  if (process.env.GIT_SHA) return process.env.GIT_SHA.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'dev'
  }
}

// Middleware лише для dev-сервера: імітує повільну й ненадійну мережу,
// щоб перевірити прогрес-бар, таймаути й повтори (див. src/assets/test-flags.js).
//   ?delay=1500        — відповісти через 1.5 с
//   ?fail=2&run=abc    — перші 2 запити з цим run отримують 503, далі — нормальна відповідь
// Плюс: справжній 404 для відсутніх файлів у /assets/. Без цього Vite віддає
// на будь-яку невідому адресу index.html зі статусом 200 (SPA fallback), і загрузчик
// бачив би "зіпсовану картинку" замість 404.
function testNetwork(): Plugin {
  const failures = new Map<string, number>()
  return {
    name: 'test-network',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const delay = Number(url.searchParams.get('delay') ?? 0)
        const fail = Number(url.searchParams.get('fail') ?? 0)
        const isData = url.pathname.startsWith('/assets/')
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

// Lab 4: API і WebSocket живуть на Node-сервері (server/, порт 3000).
// У розробці Vite проксює туди /api і /ws, тож для браузера все — одна адреса localhost:5173.
const SERVER = process.env.GAME_SERVER ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [testNetwork()],
  define: { __APP_VERSION__: JSON.stringify(gitSha()) },
  server: {
    proxy: {
      '/api': SERVER,
      '/health': SERVER,
      '/ws': { target: SERVER, ws: true },
    },
  },
})

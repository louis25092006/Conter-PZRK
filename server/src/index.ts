import { loadConfig } from './config.ts'
import { createGameServer } from './app.ts'
import { createLogger } from './logger.ts'

// Lab 6: сервер на TypeScript запускається БЕЗ збірки — Node 24 сам прибирає типи (type stripping).
// Тому в коді немає enum і інших конструкцій, що потребують компіляції (erasableSyntaxOnly).

const config = loadConfig()
const log = createLogger(config)
const game = createGameServer(config, { log })

const port = await game.listen()
log.info(`server listening on http://localhost:${port}`, {
  ws: `ws://localhost:${port}/ws`,
  logDir: config.logDir,
  demo: config.demoEndpoints,
})

// Graceful shutdown: Ctrl+C (SIGINT) або SIGTERM від Docker/хостингу (Lab 8)
let shuttingDown = false
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info(`${signal} received, shutting down…`)
  const force = setTimeout(() => {
    log.error('shutdown took too long, forcing exit')
    process.exit(1)
  }, 5000)
  force.unref()
  await game.close()
  log.info('bye: sockets closed, match logs flushed')
  process.exit(0)
}
process.on('SIGINT', (s) => void shutdown(s))
process.on('SIGTERM', (s) => void shutdown(s))

// Остання лінія оборони: залогувати і вийти (стан процесу вже невідомий — краще перезапуск).
process.on('unhandledRejection', (reason: unknown) => {
  log.error('unhandled rejection', {
    reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  })
  process.exit(1)
})

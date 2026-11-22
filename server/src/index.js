import { loadConfig } from './config.js'
import { createGameServer } from './app.js'
import { createLogger } from './logger.js'

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
async function shutdown(signal) {
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
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// Остання лінія оборони: залогувати і вийти (стан процесу вже невідомий — краще перезапуск).
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { reason: String(reason?.stack ?? reason) })
  process.exit(1)
})

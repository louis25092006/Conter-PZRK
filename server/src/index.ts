import { loadConfig } from './config.ts'
import { createGameServer } from './app.ts'
import { createLogger } from './logger.ts'

// Lab 6: сервер на TypeScript запускається БЕЗ збірки — Node 24 сам прибирає типи (type stripping).
// Тому в коді немає enum і інших конструкцій, що потребують компіляції (erasableSyntaxOnly).
// Lab 8: продакшен — порт з PORT, 0.0.0.0, JSON-логи, акуратне вимкнення, падіння на невідомих помилках.

const config = loadConfig() // поганий конфіг → виняток і вихід з кодом 1 ще до старту
const log = createLogger(config)
const game = createGameServer(config, { log })

const port = await game.listen()
log.info('server.listening', {
  url: `http://localhost:${port}`,
  host: config.host,
  version: config.version,
  allowedOrigins: config.allowedOrigins,
  logLevel: config.logLevel,
})

// Graceful shutdown: SIGTERM від Docker/платформи (новий деплой) або Ctrl+C (SIGINT).
// Порядок: /ready → 503 → більше не приймаємо з'єднань → гравцям «shutdown» + 1001 →
// дописуємо логи матчів → flush логів → exit 0. Усе має вкластися в 5 с (платформа чекає 10–30 с,
// потім SIGKILL — і тоді гравці просто «зникнуть» без пояснень).
let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const started = performance.now()
  log.info('server.shutdown', { signal })
  const force = setTimeout(() => {
    log.error('server.shutdown_timeout', { afterMs: 5000 })
    void log.flush().finally(() => process.exit(1))
  }, 5000)
  force.unref()
  await game.close()
  log.info('server.stopped', { tookMs: Math.round(performance.now() - started) })
  await log.flush()
  process.exit(0)
}
process.on('SIGINT', (s) => void shutdown(s))
process.on('SIGTERM', (s) => void shutdown(s))

// Керований вихід з батьківського процесу (load-test --profile) — через IPC,
// бо на Windows child.kill() обриває процес миттєво і --cpu-prof не встигає записати профіль.
if (process.send) process.on('message', (m) => m === 'shutdown' && void shutdown('IPC'))

// Остання лінія оборони: невідома помилка = стан процесу невідомий. Не ковтаємо її, а логуємо
// стек і виходимо з НЕнульовим кодом — платформа перезапустить чистий процес (Lab 8: crash on unknowns).
function crash(kind: string, error: unknown): void {
  log.error(kind, { error: error instanceof Error ? (error.stack ?? error.message) : String(error) })
  void log.flush().finally(() => process.exit(1))
}
process.on('uncaughtException', (e) => crash('process.uncaught_exception', e))
process.on('unhandledRejection', (reason: unknown) => crash('process.unhandled_rejection', reason))

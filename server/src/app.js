import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { RoomManager } from './rooms.js'
import { createHttpHandler } from './http.js'
import { attachWebSockets } from './ws.js'
import { createMatchLog } from './log/matchlog.js'
import { createLogger } from './logger.js'

// Стандартні кімнати, які є завжди (як у rooms.json з Lab 3)
const DEFAULT_ROOMS = [
  { id: 'r-classic', name: 'Classic Sky', arena: 'classic' },
  { id: 'r-training', name: 'Training Ground', arena: 'training', maxPlayers: 4 },
  { id: 'r-dogfight', name: 'Dogfight Night', arena: 'dogfight', maxPlayers: 6 },
]

// Фабрика сервера: усе створюється тут, а index.js лише запускає і ловить сигнали.
// Тести створюють сервер на порту 0 (будь-який вільний) зі своїм конфігом.
export function createGameServer(config, { log = createLogger(config) } = {}) {
  const manager = new RoomManager(config)
  const counters = {
    connections: 0,
    messages: 0,
    rejected: 0,
    dropped: 0,
    slowClosed: 0,
    terminated: 0,
  }
  const logs = new Set() // проміси "лог дописано"

  // кожна кімната отримує свій лог матчу
  manager.on('created', async (room) => {
    const matchLog = await createMatchLog(room, {
      dir: config.logDir,
      onError: (err) => log.error('match log failed', { room: room.id, error: err.message }),
    })
    logs.add(matchLog.done)
    matchLog.done.finally(() => logs.delete(matchLog.done))
  })

  const arenas = JSON.parse(readFileSync(config.arenasFile, 'utf8'))
  let sockets = null
  const httpServer = createServer(
    createHttpHandler({
      config,
      manager,
      log,
      stats: () => ({ ...counters }),
      matchStats: () => sockets.stats(),
    }),
  )
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: config.maxPayloadBytes })
  wss.on('error', (err) => log.error('websocket server error', { error: err.message }))
  sockets = attachWebSockets({ wss, manager, config, log, counters, arenas })

  function seedRooms() {
    for (const r of DEFAULT_ROOMS) manager.create({ ...r, persistent: true })
  }

  return {
    httpServer,
    wss,
    manager,
    counters,

    async listen() {
      seedRooms()
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(config.port, config.host, resolve)
      })
      return httpServer.address().port
    },

    // Акуратне вимкнення: не приймати нових → закрити сокети → закрити кімнати
    // (логи матчів дописуються і файли закриваються) → дочекатися.
    async close() {
      sockets.stop()
      const stopped = new Promise((resolve) => httpServer.close(resolve))
      // Спочатку чекаємо, поки сокети справді закриються (і гравці "вийдуть" з кімнат —
      // інакше в лог матчу не потрапить leave), але не довше 2 с.
      const clients = [...wss.clients]
      const socketsClosed = Promise.all(clients.map((c) => new Promise((r) => c.once('close', r))))
      for (const client of clients) client.close(1001, 'server shutting down')
      await Promise.race([socketsClosed, new Promise((r) => setTimeout(r, 2000).unref())])
      for (const client of wss.clients) client.terminate() // хто не встиг — примусово
      wss.close()
      manager.closeAll()
      await Promise.allSettled([...logs])
      httpServer.closeAllConnections?.()
      await stopped
    },
  }
}

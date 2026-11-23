import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { ArenasSchema, type Arenas } from '@conter/shared/arena-config.ts'
import { RoomManager, type RoomInit } from './rooms.ts'
import { createHttpHandler } from './http.ts'
import { attachWebSockets, type Counters } from './ws.ts'
import { createMatchLog } from './log/matchlog.ts'
import { createLogger, type Logger } from './logger.ts'
import type { ServerConfig } from './config.ts'

// Стандартні кімнати, які є завжди (як у rooms.json з Lab 3)
const DEFAULT_ROOMS: readonly RoomInit[] = [
  { id: 'r-classic', name: 'Classic Sky', arena: 'classic' },
  { id: 'r-training', name: 'Training Ground', arena: 'training', maxPlayers: 4 },
  { id: 'r-dogfight', name: 'Dogfight Night', arena: 'dogfight', maxPlayers: 6 },
]

// параметри арен з файлу, перевірені zod-схемою: зіпсований arenas.json = зрозуміла помилка при старті
export function loadArenas(file: string): Arenas {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const parsed = ArenasSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`Invalid ${file}: ${parsed.error.issues[0]?.message ?? 'bad arenas'}`)
  return parsed.data
}

export interface GameServer {
  readonly httpServer: Server
  readonly wss: WebSocketServer
  readonly manager: RoomManager
  readonly counters: Counters
  listen(): Promise<number>
  close(): Promise<void>
}

// Фабрика сервера: усе створюється тут, а index.ts лише запускає і ловить сигнали.
export function createGameServer(
  config: ServerConfig,
  { log = createLogger(config) }: { log?: Logger } = {},
): GameServer {
  const manager = new RoomManager(config)
  const counters: Counters = {
    connections: 0,
    messages: 0,
    rejected: 0,
    dropped: 0,
    slowClosed: 0,
    terminated: 0,
  }
  const logs = new Set<Promise<void>>() // проміси "лог дописано"

  // кожна кімната отримує свій лог матчу
  manager.on('created', (room) => {
    void createMatchLog(room, {
      dir: config.logDir,
      onError: (e) =>
        log.error('match log failed', { room: room.id, error: e instanceof Error ? e.message : String(e) }),
    }).then((matchLog) => {
      logs.add(matchLog.done)
      void matchLog.done.finally(() => logs.delete(matchLog.done))
    })
  })

  const arenas = loadArenas(config.arenasFile)
  const httpServer = createServer()
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: config.maxPayloadBytes })
  wss.on('error', (e) => log.error('websocket server error', { error: e.message }))
  const sockets = attachWebSockets({ wss, manager, config, log, counters, arenas })
  const handler = createHttpHandler({
    config,
    manager,
    log,
    stats: () => ({ ...counters }),
    matchStats: () => sockets.stats(),
    addBots: (roomId, count) => sockets.addBots(roomId, count),
  })
  httpServer.on('request', (req, res) => void handler(req, res))

  return {
    httpServer,
    wss,
    manager,
    counters,

    async listen() {
      for (const r of DEFAULT_ROOMS) manager.create({ ...r, persistent: true })
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(config.port, config.host, resolve)
      })
      const address = httpServer.address()
      // address() — string для unix-сокетів, AddressInfo для TCP; у нас завжди TCP
      if (address === null || typeof address === 'string')
        throw new Error('server is not listening on a TCP port')
      return address.port
    },

    // Акуратне вимкнення: не приймати нових → закрити сокети (гравці "виходять" з кімнат)
    // → закрити кімнати (логи дописуються) → дочекатися.
    async close() {
      sockets.stop()
      const stopped = new Promise<void>((resolve) => httpServer.close(() => resolve()))
      const clients = [...wss.clients]
      const socketsClosed = Promise.all(
        clients.map((c) => new Promise<void>((r) => c.once('close', () => r()))),
      )
      for (const client of clients) client.close(1001, 'server shutting down')
      await Promise.race([socketsClosed, new Promise<void>((r) => setTimeout(r, 2000).unref())])
      for (const client of wss.clients) client.terminate() // хто не встиг — примусово
      wss.close()
      manager.closeAll()
      await Promise.allSettled([...logs])
      httpServer.closeAllConnections()
      await stopped
    },
  }
}

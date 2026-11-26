import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { extname, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { ARENAS, RoomsLimitError, isArenaId, type RoomManager } from './rooms.ts'
import { listReplays, REPLAY_ID } from './log/replay.ts'
import type { ServerConfig } from './config.ts'
import type { Logger } from './logger.ts'
import type { PlayerInfo } from '@conter/shared/protocol.ts'
import type { Metrics } from './metrics.ts'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.ndjson': 'application/x-ndjson',
}
const JSON_TYPE = 'application/json; charset=utf-8'

class HttpError extends Error {
  override name = 'HttpError'
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

// Тіло запиту з обмеженням розміру: читаємо шматками й рахуємо байти.
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > maxBytes) throw new HttpError(413, `body larger than ${maxBytes} bytes`)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) throw new HttpError(400, 'unexpected body chunk')
    size += chunk.length
    if (size > maxBytes) throw new HttpError(413, `body larger than ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return body
  } catch {
    throw new HttpError(400, 'body is not valid JSON')
  }
}

// тіло POST /api/rooms — теж через zod-схему, а не ручні if-и
const NewRoomSchema = z.object({
  name: z.string().trim().min(1, 'name must be 1–32 characters').max(32, 'name must be 1–32 characters'),
  arena: z
    .custom<(typeof ARENAS)[number]>(isArenaId, `arena must be one of: ${ARENAS.join(', ')}`)
    .default('classic'),
  // Lab 7: для навантажувального тесту — кімната більша за звичайні 8 (стеля — MAX_PLAYERS_PER_ROOM)
  maxPlayers: z.number().int().min(1).max(512).optional(),
})

// Статика з client/dist. Захист від path traversal: після resolve шлях
// МУСИТЬ лишатися всередині кореня, інакше /../../server/.env віддав би секрети.
async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  pathname: string,
): Promise<void> {
  let rel: string
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    throw new HttpError(400, 'bad URL encoding')
  }
  if (rel.includes('\0')) throw new HttpError(400, 'bad path')
  // На Windows «\» — роздільник шляху, на Linux — звичайний символ імені файлу. Щоб сервер
  // поводився однаково на будь-якій ОС (CI на Linux це впіймав: там був 404, а не 403),
  // шляхи зі зворотним слешем не приймаємо взагалі — у URL статики їм не місце.
  if (rel.includes('\\')) throw new HttpError(403, 'forbidden')
  let file = resolve(root, '.' + rel)
  if (file !== root && !file.startsWith(root + sep)) throw new HttpError(403, 'forbidden')

  let info = await stat(file).catch(() => null)
  if (info?.isDirectory()) {
    file = join(file, 'index.html')
    info = await stat(file).catch(() => null)
  }
  if (!info?.isFile()) throw new HttpError(404, 'not found')

  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-length': info.size,
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  await pipeline(createReadStream(file), res)
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

export interface HttpDeps {
  config: ServerConfig
  manager: RoomManager
  log: Logger
  stats: () => Readonly<Record<string, number>>
  matchStats?: () => unknown
  addBots?: (roomId: string, count: number) => readonly PlayerInfo[]
  metrics?: Metrics
  ready?: () => boolean
}

const isPrematureClose = (e: unknown): boolean =>
  e instanceof Error && 'code' in e && e.code === 'ERR_STREAM_PREMATURE_CLOSE'

const BotsSchema = z.object({ count: z.number().int().min(1).max(64).default(1) })

export function createHttpHandler({
  config,
  manager,
  log,
  stats,
  matchStats = () => [],
  addBots,
  metrics,
  ready = () => true,
}: HttpDeps) {
  let lastElu = performance.eventLoopUtilization()

  // Lab 7, M4: POST /api/rooms/:id/bots  { "count": 8 } → додає ботів у кімнату
  async function postBots(req: IncomingMessage, res: ServerResponse, roomId: string): Promise<void> {
    if (!addBots) throw new HttpError(404, 'bots are not available')
    const parsed = BotsSchema.safeParse(await readJsonBody(req, config.maxBodyBytes))
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'bad count')
    if (!manager.get(roomId)) throw new HttpError(404, 'room not found')
    sendJson(res, 201, { room: roomId, added: addBots(roomId, parsed.data.count) })
  }

  const routes: Readonly<Record<string, Handler>> = {
    // liveness: процес живий і цикл подій відповідає (інакше платформа його перезапустить)
    'GET /health': (req, res) =>
      sendJson(res, 200, {
        ok: true,
        version: config.version, // Lab 8: git SHA збірки — видно, яка версія задеплоєна
        uptimeSec: Math.round(process.uptime()),
        rooms: manager.size,
        players: manager.playerCount,
        rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1),
        ...stats(),
      }),

    // readiness (Lab 8): чи можна слати сюди гравців. Під час вимкнення — 503, хоча процес ще живий
    'GET /ready': (req, res) =>
      ready()
        ? sendJson(res, 200, { ready: true, version: config.version })
        : sendJson(res, 503, { ready: false, reason: 'shutting down or not listening yet' }),

    // метрики у форматі Prometheus (Lab 8): гравці, кімнати, повідомлення/байти, p99 тіку, ELU, RSS…
    'GET /metrics': async (req, res) => {
      if (!metrics) throw new HttpError(404, 'metrics are not enabled')
      const body = await metrics.registry.metrics()
      res.writeHead(200, { 'content-type': metrics.registry.contentType })
      res.end(body)
    },

    'GET /api/rooms': (req, res) => sendJson(res, 200, { rooms: manager.list() }),

    // Lab 5: стан матчів — тривалість і джитер тіку, гравці, трафік кожного клієнта
    // Lab 7: + стан процесу — пам'ять і завантаженість циклу подій (ELU) з минулого запиту
    'GET /api/stats': (req, res) => {
      const elu = performance.eventLoopUtilization(lastElu)
      lastElu = performance.eventLoopUtilization()
      const mem = process.memoryUsage()
      sendJson(res, 200, {
        matches: matchStats(),
        process: {
          rssMB: +(mem.rss / 1048576).toFixed(1),
          heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1),
          eventLoopUtilization: +elu.utilization.toFixed(3),
        },
      })
    },

    'POST /api/rooms': async (req, res) => {
      const parsed = NewRoomSchema.safeParse(await readJsonBody(req, config.maxBodyBytes))
      if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'bad room')
      const { name, arena, maxPlayers } = parsed.data
      try {
        const room = manager.create({ name, arena, ...(maxPlayers ? { maxPlayers } : {}) })
        log.info('room.created', { roomId: room.id, name, arena, via: 'api' })
        sendJson(res, 201, room.toJSON())
      } catch (e: unknown) {
        if (e instanceof RoomsLimitError) throw new HttpError(409, e.message)
        throw e
      }
    },

    'GET /api/replays': async (req, res) => sendJson(res, 200, { replays: await listReplays(config.logDir) }),
  }

  // /api/replays/:id — СТРІМИМО файл: pipeline(readStream, res), з backpressure.
  async function streamReplay(res: ServerResponse, id: string): Promise<void> {
    if (!REPLAY_ID.test(id)) throw new HttpError(400, 'bad replay id')
    const file = join(config.logDir, id)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) throw new HttpError(404, 'replay not found')
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'content-length': info.size })
    await pipeline(createReadStream(file), res)
  }

  // ПОГАНИЙ варіант (лише для досліду Lab 4 M3): весь файл у пам'ять, потім віддаємо.
  async function bufferedReplay(res: ServerResponse, id: string): Promise<void> {
    if (!REPLAY_ID.test(id)) throw new HttpError(400, 'bad replay id')
    const data = await readFile(join(config.logDir, id)).catch(() => {
      throw new HttpError(404, 'replay not found')
    })
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'content-length': data.length })
    res.end(data)
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const key = `${req.method ?? 'GET'} ${url.pathname}`
    try {
      const route = routes[key]
      if (route) return await route(req, res)

      const botsRoom = /^\/api\/rooms\/([^/]+)\/bots$/.exec(url.pathname)?.[1]
      if (botsRoom && req.method === 'POST') return await postBots(req, res, botsRoom)

      const replayId = /^\/api\/replays\/([^/]+)$/.exec(url.pathname)?.[1]
      if (replayId && req.method === 'GET') return await streamReplay(res, replayId)

      if (config.demoEndpoints) {
        // блокуємо цикл подій синхронним циклом — для досліду Lab 4 M4
        if (key === 'GET /api/slow') {
          const ms = Number(url.searchParams.get('ms') ?? 300)
          const until = performance.now() + ms
          while (performance.now() < until) {
            // нічого не робимо — просто займаємо потік
          }
          return sendJson(res, 200, { blockedMs: ms })
        }
        const bufferedId = /^\/api\/demo\/replay-buffered\/([^/]+)$/.exec(url.pathname)?.[1]
        if (bufferedId) return await bufferedReplay(res, bufferedId)
      }

      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'no such endpoint')
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed')
      await serveStatic(req, res, config.clientDist, url.pathname)
    } catch (e: unknown) {
      if (isPrematureClose(e)) return // клієнт сам обірвав завантаження
      const status = e instanceof HttpError ? e.status : 500
      if (status >= 500) log.error('http.failed', { key, error: e instanceof Error ? e.message : String(e) })
      const message = e instanceof HttpError ? e.message : 'internal error'
      if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? 'internal error' : message })
      else res.destroy()
    }
  }
}

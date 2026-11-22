import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { extname, join, resolve, sep } from 'node:path'
import { ARENAS } from './rooms.js'
import { listReplays, REPLAY_ID } from './log/replay.js'

const MIME = {
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

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': MIME['.json'], 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

// Тіло запиту з обмеженням розміру: читаємо шматками й рахуємо байти.
// Без ліміту можна надіслати 2 ГБ і покласти сервер по пам'яті.
async function readJsonBody(req, maxBytes) {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > maxBytes) throw new HttpError(413, `body larger than ${maxBytes} bytes`)
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new HttpError(413, `body larger than ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'body is not valid JSON')
  }
}

function validateNewRoom(body) {
  if (body === null || typeof body !== 'object') throw new HttpError(400, 'expected a JSON object')
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name.length < 1 || name.length > 32) throw new HttpError(400, 'name must be 1–32 characters')
  const arena = body.arena ?? 'classic'
  if (!ARENAS.includes(arena)) throw new HttpError(400, `arena must be one of: ${ARENAS.join(', ')}`)
  return { name, arena }
}

// Статика з client/dist. Захист від path traversal: після resolve шлях
// МУСИТЬ лишатися всередині кореня, інакше /../../server/.env віддав би секрети.
async function serveStatic(req, res, root, pathname) {
  let rel
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    throw new HttpError(400, 'bad URL encoding')
  }
  if (rel.includes('\0')) throw new HttpError(400, 'bad path')
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
  if (req.method === 'HEAD') return res.end()
  await pipeline(createReadStream(file), res)
}

export function createHttpHandler({ config, manager, log, stats, matchStats = () => [] }) {
  const routes = {
    'GET /health': (req, res) =>
      sendJson(res, 200, {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        rooms: manager.size,
        players: manager.playerCount,
        rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1),
        ...stats(),
      }),

    'GET /api/rooms': (req, res) => sendJson(res, 200, { rooms: manager.list() }),

    // Lab 5: стан матчів — тривалість і джитер тіку, гравці, трафік кожного клієнта
    'GET /api/stats': (req, res) => sendJson(res, 200, { matches: matchStats() }),

    'POST /api/rooms': async (req, res) => {
      const { name, arena } = validateNewRoom(await readJsonBody(req, config.maxBodyBytes))
      try {
        const room = manager.create({ name, arena })
        log.info('room created via API', { id: room.id, name, arena })
        sendJson(res, 201, room.toJSON())
      } catch (err) {
        if (err.code === 'ROOMS_LIMIT') throw new HttpError(409, err.message)
        throw err
      }
    },

    'GET /api/replays': async (req, res) => sendJson(res, 200, { replays: await listReplays(config.logDir) }),
  }

  // /api/replays/:id — СТРІМИМО файл: pipeline(readStream, res).
  // Якщо клієнт читає повільно, res.write() повертає false, pipeline ставить
  // читання файлу на паузу (backpressure), і пам'ять не росте.
  async function streamReplay(req, res, id) {
    if (!REPLAY_ID.test(id)) throw new HttpError(400, 'bad replay id')
    const file = join(config.logDir, id)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) throw new HttpError(404, 'replay not found')
    res.writeHead(200, { 'content-type': MIME['.ndjson'], 'content-length': info.size })
    await pipeline(createReadStream(file), res)
  }

  // ПОГАНИЙ варіант (лише для досліду M3): весь файл у пам'ять, потім віддаємо.
  async function bufferedReplay(req, res, id) {
    if (!REPLAY_ID.test(id)) throw new HttpError(400, 'bad replay id')
    const data = await readFile(join(config.logDir, id)).catch(() => {
      throw new HttpError(404, 'replay not found')
    })
    res.writeHead(200, { 'content-type': MIME['.ndjson'], 'content-length': data.length })
    res.end(data)
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const key = `${req.method} ${url.pathname}`
    try {
      if (routes[key]) return await routes[key](req, res)

      const replay = url.pathname.match(/^\/api\/replays\/([^/]+)$/)
      if (replay && req.method === 'GET') return await streamReplay(req, res, replay[1])

      if (config.demoEndpoints) {
        // блокуємо цикл подій на 300 мс синхронним циклом — для досліду M4
        if (key === 'GET /api/slow') {
          const until = performance.now() + Number(url.searchParams.get('ms') ?? 300)
          while (performance.now() < until) {
            // нічого не робимо — просто займаємо потік
          }
          return sendJson(res, 200, { blockedMs: Number(url.searchParams.get('ms') ?? 300) })
        }
        const buffered = url.pathname.match(/^\/api\/demo\/replay-buffered\/([^/]+)$/)
        if (buffered) return await bufferedReplay(req, res, buffered[1])
      }

      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'no such endpoint')
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed')
      await serveStatic(req, res, config.clientDist, url.pathname)
    } catch (err) {
      if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') return // клієнт сам обірвав завантаження
      const status = err.status ?? 500
      if (status >= 500) log.error('http handler failed', { key, error: err.message })
      if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? 'internal error' : err.message })
      else res.destroy()
    }
  }
}

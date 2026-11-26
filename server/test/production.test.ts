// Lab 8: продакшен-поведінка сервера — health/ready/metrics, Origin, ліміт на IP, shutdown.
import { test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { loadConfig } from '../src/config.ts'
import { createGameServer, type GameServer } from '../src/app.ts'
import { createLogger } from '../src/logger.ts'
import { connect } from './helpers.ts'

let game: GameServer
let base = ''
let wsUrl = ''
let tmp = ''

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conter-prod-'))
  const config = loadConfig(
    { GIT_SHA: 'abc1234', ALLOWED_ORIGINS: 'https://conter.example,http://localhost:5173' },
    { port: 0, host: '127.0.0.1', logDir: tmp, clientDist: tmp, quiet: true, maxConnectionsPerIp: 3 },
  )
  game = createGameServer(config, { log: createLogger({ quiet: true }) })
  const port = await game.listen()
  base = `http://127.0.0.1:${port}`
  wsUrl = `ws://127.0.0.1:${port}/ws`
})
afterAll(async () => {
  await game.close()
  await rm(tmp, { recursive: true, force: true })
})

// результат WebSocket-рукостискання: 'open' або HTTP-статус відмови
function handshake(
  headers: Record<string, string> = {},
): Promise<{ result: 'open' | number; ws: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers })
    ws.once('open', () => resolve({ result: 'open', ws }))
    ws.once('unexpected-response', (_req, res) => resolve({ result: res.statusCode ?? 0, ws }))
    ws.once('error', () => {}) // після unexpected-response бібліотека ще кидає error — він очікуваний
  })
}

test('/health показує версію збірки, /ready — 200, поки сервер приймає гравців', async () => {
  const health: unknown = await (await fetch(`${base}/health`)).json()
  expect(health).toMatchObject({ ok: true, version: 'abc1234' })
  const ready = await fetch(`${base}/ready`)
  expect(ready.status).toBe(200)
  expect(game.ready).toBe(true)
})

test('Origin: чужий сайт → 403 ще на рукостисканні; свій і «без Origin» (не браузер) → пускаємо', async () => {
  const evil = await handshake({ origin: 'https://evil.example' })
  expect(evil.result).toBe(403)
  const ours = await handshake({ origin: 'https://conter.example' })
  expect(ours.result).toBe('open')
  ours.ws.close()
  const noOrigin = await handshake()
  expect(noOrigin.result).toBe('open')
  noOrigin.ws.close()
})

test('ліміт з’єднань з однієї IP (тут 3): четверте → 429, після закриття одного — знову можна', async () => {
  await new Promise((r) => setTimeout(r, 50)) // попередні сокети встигають закритися
  const open = await Promise.all([handshake(), handshake(), handshake()])
  expect(open.map((o) => o.result)).toEqual(['open', 'open', 'open'])
  const fourth = await handshake()
  expect(fourth.result).toBe(429)
  const first = open[0]
  if (!first) throw new Error('no socket')
  await new Promise<void>((r) => {
    first.ws.once('close', () => r())
    first.ws.close()
  })
  await new Promise((r) => setTimeout(r, 20))
  const again = await handshake()
  expect(again.result).toBe('open')
  for (const o of [...open.slice(1), again]) o.ws.close()
})

test('/metrics: формат Prometheus з гравцями, кімнатами, повідомленнями, p99 тіку, ELU, RSS і відмовами', async () => {
  await new Promise((r) => setTimeout(r, 50))
  const c = connect(wsUrl)
  await c.open()
  c.send({ type: 'join', v: 1, roomId: 'r-classic', name: 'Metrics' })
  await c.next('welcome')
  await c.until(() => c.snaps.length >= 5)
  const text = await (await fetch(`${base}/metrics`)).text()
  // рядки виду: conter_players{service="conter-server"} 1
  const value = (name: string, labels = ''): number | null => {
    const line = text.split('\n').find((l) => l.startsWith(name + '{') && l.includes(labels))
    return line ? Number(line.split(' ').at(-1)) : null
  }
  expect(value('conter_players')).toBe(1)
  expect(value('conter_rooms')).toBe(3)
  expect(value('conter_matches_running')).toBe(1)
  expect(value('conter_messages_in_total')).toBeGreaterThan(0)
  expect(value('conter_messages_out_total')).toBeGreaterThan(4)
  expect(value('conter_bytes_out_total')).toBeGreaterThan(100)
  expect(value('conter_tick_duration_p99_ms')).toBeGreaterThanOrEqual(0)
  expect(value('conter_event_loop_utilization')).toBeGreaterThanOrEqual(0)
  expect(value('process_resident_memory_bytes')).toBeGreaterThan(10_000_000)
  expect(value('conter_ws_rejections_total', 'reason="origin"')).toBe(1)
  expect(value('conter_ws_rejections_total', 'reason="ip_limit"')).toBe(1)
  c.ws.close()
})

test('shutdown: гравець отримує {type:"shutdown"} і потім 1001; /ready → 503', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conter-sd-'))
  const g = createGameServer(
    loadConfig({}, { port: 0, host: '127.0.0.1', logDir: dir, clientDist: dir, quiet: true }),
    {
      log: createLogger({ quiet: true }),
    },
  )
  const port = await g.listen()
  const c = connect(`ws://127.0.0.1:${port}/ws`)
  await c.open()
  c.send({ type: 'join', v: 1, roomId: 'r-training', name: 'Bye' })
  await c.next('welcome')
  const started = performance.now()
  const closing = g.close()
  expect(g.ready).toBe(false)
  const notice = await c.next('shutdown')
  expect(notice.retryAfterMs).toBeGreaterThan(0)
  expect(await c.closed).toBe(1001)
  await closing
  expect(performance.now() - started).toBeLessThan(5000) // вкладаємося в 5 с (платформа чекає 10)
  await rm(dir, { recursive: true, force: true })
})

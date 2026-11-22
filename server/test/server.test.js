// Інтеграційні тести: справжній сервер на випадковому порту, справжні HTTP і WebSocket.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { get } from 'node:http'
import { WebSocket } from 'ws'
import { loadConfig } from '../src/config.js'
import { createGameServer } from '../src/app.js'
import { createLogger } from '../src/logger.js'
import { CLOSE } from '../src/protocol.js'

let game, base, wsUrl, tmp

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conter-srv-'))
  const dist = join(tmp, 'dist')
  await mkdir(dist)
  await writeFile(join(dist, 'index.html'), '<h1>game</h1>')
  await writeFile(join(tmp, 'secret.txt'), 'top secret')
  const config = loadConfig(
    {},
    {
      port: 0,
      host: '127.0.0.1',
      logDir: join(tmp, 'logs'),
      clientDist: dist,
      joinTimeoutMs: 300,
      heartbeatMs: 10000,
      rateLimitPerSec: 5,
      rateLimitBurst: 5,
      maxRooms: 5,
      quiet: true,
    },
  )
  game = createGameServer(config, { log: createLogger({ quiet: true }) })
  const port = await game.listen()
  base = `http://127.0.0.1:${port}`
  wsUrl = `ws://127.0.0.1:${port}/ws`
})

after(async () => {
  await game.close()
  await rm(tmp, { recursive: true, force: true })
})

// ---------- HTTP ----------

test('GET /health', async () => {
  const res = await fetch(`${base}/health`)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.rooms, 3) // стандартні кімнати
})

test('GET /api/rooms і POST /api/rooms', async () => {
  const created = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ira room', arena: 'dogfight' }),
  })
  assert.equal(created.status, 201)
  const room = await created.json()
  assert.equal(room.arena, 'dogfight')
  const { rooms } = await (await fetch(`${base}/api/rooms`)).json()
  assert.ok(rooms.some((r) => r.id === room.id))
})

test('POST /api/rooms: погані дані → 400, завелике тіло → 413', async () => {
  const post = (body) => fetch(`${base}/api/rooms`, { method: 'POST', body })
  assert.equal((await post('{oops')).status, 400)
  assert.equal((await post(JSON.stringify({ name: '' }))).status, 400)
  assert.equal((await post(JSON.stringify({ name: 'x', arena: 'mars' }))).status, 400)
  assert.equal((await post(JSON.stringify({ name: 'x'.repeat(10000) }))).status, 413)
})

// "сирий" GET: fetch за стандартом URL сам прибирає "../" і навіть "%2e%2e",
// тому атака до сервера б не дійшла. Справжній зловмисник шле шлях як є.
function rawGet(path) {
  return new Promise((resolve, reject) => {
    get(`${base}${path}`, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
      .on('error', reject)
      .end()
  })
}

test('статика: index.html є, а вийти за межі dist не можна', async () => {
  assert.equal(await (await fetch(`${base}/`)).text(), '<h1>game</h1>')
  assert.equal(await rawGet('/..%2Fsecret.txt'), 403)
  assert.equal(await rawGet('/%2e%2e%2Fsecret.txt'), 403)
  assert.equal(await rawGet('/..%5Csecret.txt'), 403) // зворотний слеш — актуально для Windows
  assert.equal((await fetch(`${base}/nope.js`)).status, 404)
})

// ---------- WebSocket ----------

// маленький помічник: відкрити сокет і збирати повідомлення
function client() {
  const ws = new WebSocket(wsUrl)
  const inbox = []
  const waiters = []
  ws.on('message', (data, isBinary) => {
    if (isBinary) return // бінарні знімки світу (Lab 5) тут не потрібні
    const m = JSON.parse(data)
    inbox.push(m)
    for (const w of waiters.splice(0)) w()
  })
  ws.on('error', () => {})
  const closed = new Promise((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })),
  )
  return {
    ws,
    inbox,
    closed,
    open: () => new Promise((resolve) => ws.once('open', resolve)),
    send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    async next(type) {
      for (;;) {
        const i = inbox.findIndex((m) => m.type === type)
        if (i >= 0) return inbox.splice(i, 1)[0]
        await new Promise((resolve) => waiters.push(resolve))
      }
    },
  }
}

test('два гравці в одній кімнаті бачать одне одного і чат', async () => {
  const a = client()
  const b = client()
  await Promise.all([a.open(), b.open()])
  a.send({ type: 'join', v: 1, roomId: 'r-classic', name: 'Ira' })
  assert.equal((await a.next('welcome')).you.name, 'Ira')
  b.send({ type: 'join', v: 1, roomId: 'r-classic', name: 'Bob' })
  await b.next('welcome')

  // у обох з'явився склад з двох гравців
  const names = async (c) => {
    for (;;) {
      const r = await c.next('roster')
      if (r.players.length === 2) return r.players.map((p) => p.name).sort()
    }
  }
  assert.deepEqual(await names(a), ['Bob', 'Ira'])
  assert.deepEqual(await names(b), ['Bob', 'Ira'])

  b.send({ type: 'chat', text: 'привіт, Іро!' })
  const msg = await a.next('chat')
  assert.equal(msg.from.name, 'Bob')
  assert.equal(msg.text, 'привіт, Іро!')

  b.ws.close()
  const after = await a.next('roster')
  assert.deepEqual(
    after.players.map((p) => p.name),
    ['Ira'],
  )
  a.ws.close()
})

test('не надіслав join вчасно → закриття з кодом 4003', async () => {
  const c = client()
  await c.open()
  assert.equal((await c.closed).code, CLOSE.JOIN_TIMEOUT)
})

test('не JSON → 4000, невідомий тип → 4001, чат до join → 4009', async () => {
  for (const [payload, code] of [
    ['hello?', CLOSE.BAD_JSON],
    [{ type: 'teleport' }, CLOSE.UNKNOWN_TYPE],
    [{ type: 'chat', text: 'hi' }, CLOSE.NOT_JOINED],
  ]) {
    const c = client()
    await c.open()
    c.send(payload)
    assert.equal((await c.closed).code, code)
  }
})

test('неіснуюча кімната → 4006', async () => {
  const c = client()
  await c.open()
  c.send({ type: 'join', v: 1, roomId: 'nope', name: 'x' })
  assert.equal((await c.closed).code, CLOSE.ROOM_UNAVAILABLE)
})

test('спам повідомленнями → rate limit 4005', async () => {
  const c = client()
  await c.open()
  c.send({ type: 'join', v: 1, roomId: 'r-training', name: 'spam' })
  await c.next('welcome')
  for (let i = 0; i < 20; i++) c.send({ type: 'chat', text: `spam ${i}` })
  assert.equal((await c.closed).code, CLOSE.RATE_LIMIT)
})

test('повідомлення більше maxPayload → 1009', async () => {
  const c = client()
  await c.open()
  c.send('x'.repeat(10000))
  assert.equal((await c.closed).code, 1009)
})

test('graceful shutdown: клієнти отримують 1001, лог матчу дописаний на диск', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conter-shutdown-'))
  const config = loadConfig({}, { port: 0, host: '127.0.0.1', logDir: dir, clientDist: dir, quiet: true })
  const g = createGameServer(config, { log: createLogger({ quiet: true }) })
  const port = await g.listen()
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  ws.on('error', () => {})
  await new Promise((r) => ws.once('open', r))
  ws.send(JSON.stringify({ type: 'join', v: 1, roomId: 'r-dogfight', name: 'Last' }))
  await new Promise((r) => ws.once('message', r))
  const closed = new Promise((r) => ws.on('close', (code) => r(code)))

  await g.close()
  assert.equal(await closed, 1001)
  const { readdir, readFile } = await import('node:fs/promises')
  const files = await readdir(dir)
  assert.equal(files.length, 1) // лише кімната, де щось сталося
  const types = (await readFile(join(dir, files[0]), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).type)
  assert.deepEqual(types, ['join', 'leave', 'close'])
  await rm(dir, { recursive: true, force: true })
})

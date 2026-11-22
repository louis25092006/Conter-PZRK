// Lab 5: авторитетний сервер, команди, знімки, кодеки, точний таймер.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { loadConfig } from '../src/config.js'
import { createGameServer } from '../src/app.js'
import { createLogger } from '../src/logger.js'
import { CLOSE } from '../src/protocol.js'
import { Match } from '../src/match.js'
import { createLink } from '../src/netsim.js'
import { binaryCodec, jsonCodec } from '@conter/shared/codec/index.js'

let game, port, tmp

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conter-match-'))
  const config = loadConfig({}, { port: 0, host: '127.0.0.1', logDir: tmp, clientDist: tmp, quiet: true })
  game = createGameServer(config, { log: createLogger({ quiet: true }) })
  port = await game.listen()
})

after(async () => {
  await game.close()
  await rm(tmp, { recursive: true, force: true })
})

// гравець: підключається з потрібним кодеком, збирає знімки
function player(query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`)
  const snaps = []
  const json = []
  const waiters = []
  ws.on('message', (data, isBinary) => {
    if (isBinary) snaps.push(binaryCodec.decodeSnapshot(data))
    else {
      const m = JSON.parse(data)
      if (m.type === 'snapshot') snaps.push(m)
      else json.push(m)
    }
    for (const w of waiters.splice(0)) w()
  })
  ws.on('error', () => {})
  const closed = new Promise((r) => ws.on('close', (code) => r(code)))
  const until = async (pred) => {
    for (;;) {
      if (pred()) return
      await new Promise((r) => waiters.push(r))
    }
  }
  return { ws, snaps, json, closed, until, open: () => new Promise((r) => ws.once('open', r)) }
}

const join_ = (p, roomId, name) => p.ws.send(JSON.stringify({ type: 'join', v: 1, roomId, name }))
const myShip = (snap) => snap.entities.find((e) => e.id === snap.you)

test('бінарні команди рухають корабель, ack росте, знімки ~30/с', async () => {
  const p = player()
  await p.open()
  join_(p, 'r-dogfight', 'Pilot')
  await p.until(() => p.snaps.length >= 2)
  const start = myShip(p.snaps.at(-1))
  assert.ok(start, 'у знімку є мій літак')

  // 60 команд "газ вперед" (1 секунда гри)
  // шлемо в реальному темпі 60/с — як клієнт (разом 60 штук сервер не прийняв би: черга ≤ 30)
  for (let seq = 1; seq <= 60; seq++) {
    p.ws.send(binaryCodec.encodeInput({ seq, turn: 0, thrust: true, fire: false }))
    await new Promise((r) => setTimeout(r, 1000 / 60))
  }
  const t0 = performance.now()
  const firstCount = p.snaps.length
  await p.until(() => p.snaps.at(-1).ack === 60)
  const last = p.snaps.at(-1)
  const moved = Math.hypot(myShip(last).x - start.x, myShip(last).y - start.y)
  assert.ok(moved > 50, `корабель пролетів ${moved.toFixed(0)} px`)

  // частота знімків
  await new Promise((r) => setTimeout(r, 1000))
  const rate = ((p.snaps.length - firstCount) * 1000) / (performance.now() - t0)
  assert.ok(rate > 25 && rate < 35, `знімків на секунду: ${rate.toFixed(1)}`)
  p.ws.close()
})

test('JSON-кодек (?codec=json) теж працює', async () => {
  const p = player('?codec=json')
  await p.open()
  join_(p, 'r-training', 'Json')
  p.ws.send(JSON.stringify({ type: 'input', seq: 1, turn: 1, thrust: false, fire: false }))
  await p.until(() => p.snaps.some((s) => s.ack === 1))
  assert.equal(typeof p.snaps[0].tick, 'number')
  p.ws.close()
})

test('чит у команді (turn: 5) → 4002', async () => {
  const p = player('?codec=json')
  await p.open()
  join_(p, 'r-training', 'Cheater')
  await p.until(() => p.json.some((m) => m.type === 'welcome'))
  p.ws.send(JSON.stringify({ type: 'input', seq: 1, turn: 5, thrust: true, fire: false }))
  assert.equal(await p.closed, CLOSE.BAD_SHAPE)
})

test('бінарне сміття замість команди → 4002', async () => {
  const p = player()
  await p.open()
  join_(p, 'r-training', 'Garbage')
  await p.until(() => p.json.some((m) => m.type === 'welcome'))
  p.ws.send(new Uint8Array([9, 9, 9]))
  assert.equal(await p.closed, CLOSE.BAD_SHAPE)
})

test('ping → pong з тим самим часом; /api/stats показує матч', async () => {
  const p = player()
  await p.open()
  join_(p, 'r-classic', 'Stats')
  p.ws.send(JSON.stringify({ type: 'ping', t: 12345 }))
  await p.until(() => p.json.some((m) => m.type === 'pong'))
  assert.equal(p.json.find((m) => m.type === 'pong').t, 12345)
  const stats = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json()
  const m = stats.matches.find((x) => x.room === 'r-classic')
  assert.equal(m.tickRate, 30)
  assert.equal(m.players, 1)
  p.ws.close()
})

test('двоє гравців бачать літаки одне одного', async () => {
  const a = player()
  const b = player()
  await Promise.all([a.open(), b.open()])
  join_(a, 'r-classic', 'A')
  join_(b, 'r-classic', 'B')
  await a.until(
    () =>
      a.snaps.length > 0 &&
      a.snaps.at(-1).entities.filter((e) => e.kind === 'ship' && e.team === 'player').length === 2,
  )
  const ships = a.snaps.at(-1).entities.filter((e) => e.kind === 'ship' && e.team === 'player')
  assert.equal(ships.length, 2)
  a.ws.close()
  b.ws.close()
})

// ---------- модулі окремо ----------

test('Match: точний таймер тримає 30 тіків/с', async () => {
  const match = new Match({
    arena: {
      name: 't',
      startAsteroids: 0,
      asteroidEvery: 99,
      asteroidsBase: 0,
      asteroidsCap: 0,
      homingChance: 0,
      enemyEvery: 99,
      enemiesBase: 0,
      enemiesCap: 0,
      pickupEvery: 99,
    },
  })
  let ticks = 0
  match.onSnapshot = () => ticks++
  match.start()
  await new Promise((r) => setTimeout(r, 1000))
  match.stop()
  assert.ok(ticks >= 28 && ticks <= 31, `ticks: ${ticks}`)
})

test('Match: старі/дубльовані seq і переповнення черги відкидаються', () => {
  const match = new Match({
    arena: {
      name: 't',
      startAsteroids: 0,
      asteroidEvery: 99,
      asteroidsBase: 0,
      asteroidsCap: 0,
      homingChance: 0,
      enemyEvery: 99,
      enemiesBase: 0,
      enemiesCap: 0,
      pickupEvery: 99,
    },
  })
  match.addPlayer('p')
  const cmd = (seq) => ({ seq, turn: 0, thrust: false, fire: false })
  assert.equal(match.pushInput('p', cmd(5)), true)
  assert.equal(match.pushInput('p', cmd(5)), false) // дубль
  assert.equal(match.pushInput('p', cmd(3)), false) // застаріла
  for (let s = 6; s < 100; s++) match.pushInput('p', cmd(s))
  assert.ok(match.stats.droppedInputs > 0) // черга не безмежна
  match.step()
  assert.equal(match.ackFor('p'), 6) // за тік — 2 кроки = 2 команди (5 і 6)
})

test('netsim: затримка зберігає порядок, drop губить лише знімки', async () => {
  const link = createLink({ lag: 40, jitter: 30, drop: 0.5 }, mulberry(1))
  const got = []
  for (let i = 0; i < 20; i++) link.out(() => got.push(i))
  let snaps = 0
  for (let i = 0; i < 100; i++) link.out(() => snaps++, { droppable: true })
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(got, [...Array(20).keys()]) // жодного переставлення
  assert.ok(snaps > 25 && snaps < 75, `доставлено знімків: ${snaps}`)
})

function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('JSON і бінарний кодек декодують у ту саму структуру', () => {
  const snap = {
    type: 'snapshot',
    tick: 1,
    ack: 2,
    you: 3,
    entities: [],
    events: [{ type: 'score', x: 1, y: 2, shipId: 3, delta: 50 }],
  }
  assert.deepEqual(jsonCodec.decodeSnapshot(jsonCodec.encodeSnapshot(snap)), snap)
  assert.deepEqual(binaryCodec.decodeSnapshot(binaryCodec.encodeSnapshot(snap)), snap)
})

const QUIET_ARENA = {
  name: 't',
  startAsteroids: 0,
  asteroidEvery: 99,
  asteroidsBase: 0,
  asteroidsCap: 0,
  homingChance: 0,
  enemyEvery: 99,
  enemiesBase: 0,
  enemiesCap: 0,
  pickupEvery: 99,
}
const cmdN = (seq) => ({ seq, turn: 0, thrust: true, fire: false })

test('Match: після затримки в мережі сервер наздоганяє, черга не росте', () => {
  const match = new Match({ arena: QUIET_ARENA })
  match.addPlayer('p')
  for (let t = 0; t < 3; t++) match.step() // 6 кроків без команд (затримка) → кредит 6
  for (let s = 1; s <= 14; s++) match.pushInput('p', cmdN(s)) // команди прийшли пачкою
  match.step()
  // кредит 6 → за один тік (2 кроки) застосовано 2 + 6 = 8 команд, а не 2
  assert.equal(match.appliedFor('p'), 8)
  assert.equal(match.stats.catchUpSteps, 6)
  match.step()
  assert.equal(match.appliedFor('p'), 10) // кредит вичерпано — далі звичайний темп, 1 команда на крок
})

test('Match: частіші команди (90/с замість 60/с) не прискорюють літак', () => {
  const match = new Match({ arena: QUIET_ARENA })
  match.addPlayer('p')
  let seq = 0
  // 10 секунд гри: 300 тіків = 600 кроків; клієнт-чітер шле по 3 команди на тік (90/с)
  for (let t = 0; t < 300; t++) {
    for (let i = 0; i < 3; i++) match.pushInput('p', cmdN(++seq))
    match.step()
  }
  const applied = match.appliedFor('p')
  assert.ok(applied <= 600 + 10, `застосовано ${applied} команд за 600 кроків`)
  assert.ok(match.stats.droppedInputs > 0) // зайві відкинуто
})

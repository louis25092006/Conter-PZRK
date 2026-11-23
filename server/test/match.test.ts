// Lab 5: авторитетний сервер, команди, знімки, кодеки, точний таймер.
import { test, beforeAll as before, afterAll as after } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { createGameServer, type GameServer } from '../src/app.ts'
import { createLogger } from '../src/logger.ts'
import { Match } from '../src/match.ts'
import { createLink } from '../src/netsim.ts'
import { CLOSE, type InputMsg, type Snapshot } from '@conter/shared/protocol.ts'
import { binaryCodec, jsonCodec } from '@conter/shared/codec/index.ts'
import { toEntityId, toSeq, toTick } from '@conter/shared/types.ts'
import type { ArenaConfig } from '@conter/shared/arena-config.ts'
import { connect, sleep, type TestClient } from './helpers.ts'

let game: GameServer
let port = 0
let tmp = ''

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

const player = (query = ''): TestClient => connect(`ws://127.0.0.1:${port}/ws${query}`)
const join_ = (p: TestClient, roomId: string, name: string): void =>
  p.send({ type: 'join', v: 1, roomId, name })
const myShip = (snap: Snapshot | undefined) => snap?.entities.find((e) => e.id === snap.you)
const input = (seq: number, turn: -1 | 0 | 1, thrust: boolean, fire = false): InputMsg => ({
  type: 'input',
  seq: toSeq(seq),
  turn,
  thrust,
  fire,
})

test('бінарні команди рухають корабель, ack росте, знімки ~30/с', async () => {
  const p = player()
  await p.open()
  join_(p, 'r-dogfight', 'Pilot')
  await p.until(() => p.snaps.length >= 2)
  const start = myShip(p.snaps.at(-1))
  assert.ok(start, 'у знімку є мій літак')

  // шлемо в реальному темпі 60/с — як клієнт (разом 60 штук сервер не прийняв би: черга ≤ 30)
  for (let seq = 1; seq <= 60; seq++) {
    p.send(binaryCodec.encodeInput(input(seq, 0, true)))
    await sleep(1000 / 60)
  }
  const t0 = performance.now()
  const firstCount = p.snaps.length
  await p.until(() => p.snaps.at(-1)?.ack === 60)
  const last = myShip(p.snaps.at(-1))
  assert.ok(last)
  const moved = Math.hypot(last.x - start.x, last.y - start.y)
  assert.ok(moved > 50, `корабель пролетів ${moved.toFixed(0)} px`)

  await sleep(1000)
  const rate = ((p.snaps.length - firstCount) * 1000) / (performance.now() - t0)
  assert.ok(rate > 25 && rate < 35, `знімків на секунду: ${rate.toFixed(1)}`)
  p.ws.close()
})

test('JSON-кодек (?codec=json) теж працює', async () => {
  const p = player('?codec=json')
  await p.open()
  join_(p, 'r-training', 'Json')
  p.send(jsonCodec.encodeInput(input(1, 1, false)))
  await p.until(() => p.snaps.some((s) => s.ack === 1))
  p.ws.close()
})

test('чит у команді (turn: 5) → 4002', async () => {
  const p = player('?codec=json')
  await p.open()
  join_(p, 'r-training', 'Cheater')
  await p.next('welcome')
  p.send({ type: 'input', seq: 1, turn: 5, thrust: true, fire: false })
  assert.equal(await p.closed, CLOSE.BAD_SHAPE)
})

test('бінарне сміття замість команди → 4002', async () => {
  const p = player()
  await p.open()
  join_(p, 'r-training', 'Garbage')
  await p.next('welcome')
  p.send(new Uint8Array([9, 9, 9]))
  assert.equal(await p.closed, CLOSE.BAD_SHAPE)
})

test('ping → pong з тим самим часом; /api/stats показує матч', async () => {
  const p = player()
  await p.open()
  join_(p, 'r-classic', 'Stats')
  await p.next('welcome')
  p.send({ type: 'ping', t: 12345 })
  assert.equal((await p.next('pong')).t, 12345)
  const stats: unknown = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json()
  assert.ok(typeof stats === 'object' && stats !== null && 'matches' in stats && Array.isArray(stats.matches))
  assert.ok(
    stats.matches.some(
      (m: unknown) => typeof m === 'object' && m !== null && 'room' in m && m.room === 'r-classic',
    ),
  )
  p.ws.close()
})

test('двоє гравців бачать літаки одне одного', async () => {
  const a = player()
  const b = player()
  await Promise.all([a.open(), b.open()])
  join_(a, 'r-classic', 'A')
  join_(b, 'r-classic', 'B')
  const players = (): number =>
    a.snaps.at(-1)?.entities.filter((e) => e.kind === 'ship' && e.team === 'player').length ?? 0
  await a.until(() => players() >= 2)
  assert.ok(players() >= 2)
  a.ws.close()
  b.ws.close()
})

// ---------- модулі окремо ----------

const QUIET_ARENA: ArenaConfig = {
  name: 't',
  seed: 1,
  sky: '#000',
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

test('Match: точний таймер тримає 30 тіків/с', async () => {
  const match = new Match({ arena: QUIET_ARENA })
  let ticks = 0
  match.onSnapshot = () => ticks++
  match.start()
  await sleep(1000)
  match.stop()
  assert.ok(ticks >= 28 && ticks <= 31, `ticks: ${ticks}`)
})

test('Match: старі/дубльовані seq і переповнення черги відкидаються', () => {
  const match = new Match({ arena: QUIET_ARENA })
  match.addPlayer('p')
  assert.equal(match.pushInput('p', input(5, 0, false)), true)
  assert.equal(match.pushInput('p', input(5, 0, false)), false) // дубль
  assert.equal(match.pushInput('p', input(3, 0, false)), false) // застаріла
  for (let s = 6; s < 100; s++) match.pushInput('p', input(s, 0, false))
  assert.ok(match.stats.droppedInputs > 0) // черга не безмежна
  match.step()
  assert.equal(match.ackFor('p'), 6) // за тік — 2 кроки = 2 команди (5 і 6)
})

test('Match: після затримки в мережі сервер наздоганяє, черга не росте', () => {
  const match = new Match({ arena: QUIET_ARENA })
  match.addPlayer('p')
  for (let t = 0; t < 3; t++) match.step() // 6 кроків без команд (затримка) → кредит 6
  for (let s = 1; s <= 14; s++) match.pushInput('p', input(s, 0, true)) // команди прийшли пачкою
  match.step()
  assert.equal(match.appliedFor('p'), 8) // 2 + 6 за кредит
  assert.equal(match.stats.catchUpSteps, 6)
  match.step()
  assert.equal(match.appliedFor('p'), 10) // кредит вичерпано — звичайний темп
})

test('Match: частіші команди (90/с замість 60/с) не прискорюють літак', () => {
  const match = new Match({ arena: QUIET_ARENA })
  match.addPlayer('p')
  let seq = 0
  for (let t = 0; t < 300; t++) {
    for (let i = 0; i < 3; i++) match.pushInput('p', input(++seq, 0, true))
    match.step()
  }
  const applied = match.appliedFor('p')
  assert.ok(applied <= 600 + 10, `застосовано ${applied} команд за 600 кроків`)
  assert.ok(match.stats.droppedInputs > 0)
})

function mulberry(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('netsim: затримка зберігає порядок, drop губить лише знімки', async () => {
  const link = createLink({ lag: 40, jitter: 30, drop: 0.5 }, mulberry(1))
  const got: number[] = []
  for (let i = 0; i < 20; i++) link.out(() => got.push(i))
  let snaps = 0
  for (let i = 0; i < 100; i++) link.out(() => snaps++, { droppable: true })
  await sleep(200)
  assert.deepEqual(got, [...Array(20).keys()])
  assert.ok(snaps > 25 && snaps < 75, `доставлено знімків: ${snaps}`)
})

test('JSON і бінарний кодек декодують у ту саму структуру', () => {
  const snap: Snapshot = {
    type: 'snapshot',
    tick: toTick(1),
    ack: toSeq(2),
    you: toEntityId(3),
    entities: [],
    events: [{ type: 'score', x: 1, y: 2, shipId: toEntityId(3), delta: 50 }],
  }
  const viaJson = jsonCodec.decodeSnapshot(jsonCodec.encodeSnapshot(snap))
  const viaBinary = binaryCodec.decodeSnapshot(binaryCodec.encodeSnapshot(snap))
  assert.ok(viaJson.ok && viaBinary.ok)
  assert.deepEqual(viaJson.value, snap)
  assert.deepEqual(viaBinary.value, snap)
})

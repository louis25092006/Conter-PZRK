import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { World } from '../src/sim/world.js'
import { Ship } from '../src/sim/ship.js'
import { populateArena } from '../src/sim/spawner.js'
import { ARENA_SIZE } from '../src/sim/arena.js'
import { hashWorld } from '../src/sim/hash.js'
import { stepShip, PLAYER_SHIP, SIM_DT, debug } from '../src/sim/ship-physics.js'
import { snapshotEntities, makeSnapshot, collectEvents } from '../src/net/snapshot.js'
import { binaryCodec, jsonCodec, byteSize } from '../src/codec/index.js'

// ---------- допоміжне: детермінований "гравець" ----------
function scriptedCommand(step) {
  return {
    turn: step % 90 < 30 ? 1 : step % 90 < 45 ? -1 : 0,
    thrust: step % 7 !== 0,
    fire: step % 5 === 0,
    seq: step + 1,
  }
}

function runMatch(steps, seed = 2026) {
  const world = new World({ ...ARENA_SIZE, arena: { ...ARENA_DEFAULTS, seed } })
  const a = world.spawn(new Ship({ x: 400, y: 450 }))
  const b = world.spawn(new Ship({ x: 1200, y: 450, angle: Math.PI }))
  populateArena(world)
  for (let i = 0; i < steps; i++) {
    world.step(
      SIM_DT,
      new Map([
        [a.id, scriptedCommand(i)],
        [b.id, scriptedCommand(i + 17)],
      ]),
    )
  }
  return world
}
const ARENA_DEFAULTS = {
  name: 'test',
  startAsteroids: 3,
  asteroidEvery: 4,
  asteroidsBase: 3,
  asteroidsCap: 6,
  homingChance: 0.2,
  enemyEvery: 3,
  enemiesBase: 2,
  enemiesCap: 4,
  pickupEvery: 5,
}

// ---------- чистота ----------

test('shared/src не використовує DOM і вбудовані модулі Node', () => {
  const walk = (dir) =>
    readdirSync(dir).flatMap((f) =>
      statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)],
    )
  for (const file of walk(fileURLToPath(new URL('../src', import.meta.url)))) {
    const code = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '') // коментарі не рахуються
    assert.doesNotMatch(code, /\b(document|window|localStorage)\./, `${file}: DOM`)
    assert.doesNotMatch(code, /from ['"]node:/, `${file}: Node built-in`)
    assert.doesNotMatch(code, /Date\.now\(\)/, `${file}: Date.now() ламає детермінізм`)
  }
})

// ---------- детермінізм ----------

test('детермінізм: ті самі команди й seed → той самий хеш', () => {
  const h1 = hashWorld(runMatch(1800))
  const h2 = hashWorld(runMatch(1800))
  assert.equal(h1, h2)
  assert.notEqual(hashWorld(runMatch(1800, 7)), h1) // інший seed — інший світ
})

test('передбачення клієнта збігається з сервером біт у біт (без колізій)', () => {
  // "сервер": справжній Ship у світі без ворогів і астероїдів
  const world = new World({
    ...ARENA_SIZE,
    arena: {
      ...ARENA_DEFAULTS,
      startAsteroids: 0,
      asteroidsCap: 0,
      enemiesCap: 0,
      enemiesBase: 0,
      pickupEvery: 1e9,
    },
  })
  const ship = world.spawn(new Ship({ x: 800, y: 450 }))
  // "клієнт": той самий стан як прості числа + stepShip
  const predicted = ship.motionState()
  for (let i = 0; i < 600; i++) {
    const cmd = scriptedCommand(i)
    world.step(SIM_DT, new Map([[ship.id, cmd]]))
    stepShip(predicted, cmd, { ...PLAYER_SHIP, rapid: false }, SIM_DT, ARENA_SIZE.width, ARENA_SIZE.height)
  }
  assert.deepEqual(predicted, ship.motionState()) // точна рівність, не "приблизно"
})

test('зламаний детермінізм (Math.random у фізиці) розводить клієнта і сервер', () => {
  const s1 = { x: 800, y: 450, vx: 0, vy: 0, angle: 0, cooldown: 0 }
  const s2 = { ...s1 }
  debug.breakDeterminism = true
  try {
    for (let i = 0; i < 120; i++) {
      stepShip(s1, { turn: 0, thrust: true, fire: false }, PLAYER_SHIP, SIM_DT, 1600, 900)
      stepShip(s2, { turn: 0, thrust: true, fire: false }, PLAYER_SHIP, SIM_DT, 1600, 900)
    }
  } finally {
    debug.breakDeterminism = false
  }
  assert.notEqual(s1.x, s2.x)
})

// ---------- кодеки ----------

function realSnapshot() {
  const world = runMatch(0)
  const events = collectEvents(world)
  for (let i = 0; i < 600; i++) world.step(SIM_DT, new Map())
  return makeSnapshot({
    tick: 300,
    ack: 4242,
    you: 1,
    entities: snapshotEntities(world),
    events: events.drain(),
  })
}

function assertClose(actual, expected, path = 'snap') {
  if (typeof expected === 'number' && /angle$/.test(path)) {
    // кут порівнюємо по колу: 7.23 рад і 0.95 рад — той самий напрямок (кодек зводить до [-π, π])
    const d = Math.atan2(Math.sin(actual - expected), Math.cos(actual - expected))
    assert.ok(Math.abs(d) <= 0.0006, `${path}: ${actual} vs ${expected}`)
  } else if (typeof expected === 'number') {
    const tol = /(respawnIn|invulnerable|shield|rapid|homing|ttl)$/.test(path)
      ? 0.051
      : 1e-3 * Math.max(1, Math.abs(expected))
    assert.ok(Math.abs(actual - expected) <= tol, `${path}: ${actual} vs ${expected}`)
  } else if (expected && typeof expected === 'object') {
    for (const k of Object.keys(expected)) assertClose(actual[k], expected[k], `${path}.${k}`)
  } else {
    assert.equal(actual, expected, path)
  }
}

test('binary: decode(encode(snapshot)) ≈ snapshot (у межах квантування)', () => {
  const snap = realSnapshot()
  assert.ok(snap.entities.length > 5)
  const decoded = binaryCodec.decodeSnapshot(binaryCodec.encodeSnapshot(snap))
  assert.equal(decoded.entities.length, snap.entities.length)
  assertClose(decoded, snap)
})

test('binary: команда гравця — 8 байтів, точний round-trip', () => {
  for (const cmd of [
    { seq: 1, turn: -1, thrust: true, fire: false },
    { seq: 4294967295, turn: 1, thrust: false, fire: true },
    { seq: 77, turn: 0, thrust: false, fire: false },
  ]) {
    const bytes = binaryCodec.encodeInput(cmd)
    assert.equal(bytes.byteLength, 8)
    assert.deepEqual(binaryCodec.decodeInput(new Uint8Array(bytes)), { type: 'input', ...cmd })
  }
})

test('binary: читає Buffer зі зсувом (як віддає ws у Node)', () => {
  const bytes = new Uint8Array(binaryCodec.encodeInput({ seq: 9, turn: 1, thrust: true, fire: true }))
  const pooled = new Uint8Array(64)
  pooled.set(bytes, 13)
  assert.equal(binaryCodec.decodeInput(pooled.subarray(13, 21)).seq, 9)
})

test('binary: чужа версія або тип → помилка', () => {
  const bytes = new Uint8Array(binaryCodec.encodeInput({ seq: 1, turn: 0, thrust: false, fire: false }))
  bytes[1] = 99
  assert.throws(() => binaryCodec.decodeInput(bytes), /header/)
  const snap = new Uint8Array(binaryCodec.encodeSnapshot(realSnapshot()))
  snap[1] = 2
  assert.throws(() => binaryCodec.decodeSnapshot(snap), /version/)
})

test('binary значно менший за JSON', () => {
  const snap = realSnapshot()
  const json = byteSize(jsonCodec.encodeSnapshot(snap))
  const bin = byteSize(binaryCodec.encodeSnapshot(snap))
  assert.ok(bin * 3 < json, `binary ${bin} B vs json ${json} B`)
})

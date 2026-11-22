import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { World } from '../src/sim/world.ts'
import { Ship } from '../src/sim/ship.ts'
import { populateArena } from '../src/sim/spawner.ts'
import { ARENA_SIZE } from '../src/sim/arena.ts'
import { hashWorld } from '../src/sim/hash.ts'
import { stepShip, PLAYER_SHIP, SIM_DT, debug } from '../src/sim/ship-physics.ts'
import { snapshotEntities, makeSnapshot, collectEvents } from '../src/net/snapshot.ts'
import { binaryCodec, jsonCodec, byteSize } from '../src/codec/index.ts'
import { parseClientMessage, CLOSE, type Snapshot } from '../src/protocol.ts'
import { toEntityId, toSeq, toTick } from '../src/types.ts'
import type { ArenaConfig } from '../src/arena-config.ts'
import type { Command } from '../src/sim/ship-physics.ts'

// ---------- допоміжне: детермінований "гравець" ----------
function scriptedCommand(step: number): Command {
  return {
    turn: step % 90 < 30 ? 1 : step % 90 < 45 ? -1 : 0,
    thrust: step % 7 !== 0,
    fire: step % 5 === 0,
    seq: toSeq(step + 1),
  }
}

function runMatch(steps: number, seed = 2026): World {
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
const ARENA_DEFAULTS: ArenaConfig = {
  seed: 1,
  sky: '#000',
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
  const walk = (dir: string): string[] =>
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

function realSnapshot(): Snapshot {
  const world = runMatch(0)
  const events = collectEvents(world)
  for (let i = 0; i < 600; i++) world.step(SIM_DT, new Map())
  return makeSnapshot({
    tick: toTick(300),
    ack: toSeq(4242),
    you: toEntityId(1),
    entities: snapshotEntities(world),
    events: events.drain(),
  })
}

// порівняння "у межах квантування" (кут — по колу, ефекти — до десятих секунди)
function assertClose(actual: unknown, expected: unknown, path = 'snap'): void {
  if (typeof expected === 'number' && typeof actual === 'number' && /angle$/.test(path)) {
    const d = Math.atan2(Math.sin(actual - expected), Math.cos(actual - expected))
    assert.ok(Math.abs(d) <= 0.0006, `${path}: ${actual} vs ${expected}`)
  } else if (typeof expected === 'number' && typeof actual === 'number') {
    const tol = /(respawnIn|invulnerable|shield|rapid|homing|ttl)$/.test(path)
      ? 0.051
      : 1e-3 * Math.max(1, Math.abs(expected))
    assert.ok(Math.abs(actual - expected) <= tol, `${path}: ${actual} vs ${expected}`)
  } else if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', `${path}: expected an object`)
    for (const [k, v] of Object.entries(expected)) assertClose(Reflect.get(actual, k), v, `${path}.${k}`)
  } else {
    assert.equal(actual, expected, path)
  }
}

function binaryBytes(encoded: string | ArrayBuffer): Uint8Array {
  assert.ok(encoded instanceof ArrayBuffer, 'binary codec must produce an ArrayBuffer')
  return new Uint8Array(encoded)
}

test('binary: decode(encode(snapshot)) ≈ snapshot (у межах квантування)', () => {
  const snap = realSnapshot()
  assert.ok(snap.entities.length > 5)
  const decoded = binaryCodec.decodeSnapshot(binaryCodec.encodeSnapshot(snap))
  assert.ok(decoded.ok, decoded.ok ? '' : decoded.error)
  assert.equal(decoded.value.entities.length, snap.entities.length)
  assertClose(decoded.value, snap)
})

test('binary: команда гравця — 8 байтів, точний round-trip', () => {
  const cases: [number, -1 | 0 | 1, boolean, boolean][] = [
    [1, -1, true, false],
    [4294967295, 1, false, true],
    [77, 0, false, false],
  ]
  for (const [seq, turn, thrust, fire] of cases) {
    const cmd = { type: 'input', seq: toSeq(seq), turn, thrust, fire } satisfies Parameters<
      typeof binaryCodec.encodeInput
    >[0]
    const bytes = binaryBytes(binaryCodec.encodeInput(cmd))
    assert.equal(bytes.byteLength, 8)
    const back = binaryCodec.decodeInput(bytes)
    assert.ok(back.ok)
    assert.deepEqual(back.value, cmd)
  }
})

test('binary: читає Buffer зі зсувом (як віддає ws у Node)', () => {
  const bytes = binaryBytes(
    binaryCodec.encodeInput({ type: 'input', seq: toSeq(9), turn: 1, thrust: true, fire: true }),
  )
  const pooled = new Uint8Array(64)
  pooled.set(bytes, 13)
  const back = binaryCodec.decodeInput(pooled.subarray(13, 21))
  assert.ok(back.ok)
  assert.equal(back.value.seq, 9)
})

test('binary: сміття, чужа версія, обрізане повідомлення → помилка, не виняток', () => {
  const bytes = binaryBytes(
    binaryCodec.encodeInput({ type: 'input', seq: toSeq(1), turn: 0, thrust: false, fire: false }),
  )
  bytes[1] = 99
  const badVersion = binaryCodec.decodeInput(bytes)
  assert.ok(!badVersion.ok && /version/.test(badVersion.error))
  const snap = binaryBytes(binaryCodec.encodeSnapshot(realSnapshot()))
  const truncated = binaryCodec.decodeSnapshot(snap.subarray(0, snap.length - 5))
  assert.ok(!truncated.ok && /truncated/.test(truncated.error))
  snap[1] = 2
  const wrong = binaryCodec.decodeSnapshot(snap)
  assert.ok(!wrong.ok && /version/.test(wrong.error))
  assert.equal(binaryCodec.decodeInput(new Uint8Array([1, 1, 0, 0, 0, 0, 7, 0])).ok, false) // turn = 7
})

test('binary: кодер не обрізає мовчки значення поза діапазоном', () => {
  const snap = realSnapshot()
  const ship = snap.entities.find((e) => e.kind === 'ship')
  assert.ok(ship)
  const broken: Snapshot = { ...snap, entities: [{ ...ship, hp: 300 }] }
  assert.throws(() => binaryCodec.encodeSnapshot(broken), /hp: 300 is out of \[0, 255\]/)
})

test('JSON-кодек перевіряє знімок схемою', () => {
  const snap = realSnapshot()
  const ok = jsonCodec.decodeSnapshot(jsonCodec.encodeSnapshot(snap))
  assert.ok(ok.ok)
  const bad = jsonCodec.decodeSnapshot(JSON.stringify({ ...snap, tick: -1 }))
  assert.equal(bad.ok, false)
})

test('binary значно менший за JSON', () => {
  const snap = realSnapshot()
  const json = byteSize(jsonCodec.encodeSnapshot(snap))
  const bin = byteSize(binaryCodec.encodeSnapshot(snap))
  assert.ok(bin * 3 < json, `binary ${bin} B vs json ${json} B`)
})

// ---------- протокол ----------

test('parseClientMessage: валідні повідомлення → ok з правильним типом', () => {
  const r = parseClientMessage(JSON.stringify({ type: 'join', v: 1, roomId: 'r1', name: 'Ira' }))
  assert.ok(r.ok)
  if (r.value.type === 'join') assert.equal(r.value.name, 'Ira') // звуження за type
  assert.ok(
    parseClientMessage(JSON.stringify({ type: 'input', seq: 5, turn: -1, thrust: true, fire: false })).ok,
  )
})

test('parseClientMessage: кожен вид поганого повідомлення має свій код і не кидає виняток', () => {
  const code = (raw: string): number | null => {
    const r = parseClientMessage(raw)
    return r.ok ? null : r.error.code
  }
  assert.equal(code('{not json'), CLOSE.BAD_JSON)
  assert.equal(code('[1,2]'), CLOSE.BAD_SHAPE)
  assert.equal(code('{"no":"type"}'), CLOSE.BAD_SHAPE)
  assert.equal(code('{"type":"fly"}'), CLOSE.UNKNOWN_TYPE)
  assert.equal(code('{"type":"__proto__"}'), CLOSE.UNKNOWN_TYPE)
  assert.equal(code('{"type":"join","v":7,"roomId":"r","name":"a"}'), CLOSE.BAD_VERSION)
  assert.equal(code('{"type":"join","v":1,"roomId":"r","name":""}'), CLOSE.BAD_SHAPE)
  assert.equal(
    code(JSON.stringify({ type: 'input', seq: 1, turn: 5, thrust: true, fire: false })),
    CLOSE.BAD_SHAPE,
  )
  assert.equal(code(JSON.stringify({ type: 'chat', text: 'x'.repeat(201) })), CLOSE.BAD_SHAPE)
  assert.equal(code(JSON.stringify({ type: 'chat', text: 'x'.repeat(3000) })), CLOSE.TOO_BIG)
})

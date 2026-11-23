// Lab 7, M1: property-based тести (fast-check). Замість кількох прикладів — сотні
// згенерованих входів; якщо властивість ламається, fast-check «стискає» (shrink) приклад
// до найменшого, на якому вона ще ламається, і друкує його.
import { describe, test, expect } from 'vitest'
import fc from 'fast-check'
import * as binary from '../src/codec/binary.ts'
import { binaryCodec } from '../src/codec/index.ts'
import {
  parseClientMessage,
  MAX_CHAT,
  MAX_NAME,
  type ClientMessage,
  type EntityData,
  type Snapshot,
} from '../src/protocol.ts'
import type { GameEvent } from '../src/events.ts'
import { toEntityId, toSeq, toTick, EFFECT_NAMES, type Team } from '../src/types.ts'
import { stepShip, PLAYER_SHIP, SIM_DT, type Command, type MotionState } from '../src/sim/ship-physics.ts'
import { ARENA_SIZE } from '../src/sim/arena.ts'
import { World } from '../src/sim/world.ts'
import { Ship } from '../src/sim/ship.ts'
import { populateArena } from '../src/sim/spawner.ts'
import { hashWorld } from '../src/sim/hash.ts'
import { DEFAULT_ARENA } from '../src/arena-config.ts'
import { Bullet } from '../src/sim/bullet.ts'
import { findCollisions } from '../src/sim/collision.ts'
import { createSpatialHash } from '../src/sim/spatial-hash.ts'

const { width: W, height: H } = ARENA_SIZE

// ---------- генератори ----------
// f32: fc.float дає саме 32-бітні числа (Math.fround(x) === x) — такі бінарний кодек зберігає точно
const f32 = fc.float({ min: -1e5, max: 1e5, noNaN: true, noDefaultInfinity: true })
const id = fc.integer({ min: 1, max: 0xffffffff }).map(toEntityId)
const optId = fc.option(id, { nil: null })
const seq = fc.integer({ min: 1, max: 0xffffffff }).map(toSeq)
const team = fc.constantFrom<Team>('player', 'enemy', 'neutral')
const effect = fc.constantFrom(...EFFECT_NAMES)
const deci = fc.integer({ min: 0, max: 255 }).map((n) => n / 10) // десяті частки секунди, як у протоколі
const angle = fc.double({ min: -100, max: 100, noNaN: true })
const common = { id, x: f32, y: f32, angle }

const ship = fc.record({
  ...common,
  kind: fc.constant<'ship'>('ship'),
  team,
  vx: f32,
  vy: f32,
  hp: fc.integer({ min: 0, max: 255 }),
  maxHp: fc.integer({ min: 1, max: 255 }),
  thrust: fc.boolean(),
  respawnIn: deci,
  invulnerable: deci,
  cooldown: fc.float({ min: 0, max: 10, noNaN: true }),
  effects: fc.record({ shield: deci, rapid: deci, homing: deci }),
  score: fc.integer({ min: 0, max: 0xffffffff }),
  deaths: fc.integer({ min: 0, max: 0xffff }),
})
const bullet = fc.record({
  ...common,
  kind: fc.constant<'bullet'>('bullet'),
  team,
  homing: fc.boolean(),
  ownerId: optId,
  spawnSeq: fc.option(seq, { nil: null }),
})
const asteroid = fc.record({
  ...common,
  kind: fc.constant<'asteroid'>('asteroid'),
  size: fc.constantFrom<1 | 2 | 3>(1, 2, 3),
  variant: fc.integer({ min: 0, max: 255 }),
  homing: fc.boolean(),
})
const pickup = fc.record({ ...common, kind: fc.constant<'pickup'>('pickup'), effect, ttl: deci })
const entity: fc.Arbitrary<EntityData> = fc.oneof(ship, bullet, asteroid, pickup)

const at = { x: f32, y: f32 }
const event: fc.Arbitrary<GameEvent> = fc.oneof(
  fc.record({ ...at, type: fc.constant<'fired'>('fired'), team, shipId: id, homing: fc.boolean() }),
  fc.record({
    ...at,
    type: fc.constant<'hit'>('hit'),
    team,
    shipId: optId,
    target: fc.constantFrom<'ship' | 'asteroid'>('ship', 'asteroid'),
  }),
  fc.record({
    ...at,
    type: fc.constant<'exploded'>('exploded'),
    team,
    shipId: optId,
    kind: fc.constantFrom<'ship' | 'asteroid'>('ship', 'asteroid'),
    size: fc.integer({ min: 0, max: 255 }),
  }),
  fc.record({ ...at, type: fc.constant<'pickup'>('pickup'), shipId: id, effect }),
  fc.record({
    ...at,
    type: fc.constant<'score'>('score'),
    shipId: id,
    delta: fc.integer({ min: 0, max: 0xffff }),
  }),
)
const snapshot: fc.Arbitrary<Snapshot> = fc.record({
  type: fc.constant<'snapshot'>('snapshot'),
  tick: fc.integer({ min: 0, max: 0xffffffff }).map(toTick),
  ack: fc.integer({ min: 0, max: 0xffffffff }).map(toSeq),
  you: optId,
  entities: fc.array(entity, { maxLength: 40 }),
  events: fc.array(event, { maxLength: 20 }),
})

// ---------- що має вийти після кодування: та сама квантизація, що в протоколі ----------
const TAU = Math.PI * 2
function quantAngle(a: number): number {
  let r = ((a % TAU) + TAU) % TAU
  if (r > Math.PI) r -= TAU
  return Math.round(r * 1000) / 1000 || 0 // || 0: -0 → 0 (getInt16 не повертає -0)
}
function expected(s: Snapshot): Snapshot {
  return { ...s, entities: s.entities.map((e) => ({ ...e, angle: quantAngle(e.angle) })) }
}

// розмір за специфікацією (коментар на початку codec/binary.ts)
const SPEC_SIZE: Record<EntityData['kind'], number> = {
  ship: 15 + 27,
  bullet: 15 + 10,
  asteroid: 15 + 3,
  pickup: 15 + 2,
}

describe('властивості бінарного кодека', () => {
  test('P1: decode(encode(знімок)) = знімок з квантуванням кута (решта — точно)', () => {
    fc.assert(
      fc.property(snapshot, (s) => {
        const back = binaryCodec.decodeSnapshot(binaryCodec.encodeSnapshot(s))
        expect(back.ok).toBe(true)
        if (back.ok) expect(back.value).toEqual(expected(s))
      }),
      { numRuns: 300 },
    )
  })

  test('P2: довжина = 17 + Σ розмірів сутностей + 18 × подій (як у специфікації)', () => {
    fc.assert(
      fc.property(snapshot, (s) => {
        const bytes = binary.encodeSnapshot(s).byteLength
        const spec = 17 + s.entities.reduce((sum, e) => sum + SPEC_SIZE[e.kind], 0) + 18 * s.events.length
        expect(bytes).toBe(spec)
      }),
    )
  })

  test('P3: команда гравця — точний round-trip і завжди 8 байтів', () => {
    const input = fc.record({
      type: fc.constant<'input'>('input'),
      seq: fc.integer({ min: 0, max: 0xffffffff }).map(toSeq),
      turn: fc.constantFrom<-1 | 0 | 1>(-1, 0, 1),
      thrust: fc.boolean(),
      fire: fc.boolean(),
    })
    fc.assert(
      fc.property(input, (m) => {
        const buf = binary.encodeInput(m)
        expect(buf.byteLength).toBe(8)
        expect(binary.decodeInput(buf)).toEqual(m)
      }),
    )
  })

  test('P4: будь-яке сміття → типізована помилка (DecodeError / Result), ніколи не падіння', () => {
    // три види «сміття»: випадкові байти; правильний заголовок + випадковий хвіст;
    // справжній знімок, обрізаний або з перекрученими байтами
    const valid = snapshot.map((s) => new Uint8Array(binary.encodeSnapshot(s)))
    const garbage = fc.oneof(
      fc.uint8Array({ maxLength: 200 }),
      fc.uint8Array({ maxLength: 200 }).map((tail) => Uint8Array.from([2, 1, ...tail])),
      fc.tuple(valid, fc.nat()).map(([b, n]) => b.slice(0, n % (b.length + 1))),
      fc.tuple(valid, fc.nat(), fc.integer({ min: 0, max: 255 })).map(([b, i, v]) => {
        const c = b.slice()
        if (c.length) c[i % c.length] = v
        return c
      }),
    )
    fc.assert(
      fc.property(garbage, (bytes) => {
        // 1) обгортка кодека ніколи не кидає — повертає Result
        expect(() => binaryCodec.decodeSnapshot(bytes)).not.toThrow()
        expect(() => binaryCodec.decodeInput(bytes)).not.toThrow()
        // 2) сирий декодер кидає ЛИШЕ DecodeError, а не TypeError/RangeError звідкись зсередини
        for (const decode of [binary.decodeSnapshot, binary.decodeInput]) {
          try {
            decode(bytes)
          } catch (e) {
            expect(e).toBeInstanceOf(binary.DecodeError)
          }
        }
      }),
      { numRuns: 1000 },
    )
  })
})

describe('властивості симуляції', () => {
  const command: fc.Arbitrary<Command> = fc.record({
    turn: fc.constantFrom(-1, 0, 1),
    thrust: fc.boolean(),
    fire: fc.boolean(),
  })

  test('P5: літак лишається в межах арени за 1000 випадкових кроків', () => {
    const start = fc.record({
      x: fc.double({ min: 0, max: W, noNaN: true }),
      y: fc.double({ min: 0, max: H, noNaN: true }),
      vx: fc.double({ min: -300, max: 300, noNaN: true }),
      vy: fc.double({ min: -300, max: 300, noNaN: true }),
      angle: fc.double({ min: -10, max: 10, noNaN: true }),
      cooldown: fc.constant(0),
    })
    fc.assert(
      fc.property(start, fc.array(command, { minLength: 1000, maxLength: 1000 }), (s0, cmds) => {
        const s: MotionState = { ...s0 }
        for (const c of cmds) {
          stepShip(s, c, PLAYER_SHIP, SIM_DT, W, H)
          if (!(s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= H)) return false
          if (Math.hypot(s.vx, s.vy) > PLAYER_SHIP.maxSpeed + 1e-6) return false // і швидкість обмежена
        }
        return true
      }),
      { numRuns: 100 },
    )
  })

  test('P6: детермінізм — ті самі випадкові команди в двох світах → той самий хеш', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1e6 }),
        fc.array(command, { minLength: 50, maxLength: 200 }),
        (seed, cmds) => {
          const run = (): string => {
            const world = new World({ ...ARENA_SIZE, arena: { ...DEFAULT_ARENA, seed } })
            const me = world.spawn(new Ship({ x: 400, y: 450 }))
            populateArena(world)
            cmds.forEach((c, i) => world.step(SIM_DT, new Map([[me.id, { ...c, seq: toSeq(i + 1) }]])))
            return hashWorld(world)
          }
          return run() === run()
        },
      ),
      { numRuns: 30 },
    )
  })
})

describe('властивості парсера повідомлень клієнта', () => {
  const name = fc.string({ minLength: 1, maxLength: MAX_NAME }).filter((s) => s.trim().length > 0)
  const valid: fc.Arbitrary<ClientMessage> = fc.oneof(
    fc.record({
      type: fc.constant<'join'>('join'),
      v: fc.constant<1>(1),
      roomId: fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0),
      name,
    }),
    fc.record({
      type: fc.constant<'chat'>('chat'),
      text: fc.string({ minLength: 1, maxLength: MAX_CHAT }).filter((s) => s.trim().length > 0),
    }),
    fc.record({ type: fc.constant<'leave'>('leave') }),
    fc.record({
      type: fc.constant<'input'>('input'),
      seq: fc.integer({ min: 0, max: 0xffffffff }).map(toSeq),
      turn: fc.constantFrom<-1 | 0 | 1>(-1, 0, 1),
      thrust: fc.boolean(),
      fire: fc.boolean(),
    }),
    fc.record({ type: fc.constant<'ping'>('ping'), t: fc.double({ min: 0, max: 1e12, noNaN: true }) }),
    fc.record({
      type: fc.constant<'netsim'>('netsim'),
      lag: fc.double({ min: 0, max: 1000, noNaN: true }),
      jitter: fc.double({ min: 0, max: 500, noNaN: true }),
      drop: fc.double({ min: 0, max: 0.5, noNaN: true }),
    }),
  )

  test('P7: кожне згенероване валідне повідомлення приймається', () => {
    fc.assert(
      fc.property(valid, (m) => {
        const r = parseClientMessage(JSON.stringify(m))
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.value.type).toBe(m.type)
      }),
      { numRuns: 500 },
    )
  })

  // Мутації: кожна за простою таблицею робить повідомлення гарантовано НЕвалідним.
  type Json = Record<string, unknown>
  const fieldsOf = (m: Json): string[] => Object.keys(m).filter((k) => k !== 'type')
  // значення іншого типу: рядок замість числа, число замість рядка, рядок замість boolean
  const wrongType = (v: unknown): unknown =>
    typeof v === 'number' ? 'x' : typeof v === 'string' ? 123 : 'yes'
  // число поза діапазоном: turn — лише -1|0|1; решта числових полів мають min 0 (v: 1 → чужа версія)
  const outOfRange = (key: string): number => (key === 'turn' ? 2 : -1)

  const mutation = fc.oneof(
    fc.constant((m: Json): Json => ({ ...m, type: 'hack' })), // невідомий тип
    fc.constant((m: Json): Json => ({ ...m, type: 42 })), // type не рядок
    fc.constant((m: Json): Json => {
      const { type: _type, ...rest } = m // без type взагалі
      return rest
    }),
    fc.nat().map((i) => (m: Json): Json => {
      const key = fieldsOf(m)[i % Math.max(1, fieldsOf(m).length)]
      if (key === undefined) return { ...m, type: 'leave ' } // у leave немає полів — псуємо type
      return { ...m, [key]: wrongType(m[key]) }
    }),
    fc.nat().map((i) => (m: Json): Json => {
      const numeric = fieldsOf(m).filter((k) => typeof m[k] === 'number')
      const key = numeric[i % Math.max(1, numeric.length)]
      if (key === undefined) return { ...m, type: ['chat'] } // числових полів немає — type масивом
      return { ...m, [key]: outOfRange(key) }
    }),
    fc.nat().map((i) => (m: Json): Json => {
      const key = fieldsOf(m)[i % Math.max(1, fieldsOf(m).length)]
      if (key === undefined) return { ...m, type: null }
      const copy = { ...m }
      delete copy[key] // усі поля обов'язкові
      return copy
    }),
  )

  test('P8: кожна мутація валідного повідомлення відхиляється з кодом закриття', () => {
    fc.assert(
      fc.property(valid, mutation, (m, mutate) => {
        const bad = mutate({ ...m })
        const r = parseClientMessage(JSON.stringify(bad))
        expect(r.ok).toBe(false)
        if (!r.ok) expect([4000, 4001, 4002, 4004]).toContain(r.error.code)
      }),
      { numRuns: 500 },
    )
  })
})

describe('властивості оптимізацій (Lab 7, M3)', () => {
  test('P9: просторова сітка дає ТІ САМІ пари в ТОМУ САМОМУ порядку, що й наївне O(n²)', () => {
    const body = fc.record({
      x: fc.double({ min: -50, max: W + 50, noNaN: true }), // і трохи за межами арени
      y: fc.double({ min: -50, max: H + 50, noNaN: true }),
      r: fc.double({ min: 1, max: 60, noNaN: true }),
    })
    fc.assert(
      fc.property(fc.array(body, { maxLength: 120 }), fc.integer({ min: 8, max: 200 }), (bodies, cell) => {
        const world = new World({ ...ARENA_SIZE, arena: DEFAULT_ARENA })
        for (const b of bodies) world.spawn(new Bullet({ x: b.x, y: b.y, radius: b.r }))
        const ids = (pairs: Iterable<readonly [{ id: number }, { id: number }]>): string =>
          [...pairs].map(([a, b]) => `${a.id}-${b.id}`).join(',')
        expect(ids(createSpatialHash(cell)(world))).toBe(ids(findCollisions(world)))
      }),
      { numRuns: 300 },
    )
  })

  test('P10: шаблон знімка + заголовок клієнта = повне кодування з його ack/you (байт-у-байт)', () => {
    fc.assert(
      fc.property(snapshot, fc.integer({ min: 0, max: 0xffffffff }).map(toSeq), optId, (s, ack, you) => {
        const template = binary.encodeSnapshot({ ...s, you: null })
        const patched = new Uint8Array(binary.withSnapshotHeader(template, ack, you))
        const full = new Uint8Array(binary.encodeSnapshot({ ...s, ack, you }))
        expect(patched).toEqual(full)
      }),
    )
  })
})

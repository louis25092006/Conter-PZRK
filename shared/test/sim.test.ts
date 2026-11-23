// Lab 7, M1: юніт-тести симуляції — вектор, інтегрування, колізії, детермінізм, звірка.
import { describe, test, expect } from 'vitest'
import { Vector2 } from '../src/sim/vector.ts'
import { World } from '../src/sim/world.ts'
import { Ship } from '../src/sim/ship.ts'
import { Bullet } from '../src/sim/bullet.ts'
import { Asteroid, RADIUS } from '../src/sim/asteroid.ts'
import { Pickup } from '../src/sim/pickup.ts'
import { findCollisions } from '../src/sim/collision.ts'
import { populateArena } from '../src/sim/spawner.ts'
import { ARENA_SIZE } from '../src/sim/arena.ts'
import { createRng } from '../src/sim/random.ts'
import { snapshotEntities } from '../src/net/snapshot.ts'
import { reconcile, type PendingInput } from '../src/net/reconcile.ts'
import {
  stepShip,
  muzzle,
  PLAYER_SHIP,
  SIM_DT,
  SHIP_DRAG,
  BULLET_SPEED,
  IDLE,
  type MotionState,
  type Command,
} from '../src/sim/ship-physics.ts'
import { toSeq } from '../src/types.ts'
import type { ArenaConfig } from '../src/arena-config.ts'

const { width: W, height: H } = ARENA_SIZE

// арена без спавнера: у тестах колізій нічого не має з'являтися саме
const EMPTY: ArenaConfig = {
  name: 'empty',
  seed: 1,
  sky: '#000',
  startAsteroids: 0,
  asteroidEvery: 1e9,
  asteroidsBase: 0,
  asteroidsCap: 0,
  homingChance: 0,
  enemyEvery: 1e9,
  enemiesBase: 0,
  enemiesCap: 0,
  pickupEvery: 1e9,
}
const emptyWorld = (): World => new World({ ...ARENA_SIZE, arena: EMPTY })
const rest = (x: number, y: number, angle = 0): MotionState => ({ x, y, vx: 0, vy: 0, angle, cooldown: 0 })

describe('Vector2', () => {
  test('арифметика повертає нові вектори і не змінює старі', () => {
    const a = new Vector2(1, 2)
    const b = new Vector2(3, -4)
    expect(a.add(b)).toEqual(new Vector2(4, -2))
    expect(a.sub(b)).toEqual(new Vector2(-2, 6))
    expect(a.scale(3)).toEqual(new Vector2(3, 6))
    expect(a).toEqual(new Vector2(1, 2))
  })
  test('довжина, скалярний добуток, відстань', () => {
    const v = new Vector2(3, 4)
    expect(v.length()).toBe(5)
    expect(v.lengthSq()).toBe(25)
    expect(v.dot(new Vector2(2, 1))).toBe(10)
    expect(v.distanceTo(new Vector2(0, 0))).toBe(5)
  })
  test('normalize: одинична довжина; нульовий вектор лишається нульовим (без NaN)', () => {
    expect(new Vector2(10, 0).normalize()).toEqual(new Vector2(1, 0))
    expect(new Vector2(0, 0).normalize()).toEqual(new Vector2(0, 0))
  })
  test('fromAngle, rotate, lerp', () => {
    const up = Vector2.fromAngle(Math.PI / 2, 2)
    expect(up.x).toBeCloseTo(0)
    expect(up.y).toBeCloseTo(2)
    const r = new Vector2(1, 0).rotate(Math.PI)
    expect(r.x).toBeCloseTo(-1)
    expect(r.y).toBeCloseTo(0)
    expect(Vector2.lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.25)).toEqual(new Vector2(2.5, 5))
  })
})

describe('інтегрування (stepShip)', () => {
  test('без команд літак стоїть, лише cooldown тане', () => {
    const s = { ...rest(100, 100), cooldown: 0.1 }
    stepShip(s, IDLE, PLAYER_SHIP, SIM_DT, W, H)
    expect(s).toEqual({ ...rest(100, 100), cooldown: 0.1 - SIM_DT })
  })
  test('один крок газу: швидкість = thrustPower·dt·drag, позиція = швидкість·dt', () => {
    const s = rest(100, 100)
    stepShip(s, { turn: 0, thrust: true, fire: false }, PLAYER_SHIP, SIM_DT, W, H)
    const v = PLAYER_SHIP.thrustPower * SIM_DT * SHIP_DRAG
    expect(s.vx).toBeCloseTo(v, 10)
    expect(s.vy).toBeCloseTo(0, 10)
    expect(s.x).toBeCloseTo(100 + v * SIM_DT, 10)
  })
  test('поворот: кут змінюється на turnSpeed·dt', () => {
    const s = rest(100, 100)
    stepShip(s, { turn: -1, thrust: false, fire: false }, PLAYER_SHIP, SIM_DT, W, H)
    expect(s.angle).toBeCloseTo(-PLAYER_SHIP.turnSpeed * SIM_DT, 12)
  })
  test('швидкість не перевищує maxSpeed навіть після 10 с газу', () => {
    const s = rest(100, 100)
    for (let i = 0; i < 600; i++)
      stepShip(s, { turn: 0, thrust: true, fire: false }, PLAYER_SHIP, SIM_DT, W, H)
    expect(Math.hypot(s.vx, s.vy)).toBeLessThanOrEqual(PLAYER_SHIP.maxSpeed + 1e-9)
  })
  test('виліт за край — поява з протилежного боку (wrapped)', () => {
    const s = { ...rest(W - 0.5, 10), vx: 200 }
    const { wrapped } = stepShip(s, IDLE, PLAYER_SHIP, SIM_DT, W, H)
    expect(wrapped).toBe(true)
    expect(s.x).toBeGreaterThanOrEqual(0)
    expect(s.x).toBeLessThan(10)
  })
  test('постріл: лише коли cooldown вичерпано; muzzle — перед носом зі швидкістю кулі', () => {
    const s = rest(100, 100)
    const fire: Command = { turn: 0, thrust: false, fire: true }
    expect(stepShip(s, fire, PLAYER_SHIP, SIM_DT, W, H).fired).toBe(true)
    expect(stepShip(s, fire, PLAYER_SHIP, SIM_DT, W, H).fired).toBe(false) // ще перезаряджається
    const m = muzzle(rest(100, 100), PLAYER_SHIP.radius)
    expect(m.x).toBeGreaterThan(100)
    expect(Math.hypot(m.vx, m.vy)).toBeCloseTo(BULLET_SPEED, 6)
  })
})

describe('колізії', () => {
  const rock = (x: number, y: number) => new Asteroid({ size: 1, x, y, rng: createRng(1) })
  function pairs(world: World): number {
    return [...findCollisions(world)].length
  }

  test('перекриваються → пара; далеко → нічого', () => {
    const w = emptyWorld()
    w.spawn(rock(100, 100))
    w.spawn(new Bullet({ x: 105, y: 100 }))
    expect(pairs(w)).toBe(1)
    const far = emptyWorld()
    far.spawn(rock(100, 100))
    far.spawn(new Bullet({ x: 300, y: 100 }))
    expect(pairs(far)).toBe(0)
  })
  test('рівно дотик (відстань = сумі радіусів) — ще НЕ колізія, на 0.01 ближче — вже так', () => {
    const r = RADIUS[1] + 3
    const touching = emptyWorld()
    touching.spawn(rock(100, 100))
    touching.spawn(new Bullet({ x: 100 + r, y: 100 }))
    expect(pairs(touching)).toBe(0)
    const overlap = emptyWorld()
    overlap.spawn(rock(100, 100))
    overlap.spawn(new Bullet({ x: 100 + r - 0.01, y: 100 }))
    expect(pairs(overlap)).toBe(1)
  })
  test('мертві та не-collidable сутності не беруть участі', () => {
    const w = emptyWorld()
    const a = w.spawn(rock(100, 100))
    w.spawn(new Bullet({ x: 100, y: 100 }))
    a.kill()
    expect(pairs(w)).toBe(0)
  })
  test('куля збиває малий астероїд: обидва зникають, гравцю — очки', () => {
    const w = emptyWorld()
    const ship = w.spawn(new Ship({ x: 800, y: 800 }))
    const a = w.spawn(rock(300, 100))
    const b = w.spawn(new Bullet({ x: 250, y: 100, vx: BULLET_SPEED, team: 'player', ownerId: ship.id }))
    for (let i = 0; i < 20 && b.alive; i++) w.step(SIM_DT)
    expect(b.alive).toBe(false)
    expect(a.alive).toBe(false)
    expect(ship.score).toBeGreaterThan(0)
  })
  test('бонус підбирається кораблем гравця', () => {
    const w = emptyWorld()
    const ship = w.spawn(new Ship({ x: 100, y: 100 }))
    w.spawn(new Pickup({ x: 105, y: 100, effect: 'shield' }))
    w.step(SIM_DT)
    expect(ship.effects.has('shield')).toBe(true)
  })

  // «Тунелювання»: дискретна перевірка дивиться лише на позиції після кроку.
  // Куля пролітає BULLET_SPEED·dt = 10 px за крок, а найменша ціль (астероїд 14 + куля 3)
  // має «товщину» 2·17 = 34 px > 10 px — тож проскочити її неможливо за жодного зсуву фази.
  // У 5 разів швидша куля (50 px/крок) вже проскакує за деяких фаз.
  function hitsAtSomePhase(speed: number): { hits: number; phases: number } {
    let hits = 0
    const phases = 20
    for (let k = 0; k < phases; k++) {
      const w = emptyWorld()
      w.spawn(rock(800, 450))
      const startX = 600 + (k / phases) * speed * SIM_DT // різні фази підльоту
      const b = w.spawn(new Bullet({ x: startX, y: 450, vx: speed, ttl: 5 }))
      for (let i = 0; i < 60 && b.alive; i++) w.step(SIM_DT)
      if (!b.alive) hits++
    }
    return { hits, phases }
  }
  test('тунелювання: наша куля (600 px/с) не проскакує найменшу ціль за жодної фази', () => {
    const { hits, phases } = hitsAtSomePhase(BULLET_SPEED)
    expect(hits).toBe(phases)
  })
  test('тунелювання: куля 3000 px/с проскакує за деяких фаз (межа дискретної перевірки)', () => {
    const { hits, phases } = hitsAtSomePhase(3000)
    expect(hits).toBeLessThan(phases)
  })
})

describe('детермінізм World.step', () => {
  function build(): { world: World; id: Ship['id'] } {
    const world = new World({
      ...ARENA_SIZE,
      arena: {
        ...EMPTY,
        startAsteroids: 4,
        asteroidsBase: 4,
        asteroidsCap: 6,
        enemiesBase: 2,
        enemiesCap: 3,
        enemyEvery: 2,
        asteroidEvery: 3,
        seed: 77,
      },
    })
    const ship = world.spawn(new Ship({ x: 400, y: 450 }))
    populateArena(world)
    return { world, id: ship.id }
  }
  test('дві копії з тим самим seed і командами → глибоко рівні знімки після 600 кроків', () => {
    const a = build()
    const b = build()
    for (let i = 0; i < 600; i++) {
      const cmd = { turn: i % 50 < 20 ? 1 : 0, thrust: i % 3 !== 0, fire: i % 4 === 0, seq: toSeq(i + 1) }
      a.world.step(SIM_DT, new Map([[a.id, cmd]]))
      b.world.step(SIM_DT, new Map([[b.id, cmd]]))
    }
    expect(snapshotEntities(a.world)).toEqual(snapshotEntities(b.world))
    expect(a.world.size).toBeGreaterThan(1)
  })
})

describe('звірка (reconcile) — чиста функція', () => {
  const thrust: Command = { turn: 0, thrust: true, fire: false }
  const pend = (from: number, to: number): PendingInput[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ seq: toSeq(from + i), cmd: thrust }))

  test('усе підтверджено → стан сервера як є, черга порожня', () => {
    const server = rest(100, 100)
    const r = reconcile(server, pend(1, 5), toSeq(5), PLAYER_SHIP, W, H)
    expect(r.pending).toEqual([])
    expect(r.state).toEqual(server)
  })
  test('стан сервера + повтор непідтверджених = локальне передбачення', () => {
    // клієнт передбачив 10 кроків газу; сервер підтвердив лише 6 з них
    const local = rest(100, 100)
    const atAck = rest(100, 100)
    for (let i = 1; i <= 10; i++) {
      stepShip(local, thrust, PLAYER_SHIP, SIM_DT, W, H)
      if (i <= 6) stepShip(atAck, thrust, PLAYER_SHIP, SIM_DT, W, H)
    }
    const r = reconcile(atAck, pend(1, 10), toSeq(6), PLAYER_SHIP, W, H)
    expect(r.pending.map((p) => p.seq)).toEqual([7, 8, 9, 10])
    expect(r.state).toEqual(local) // біт-у-біт: та сама функція фізики
  })
  test('не змінює вхідні дані', () => {
    const server = rest(100, 100)
    const pending = pend(1, 3)
    reconcile(server, pending, toSeq(0), PLAYER_SHIP, W, H)
    expect(server).toEqual(rest(100, 100))
    expect(pending).toHaveLength(3)
  })
  test('сервер «відкинув» літак (влучання) → результат іде від нового стану сервера', () => {
    const pushed = { ...rest(500, 500), vx: -100 }
    const r = reconcile(pushed, pend(4, 5), toSeq(3), PLAYER_SHIP, W, H)
    expect(r.state.x).toBeLessThan(500) // далі летимо від нової точки, а не від старого передбачення
  })
})

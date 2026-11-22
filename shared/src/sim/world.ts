import { createRng, type Rng } from './random.ts'
import { findCollisions, resolveCollisions, type CollisionDetector } from './collision.ts'
import { homingSystem } from './systems.ts'
import { spawnerSystem, type Director } from './spawner.ts'
import { Vector2, type Point } from './vector.ts'
import { Bus } from '../bus.ts'
import { DEFAULT_ARENA, type ArenaConfig } from '../arena-config.ts'
import type { GameEvents } from '../events.ts'
import type { Command } from './ship-physics.ts'
import type { EntityId } from '../types.ts'
import type { Ship } from './ship.ts'
import type { Bullet } from './bullet.ts'
import type { Asteroid } from './asteroid.ts'
import type { Pickup } from './pickup.ts'
import type { Explosion } from './explosion.ts'
import type { Kind } from './entity.ts'

// Будь-яка сутність світу — DISCRIMINATED UNION за полем kind.
// Після `if (e.kind === 'ship')` TypeScript знає, що e — Ship, і дає доступ до e.hp.
export type AnyEntity = Ship | Bullet | Asteroid | Pickup | Explosion
export type EntityOfKind<K extends Kind> = Extract<AnyEntity, { kind: K }>

// предикат-звуження для генериків: ofKind('ship') повертає саме Ship, без жодного `as`
function isKind<K extends Kind>(e: AnyEntity, kind: K): e is EntityOfKind<K> {
  return e.kind === kind
}

// Команди гравців на один крок: shipId -> команда (або кілька, коли сервер наздоганяє)
export type Inputs = ReadonlyMap<EntityId, Command | readonly Command[]>

export interface WorldInit {
  width: number
  height: number
  arena?: ArenaConfig
  seed?: number
  detectCollisions?: CollisionDetector
}

// Менеджер сутностей: тримає всі "речі у світі" в Map<EntityId, AnyEntity>
// і раз за крок симуляції оновлює їх, рахує колізії, прибирає мертвих.
// Lab 3–6: події йдуть через типізовану шину world.events (Bus<GameEvents>).
export class World {
  #entities = new Map<EntityId, AnyEntity>()
  #pending: AnyEntity[] = [] // народжені під час кроку — додамо після нього
  #stepping = false

  width: number
  height: number
  readonly arena: ArenaConfig
  readonly rng: Rng
  readonly detectCollisions: CollisionDetector
  readonly events = new Bus<GameEvents>()
  time = 0
  score = 0
  deaths = 0
  inputs: Inputs = new Map()
  readonly director: Director = { asteroid: 5, enemy: 4, pickup: 7 } // таймери спавнера

  constructor({
    width,
    height,
    arena = DEFAULT_ARENA,
    seed = arena.seed,
    detectCollisions = findCollisions,
  }: WorldInit) {
    this.width = width
    this.height = height
    this.arena = arena
    this.rng = createRng(seed)
    this.detectCollisions = detectCollisions
  }

  // очки отримує конкретний гравець (shipId — хто збив); world.score — сума для статистики
  addScore(delta: number, pos: Point, shipId: EntityId): void {
    this.score += delta
    const ship = this.get(shipId)
    if (ship?.kind === 'ship') ship.score += delta
    this.events.emit('score', { type: 'score', delta, shipId, x: pos.x, y: pos.y })
  }

  // generic: spawn(new Ship(...)) повертає Ship, а не AnyEntity
  spawn<T extends AnyEntity>(entity: T): T {
    // Map при for…of бачить елементи, додані ПІД ЧАС обходу — тому під час кроку відкладаємо
    if (this.#stepping) this.#pending.push(entity)
    else this.#entities.set(entity.id, entity)
    return entity
  }

  // відкладене видалення: лише позначаємо, приберемо в кінці кроку
  despawn(id: EntityId): void {
    this.#entities.get(id)?.kill()
  }

  get(id: EntityId): AnyEntity | undefined {
    return this.#entities.get(id)
  }

  get size(): number {
    return this.#entities.size
  }

  *[Symbol.iterator](): Generator<AnyEntity> {
    yield* this.#entities.values()
  }

  *ofKind<K extends Kind>(kind: K): Generator<EntityOfKind<K>> {
    for (const e of this) if (isKind(e, kind)) yield e
  }

  count(predicate: (e: AnyEntity) => boolean): number {
    let n = 0
    for (const e of this) if (e.alive && predicate(e)) n++
    return n
  }

  nearest(pos: Point, predicate: (e: AnyEntity) => boolean, maxDist = Infinity): AnyEntity | null {
    let best: AnyEntity | null = null
    let bestDist = maxDist * maxDist
    for (const e of this) {
      if (!predicate(e)) continue
      const d = e.pos.sub(pos).lengthSq()
      if (d < bestDist) {
        bestDist = d
        best = e
      }
    }
    return best
  }

  // випадкова точка подалі від астероїдів і ворогів (для респауну та бонусів)
  findSafeSpot(minDist = 170): Vector2 {
    const margin = 60
    let spot = new Vector2(this.width / 2, this.height / 2)
    for (let attempt = 0; attempt < 40; attempt++) {
      spot = new Vector2(
        this.rng.range(margin, this.width - margin),
        this.rng.range(margin, this.height - margin),
      )
      const danger = this.nearest(
        spot,
        (e) =>
          e.alive &&
          e.collidable &&
          (e.kind === 'asteroid' || (e.kind === 'ship' && e.team === 'enemy') || e.kind === 'bullet'),
        minDist,
      )
      if (!danger) return spot
    }
    return spot
  }

  step(dt: number, inputs: Inputs = new Map()): void {
    this.inputs = inputs
    this.time += dt
    this.#stepping = true

    for (const e of this) e.savePrevious()
    homingSystem(this, dt)
    for (const e of this) if (e.alive) e.update(dt, this)
    resolveCollisions(this, this.detectCollisions(this))
    spawnerSystem(this, dt)

    this.#stepping = false
    this.#sweep()
    for (const e of this.#pending) this.#entities.set(e.id, e)
    this.#pending.length = 0
  }

  #sweep(): void {
    for (const [id, e] of this.#entities) if (!e.alive) this.#entities.delete(id)
  }
}

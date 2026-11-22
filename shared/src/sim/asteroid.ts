import { Entity, type EntityInit } from './entity.ts'
import { bounceOffEdges } from './arena.ts'
import { Vector2 } from './vector.ts'
import { homing, type HomingSpec } from './components.ts'
import type { Rng } from './random.ts'
import type { World } from './world.ts'

export type AsteroidSize = 1 | 2 | 3 // 3 — великий, 2 — середній, 1 — маленький

export const RADIUS: Readonly<Record<AsteroidSize, number>> = { 3: 38, 2: 24, 1: 14 }
const HP: Readonly<Record<AsteroidSize, number>> = { 3: 3, 2: 2, 1: 1 }
export const ASTEROID_SCORE: Readonly<Record<AsteroidSize, number>> = { 3: 20, 2: 50, 1: 100 }

export function isAsteroidSize(n: unknown): n is AsteroidSize {
  return n === 1 || n === 2 || n === 3
}

export interface Crater {
  readonly x: number
  readonly y: number
  readonly r: number
}
export interface Speck extends Crater {
  readonly light: boolean
}

export interface AsteroidInit extends EntityInit {
  size?: AsteroidSize
  rng: Rng
}

export class Asteroid extends Entity {
  readonly kind: 'asteroid' = 'asteroid'
  #hp: number
  readonly size: AsteroidSize
  spin: number
  homing: HomingSpec | null = null
  variant: number // який із 4 кадрів спрайт-листа малювати
  readonly shape: readonly number[] // нерівний контур — набір радіусів по колу (дані для рендера)
  readonly craters: readonly Crater[]
  readonly specks: readonly Speck[]

  constructor({ size = 3, rng, ...rest }: AsteroidInit) {
    super({ radius: RADIUS[size], ...rest })
    this.size = size
    this.#hp = HP[size]
    this.spin = rng.range(-1.2, 1.2)
    this.variant = rng.int(0, 3)

    const points = 9 + size * 2
    this.shape = Array.from({ length: points }, () => rng.range(0.78, 1.06))

    // один крупний кратер + кілька дрібніших, розкиданих так, щоб майже не накладались
    const craterCount = 1 + size * 2
    const craters: Crater[] = []
    for (let tries = 0; craters.length < craterCount && tries < 60; tries++) {
      const big = craters.length === 0
      const r = big ? rng.range(0.24, 0.32) : rng.range(0.07, 0.17)
      const a = rng.range(0, Math.PI * 2)
      const d = rng.range(0.05, 0.72 - r)
      const c = { x: Math.cos(a) * d, y: Math.sin(a) * d, r }
      const overlaps = craters.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < (o.r + c.r) * 0.9)
      if (!overlaps) craters.push(c)
    }
    this.craters = craters
    // дрібні плями на поверхні (пил, камінці)
    this.specks = Array.from({ length: 6 + size * 4 }, () => {
      const a = rng.range(0, Math.PI * 2)
      const d = rng.range(0, 0.75)
      return { x: Math.cos(a) * d, y: Math.sin(a) * d, r: rng.range(0.02, 0.05), light: rng.chance(0.5) }
    })
  }

  get hp(): number {
    return this.#hp
  }

  // повертає true, якщо астероїд зруйновано
  damage(amount: number): boolean {
    this.#hp -= amount
    return this.#hp <= 0
  }

  override update(dt: number, world: World): void {
    this.angle += this.spin * dt
    super.update(dt, world)
    bounceOffEdges(this, world.width, world.height)
  }

  // розколюється на два менші, що розлітаються в різні боки
  split(world: World): Asteroid[] {
    if (this.size === 1) return []
    const childSize: AsteroidSize = this.size === 3 ? 2 : 1
    const base = this.vel.length() * 1.3 + 30
    const dir = this.vel.angle()
    return [-1, 1].map((side) => {
      const v = Vector2.fromAngle(dir + side * world.rng.range(0.5, 1.1), base)
      const child = new Asteroid({
        size: childSize,
        rng: world.rng,
        x: this.pos.x + side * 6,
        y: this.pos.y - side * 6,
        vx: v.x,
        vy: v.y,
      })
      if (this.homing) child.homing = homing({ ...this.homing })
      return world.spawn(child)
    })
  }
}

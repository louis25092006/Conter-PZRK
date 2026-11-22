import { Entity } from './entity.js'
import { bounceOffEdges } from './arena.js'
import { Vector2 } from './vector.js'
import { homing } from './components.js'

// розмір 3 — великий, 2 — середній, 1 — маленький
export const RADIUS = { 3: 38, 2: 24, 1: 14 }
const HP = { 3: 3, 2: 2, 1: 1 }
export const ASTEROID_SCORE = { 3: 20, 2: 50, 1: 100 }

export class Asteroid extends Entity {
  #hp

  constructor({ size = 3, rng, ...rest } = {}) {
    super({ kind: 'asteroid', radius: RADIUS[size], ...rest })
    this.size = size
    this.#hp = HP[size]
    this.spin = rng.range(-1.2, 1.2)
    this.homing = null
    this.variant = rng.int(0, 3) // який із 4 кадрів спрайт-листа малювати

    // нерівний контур — набір радіусів по колу (дані для рендера)
    const points = 9 + size * 2
    this.shape = Array.from({ length: points }, () => rng.range(0.78, 1.06))

    // кратери: позиція (у частках радіуса), розмір — теж дані для рендера.
    // Беруться з rng світу, тож у однакової гри однакові кратери.
    // один крупний кратер + кілька дрібніших, розкиданих так, щоб майже не накладались
    const craterCount = 1 + size * 2
    this.craters = []
    for (let tries = 0; this.craters.length < craterCount && tries < 60; tries++) {
      const big = this.craters.length === 0
      const r = big ? rng.range(0.24, 0.32) : rng.range(0.07, 0.17)
      const a = rng.range(0, Math.PI * 2)
      const d = rng.range(0.05, 0.72 - r)
      const c = { x: Math.cos(a) * d, y: Math.sin(a) * d, r }
      const overlaps = this.craters.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < (o.r + c.r) * 0.9)
      if (!overlaps) this.craters.push(c)
    }
    // дрібні плями на поверхні (пил, камінці)
    this.specks = Array.from({ length: 6 + size * 4 }, () => {
      const a = rng.range(0, Math.PI * 2)
      const d = rng.range(0, 0.75)
      return { x: Math.cos(a) * d, y: Math.sin(a) * d, r: rng.range(0.02, 0.05), light: rng.chance(0.5) }
    })
  }

  get hp() {
    return this.#hp
  }

  // повертає true, якщо астероїд зруйновано
  damage(amount) {
    this.#hp -= amount
    return this.#hp <= 0
  }

  update(dt, world) {
    this.angle += this.spin * dt
    super.update(dt, world)
    bounceOffEdges(this, world.width, world.height)
  }

  // розколюється на два менші, що розлітаються в різні боки
  split(world) {
    if (this.size <= 1) return []
    const base = this.vel.length() * 1.3 + 30
    const dir = this.vel.angle()
    return [-1, 1].map((side) => {
      const v = Vector2.fromAngle(dir + side * world.rng.range(0.5, 1.1), base)
      const child = new Asteroid({
        size: this.size - 1,
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

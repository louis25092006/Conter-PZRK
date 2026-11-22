import { wrapAngle } from './vector.ts'
import { Bullet } from './bullet.ts'
import { Asteroid } from './asteroid.ts'
import type { World } from './world.ts'

// Система самонаведення: проходить по всіх сутностях і, якщо в сутності є компонент
// homing, повертає її швидкість у бік найближчої цілі (не більше turnRate рад/с).
// Їй байдуже, куля це чи астероїд — композиція з Lab 2.
export function homingSystem(world: World, dt: number): void {
  for (const e of world) {
    if (!(e instanceof Bullet || e instanceof Asteroid)) continue
    const h = e.homing
    if (!h || !e.alive) continue

    const target = world.nearest(
      e.pos,
      (t) => t !== e && t.alive && t.collidable && t.team !== h.ownTeam && h.targetKinds.includes(t.kind),
      h.range,
    )
    if (!target) continue

    // повертаємо вектор швидкості до цілі, довжина швидкості не змінюється
    const desired = target.pos.sub(e.pos).angle()
    const diff = wrapAngle(desired - e.vel.angle())
    const maxTurn = h.turnRate * dt
    const turn = Math.max(-maxTurn, Math.min(maxTurn, diff))
    e.vel = e.vel.rotate(turn)
    if (e instanceof Bullet) e.angle = e.vel.angle()
  }
}

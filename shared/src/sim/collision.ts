import { Explosion } from './explosion.ts'
import { Asteroid, ASTEROID_SCORE } from './asteroid.ts'
import { Bullet } from './bullet.ts'
import { Ship } from './ship.ts'
import { Pickup } from './pickup.ts'
import type { Point } from './vector.ts'
import type { AnyEntity, World } from './world.ts'
import type { EntityId, Team } from '../types.ts'

// ---------- Детекція ----------
// Окрема "система": бере світ, віддає пари (a, b), що перетинаються.
// Наївне O(n²); світ отримує цю функцію як параметр, тож її можна підмінити (Lab 7: spatial hash).
export type CollisionDetector = (world: World) => Iterable<readonly [AnyEntity, AnyEntity]>

export function* findCollisions(world: World): Generator<readonly [AnyEntity, AnyEntity]> {
  const list: AnyEntity[] = []
  for (const e of world) if (e.alive && e.collidable) list.push(e)

  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (!a) continue // noUncheckedIndexedAccess: list[i] — AnyEntity | undefined
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j]
      if (!b) continue
      const r = a.radius + b.radius
      const dx = a.pos.x - b.pos.x
      const dy = a.pos.y - b.pos.y
      if (dx * dx + dy * dy < r * r) yield [a, b]
    }
  }
}

// ---------- Реакція ----------
// Lab 6: замість таблиці за рядком "asteroid:bullet" — перевірки instanceof.
// Після `a instanceof Asteroid && b instanceof Bullet` компілятор ЗНАЄ типи обох,
// і `bullet.damage` чи `asteroid.split()` перевіряються, а не приводяться силою.

interface Attacker {
  readonly team: Team
  readonly shipId: EntityId | null
}

function react(world: World, a: AnyEntity, b: AnyEntity): boolean {
  if (a instanceof Asteroid && b instanceof Bullet) {
    b.kill()
    if (a.damage(b.damage)) destroyAsteroid(world, a, { team: b.team, shipId: b.ownerId })
    else {
      sparks(world, b.pos, '#aaa')
      world.events.emit('hit', {
        type: 'hit',
        target: 'asteroid',
        team: a.team,
        shipId: null,
        x: b.pos.x,
        y: b.pos.y,
      })
    }
    return true
  }
  if (a instanceof Bullet && b instanceof Ship) {
    if (a.team === b.team) return true // своїх не б'ємо
    a.kill()
    hitShip(world, b, a.damage, { team: a.team, shipId: a.ownerId })
    return true
  }
  if (a instanceof Asteroid && b instanceof Ship) {
    if (b.invulnerable > 0) return true
    hitShip(world, b, 1, null)
    destroyAsteroid(world, a, null)
    return true
  }
  if (a instanceof Ship && b instanceof Ship) {
    if (a.team === b.team) return true
    hitShip(world, a, 1, { team: b.team, shipId: b.id })
    hitShip(world, b, 1, { team: a.team, shipId: a.id })
    // відштовхуємо один від одного, щоб не бились кожен кадр
    const push = a.pos.sub(b.pos).normalize().scale(220)
    a.vel = a.vel.add(push)
    b.vel = b.vel.sub(push)
    return true
  }
  if (a instanceof Pickup && b instanceof Ship) {
    if (b.team !== 'player') return true // вороги бонуси не підбирають
    b.applyEffect(a.effect)
    a.kill()
    world.events.emit('pickup', { type: 'pickup', effect: a.effect, shipId: b.id, x: a.pos.x, y: a.pos.y })
    return true
  }
  return false // такої пари правил немає (куля+куля, астероїд+астероїд…)
}

export function resolveCollisions(world: World, pairs: Iterable<readonly [AnyEntity, AnyEntity]>): void {
  for (const [a, b] of pairs) {
    // сутність могла загинути від попередньої пари на цьому ж кроці
    if (!a.alive || !b.alive || !a.collidable || !b.collidable) continue
    if (!react(world, a, b)) react(world, b, a) // правило могло бути записане у зворотному порядку
  }
}

// ---------- Наслідки ----------

function sparks(world: World, pos: Point, color: string): void {
  world.spawn(new Explosion({ rng: world.rng, x: pos.x, y: pos.y, count: 6, speed: 90, ttl: 0.35, color }))
}

function hitShip(world: World, ship: Ship, amount: number, attacker: Attacker | null): void {
  const killed = ship.damage(amount)
  if (!killed) {
    sparks(world, ship.pos, '#ffe066')
    world.events.emit('hit', {
      type: 'hit',
      target: 'ship',
      team: ship.team,
      shipId: ship.id,
      x: ship.pos.x,
      y: ship.pos.y,
    })
    return
  }
  world.events.emit('exploded', {
    type: 'exploded',
    kind: 'ship',
    team: ship.team,
    shipId: ship.id,
    size: 3,
    x: ship.pos.x,
    y: ship.pos.y,
  })
  world.spawn(
    new Explosion({
      rng: world.rng,
      x: ship.pos.x,
      y: ship.pos.y,
      count: 40,
      speed: 220,
      color: ship.team === 'player' ? '#ffb347' : '#ff5c5c',
    }),
  )

  if (ship.team === 'player') {
    ship.startRespawn() // гравець не зникає зі світу — через 2 с з'явиться знову
    ship.deaths++
    world.deaths++
  } else {
    ship.kill()
    if (attacker?.team === 'player' && attacker.shipId !== null)
      world.addScore(150, ship.pos, attacker.shipId)
  }
}

function destroyAsteroid(world: World, asteroid: Asteroid, attacker: Attacker | null): void {
  asteroid.kill()
  asteroid.split(world)
  world.spawn(
    new Explosion({
      rng: world.rng,
      x: asteroid.pos.x,
      y: asteroid.pos.y,
      count: 10 + asteroid.size * 8,
      speed: 120,
      color: '#c9b79c',
    }),
  )
  world.events.emit('exploded', {
    type: 'exploded',
    kind: 'asteroid',
    team: asteroid.team,
    shipId: null,
    size: asteroid.size,
    x: asteroid.pos.x,
    y: asteroid.pos.y,
  })
  if (attacker?.team === 'player' && attacker.shipId !== null)
    world.addScore(ASTEROID_SCORE[asteroid.size], asteroid.pos, attacker.shipId)
}

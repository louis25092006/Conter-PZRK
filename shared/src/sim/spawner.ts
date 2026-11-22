import { Asteroid, type AsteroidSize } from './asteroid.ts'
import { Ship } from './ship.ts'
import { Pickup } from './pickup.ts'
import { Vector2 } from './vector.ts'
import { homing } from './components.ts'
import { EFFECT_NAMES } from '../types.ts'
import type { World } from './world.ts'

// "Режисер" хвиль: з часом генерує астероїди, ворогів і бонуси.
// Скільки і як часто — бере з параметрів арени (world.arena, файл arenas.json).
// Що більше очок — то більше ворогів одночасно.

export { DEFAULT_ARENA } from '../arena-config.ts'

export interface Director {
  asteroid: number
  enemy: number
  pickup: number
}

export function difficulty(world: World): number {
  return 1 + Math.floor(world.score / 500)
}

export function spawnerSystem(world: World, dt: number): void {
  const d = world.director
  const a = world.arena
  const level = difficulty(world)
  d.asteroid -= dt
  d.enemy -= dt
  d.pickup -= dt

  if (d.asteroid <= 0) {
    d.asteroid = a.asteroidEvery
    const maxAsteroids = Math.min(a.asteroidsBase + Math.floor(level / 2), a.asteroidsCap)
    if (world.count((e) => e.kind === 'asteroid') < maxAsteroids) spawnAsteroid(world)
  }

  if (d.enemy <= 0) {
    d.enemy = Math.max(2.5, a.enemyEvery - level * 0.5)
    const maxEnemies = Math.min(a.enemiesBase - 1 + level, a.enemiesCap)
    if (world.count((e) => e.kind === 'ship' && e.team === 'enemy') < maxEnemies) spawnEnemy(world)
  }

  if (d.pickup <= 0) {
    d.pickup = a.pickupEvery
    if (world.count((e) => e.kind === 'pickup') < 2) spawnPickup(world)
  }
}

// стартові астероїди арени
export function populateArena(world: World): void {
  for (let i = 0; i < world.arena.startAsteroids; i++) spawnAsteroid(world, 3)
}

// точка на краю арени + напрямок приблизно до центру
function edgeSpawn(world: World, inset: number): { pos: Vector2; angle: number } {
  const { rng, width: w, height: h } = world
  const side = rng.int(0, 3)
  const along = rng.range(0, side % 2 === 0 ? w : h)
  const pos =
    side === 0
      ? new Vector2(along, inset)
      : side === 1
        ? new Vector2(w - inset, along)
        : side === 2
          ? new Vector2(along, h - inset)
          : new Vector2(inset, along)
  const toCenter = new Vector2(w / 2, h / 2).sub(pos).angle() + rng.range(-0.6, 0.6)
  return { pos, angle: toCenter }
}

const SIZES_WEIGHTED: readonly AsteroidSize[] = [3, 3, 2]

export function spawnAsteroid(world: World, size?: AsteroidSize): Asteroid {
  const { rng } = world
  // частина астероїдів — маленькі "самонавідні": той самий компонент homing, що й у куль
  const isHoming = size === undefined && rng.chance(world.arena.homingChance)
  const finalSize: AsteroidSize = size ?? (isHoming ? 1 : rng.pick(SIZES_WEIGHTED))
  const { pos, angle } = edgeSpawn(world, 40)
  const speed = isHoming ? 70 : rng.range(30, 80)
  const v = Vector2.fromAngle(angle, speed)
  const asteroid = new Asteroid({ size: finalSize, rng, x: pos.x, y: pos.y, vx: v.x, vy: v.y })
  if (isHoming)
    asteroid.homing = homing({ turnRate: 0.9, range: 600, targetKinds: ['ship'], ownTeam: 'neutral' })
  return world.spawn(asteroid)
}

export function spawnEnemy(world: World): Ship {
  const { pos, angle } = edgeSpawn(world, 20)
  return world.spawn(
    new Ship({
      team: 'enemy',
      controller: 'chaser',
      maxHp: 2,
      turnSpeed: 2.6,
      thrustPower: 500,
      maxSpeed: 190,
      fireCooldown: 1.1,
      x: pos.x,
      y: pos.y,
      angle,
    }),
  )
}

export function spawnPickup(world: World): Pickup {
  const spot = world.findSafeSpot(120)
  const effect = world.rng.pick(EFFECT_NAMES)
  return world.spawn(new Pickup({ effect, x: spot.x, y: spot.y }))
}

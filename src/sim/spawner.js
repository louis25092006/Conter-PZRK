import { Asteroid } from './asteroid.js'
import { Ship } from './ship.js'
import { Pickup } from './pickup.js'
import { Vector2 } from './vector.js'
import { homing, EFFECTS } from './components.js'

// "Режисер" хвиль: з часом генерує астероїди, ворогів і бонуси.
// Скільки і як часто — бере з параметрів арени (world.arena, файл arenas.json).
// Що більше очок — то більше ворогів одночасно.

// Те саме, що "classic" у arenas.json — на випадок, якщо World створено без конфігу (тести в Node)
export const DEFAULT_ARENA = {
  name: 'Classic Sky',
  seed: 2026,
  sky: '#000000',
  startAsteroids: 2,
  asteroidEvery: 7,
  asteroidsBase: 2,
  asteroidsCap: 5,
  homingChance: 0.1,
  enemyEvery: 6,
  enemiesBase: 1,
  enemiesCap: 5,
  pickupEvery: 9,
}

export function difficulty(world) {
  return 1 + Math.floor(world.score / 500)
}

export function spawnerSystem(world, dt) {
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
export function populateArena(world) {
  for (let i = 0; i < world.arena.startAsteroids; i++) spawnAsteroid(world, 3)
}

// точка на краю арени + напрямок приблизно до центру
function edgeSpawn(world, inset) {
  const { rng, width: w, height: h } = world
  const side = rng.int(0, 3)
  const pos = [
    new Vector2(rng.range(0, w), inset),
    new Vector2(w - inset, rng.range(0, h)),
    new Vector2(rng.range(0, w), h - inset),
    new Vector2(inset, rng.range(0, h)),
  ][side]
  const toCenter = new Vector2(w / 2, h / 2).sub(pos).angle() + rng.range(-0.6, 0.6)
  return { pos, angle: toCenter }
}

export function spawnAsteroid(world, size) {
  const { rng } = world
  // частина астероїдів — маленькі "самонавідні": той самий компонент homing, що й у куль
  const isHoming = size === undefined && rng.chance(world.arena.homingChance)
  size ??= isHoming ? 1 : rng.pick([3, 3, 2])
  const { pos, angle } = edgeSpawn(world, 40)
  const speed = isHoming ? 70 : rng.range(30, 80)
  const v = Vector2.fromAngle(angle, speed)
  const asteroid = new Asteroid({ size, rng, x: pos.x, y: pos.y, vx: v.x, vy: v.y })
  if (isHoming)
    asteroid.homing = homing({ turnRate: 0.9, range: 600, targetKinds: ['ship'], ownTeam: 'neutral' })
  return world.spawn(asteroid)
}

export function spawnEnemy(world) {
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

export function spawnPickup(world) {
  const spot = world.findSafeSpot(120)
  const effect = world.rng.pick(Object.keys(EFFECTS))
  return world.spawn(new Pickup({ effect, x: spot.x, y: spot.y }))
}

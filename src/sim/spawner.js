import { Asteroid } from './asteroid.js'
import { Ship } from './ship.js'
import { Pickup } from './pickup.js'
import { Vector2 } from './vector.js'
import { homing, EFFECTS } from './components.js'

// "Режисер" хвиль: з часом генерує астероїди, ворогів і бонуси.
// Що більше очок — то більше ворогів одночасно.

export function difficulty(world) {
  return 1 + Math.floor(world.score / 500)
}

export function spawnerSystem(world, dt) {
  const d = world.director
  const level = difficulty(world)
  d.asteroid -= dt
  d.enemy -= dt
  d.pickup -= dt

  if (d.asteroid <= 0) {
    d.asteroid = 7
    const maxAsteroids = Math.min(2 + Math.floor(level / 2), 5)
    if (world.count((e) => e.kind === 'asteroid') < maxAsteroids) spawnAsteroid(world)
  }

  if (d.enemy <= 0) {
    d.enemy = Math.max(2.5, 6 - level * 0.5)
    const maxEnemies = Math.min(level, 5)
    if (world.count((e) => e.kind === 'ship' && e.team === 'enemy') < maxEnemies) spawnEnemy(world)
  }

  if (d.pickup <= 0) {
    d.pickup = 9
    if (world.count((e) => e.kind === 'pickup') < 2) spawnPickup(world)
  }
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
  // ~10% астероїдів — маленькі "самонавідні": той самий компонент homing, що й у куль
  const isHoming = size === undefined && rng.chance(0.1)
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

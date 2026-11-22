import { Explosion } from './explosion.js'
import { ASTEROID_SCORE } from './asteroid.js'

// ---------- Детекція ----------
// Окрема "система": бере світ, віддає пари (a, b), що перетинаються.
// Наївне O(n²) — для десятків сутностей цього досить. Світ отримує цю
// функцію як параметр, тож у Lab 7 її можна замінити на spatial hash,
// не чіпаючи решту коду.
export function* findCollisions(world) {
  const list = []
  for (const e of world) if (e.alive && e.collidable) list.push(e)

  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j]
      const r = a.radius + b.radius
      const dx = a.pos.x - b.pos.x
      const dy = a.pos.y - b.pos.y
      if (dx * dx + dy * dy < r * r) yield [a, b]
    }
  }
}

// ---------- Реакція ----------
// Правила за парою типів. Ключ — назви kind в алфавітному порядку.
const rules = {
  'asteroid:bullet'(world, asteroid, bullet) {
    bullet.kill()
    if (asteroid.damage(bullet.damage)) destroyAsteroid(world, asteroid, bullet.team)
    else {
      sparks(world, bullet.pos, '#aaa')
      world.emit('hit', { target: 'asteroid', team: asteroid.team, x: bullet.pos.x, y: bullet.pos.y })
    }
  },

  'bullet:ship'(world, bullet, ship) {
    if (bullet.team === ship.team) return // своїх не б'ємо
    bullet.kill()
    hitShip(world, ship, bullet.damage, bullet.team)
  },

  'asteroid:ship'(world, asteroid, ship) {
    if (ship.invulnerable > 0) return
    hitShip(world, ship, 1, null)
    destroyAsteroid(world, asteroid, null)
  },

  'ship:ship'(world, a, b) {
    if (a.team === b.team) return
    hitShip(world, a, 1, b.team)
    hitShip(world, b, 1, a.team)
    // відштовхуємо один від одного, щоб не бились кожен кадр
    const push = a.pos.sub(b.pos).normalize().scale(220)
    a.vel = a.vel.add(push)
    b.vel = b.vel.sub(push)
  },

  'pickup:ship'(world, pickup, ship) {
    if (ship.team !== 'player') return // вороги бонуси не підбирають
    ship.applyEffect(pickup.effect)
    pickup.kill()
    world.emit('pickup', { effect: pickup.effect, x: pickup.pos.x, y: pickup.pos.y })
  },
}

export function resolveCollisions(world, pairs) {
  for (const pair of pairs) {
    // сутність могла загинути від попередньої пари на цьому ж кроці
    if (!pair[0].alive || !pair[1].alive || !pair[0].collidable || !pair[1].collidable) continue
    const [a, b] = pair[0].kind <= pair[1].kind ? pair : [pair[1], pair[0]]
    const rule = rules[`${a.kind}:${b.kind}`]
    if (rule) rule(world, a, b)
  }
}

// ---------- Наслідки ----------

function sparks(world, pos, color) {
  world.spawn(new Explosion({ rng: world.rng, x: pos.x, y: pos.y, count: 6, speed: 90, ttl: 0.35, color }))
}

function hitShip(world, ship, amount, attackerTeam) {
  const killed = ship.damage(amount)
  if (!killed) {
    sparks(world, ship.pos, '#ffe066')
    world.emit('hit', { target: 'ship', team: ship.team, x: ship.pos.x, y: ship.pos.y })
    return
  }
  world.emit('exploded', { kind: 'ship', team: ship.team, size: 3, x: ship.pos.x, y: ship.pos.y })

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
    world.deaths++
  } else {
    ship.kill()
    if (attackerTeam === 'player') world.addScore(150, ship.pos)
  }
}

function destroyAsteroid(world, asteroid, attackerTeam) {
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
  world.emit('exploded', {
    kind: 'asteroid',
    team: asteroid.team,
    size: asteroid.size,
    x: asteroid.pos.x,
    y: asteroid.pos.y,
  })
  if (attackerTeam === 'player') world.addScore(ASTEROID_SCORE[asteroid.size], asteroid.pos)
}

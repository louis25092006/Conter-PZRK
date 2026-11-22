import { wrapAngle } from './vector.js'

// КОМПОЗИЦІЯ: поведінка, яку можна "причепити" до будь-якої сутності,
// незалежно від її класу. Усе тут — звичайні дані (рядки, числа),
// а системи (функції нижче) обробляють будь-кого, у кого є потрібне поле.
// Дані легко серіалізувати — це знадобиться в Lab 5 (мережа).

// ---------- Homing: самонаведення ----------
// Чіпляється і до кулі, і до астероїда — це той випадок, де ієрархія
// класів зламалась би (Bullet і Asteroid мали б спільного предка "Homing").

export function homing({ turnRate = 3, range = 400, targetKinds = ['ship'], ownTeam = 'neutral' } = {}) {
  return { turnRate, range, targetKinds, ownTeam }
}

export function homingSystem(world, dt) {
  for (const e of world) {
    const h = e.homing
    if (!h || !e.alive) continue

    const target = world.nearest(
      e.pos,
      (t) => t !== e && t.alive && t.collidable && t.team !== h.ownTeam && h.targetKinds.includes(t.kind),
      h.range,
    )
    if (!target) continue

    // повертаємо вектор швидкості до цілі, не більше ніж turnRate рад/с,
    // довжина швидкості не змінюється — ракета не "прискорюється"
    const desired = target.pos.sub(e.pos).angle()
    const diff = wrapAngle(desired - e.vel.angle())
    const maxTurn = h.turnRate * dt
    const turn = Math.max(-maxTurn, Math.min(maxTurn, diff))
    e.vel = e.vel.rotate(turn)
    if (e.kind === 'bullet') e.angle = e.vel.angle()
  }
}

// ---------- Controller: хто керує кораблем ----------
// ship.controller — це РЯДОК (дані), а не функція. Гравець і ворог —
// той самий клас Ship, відрізняється лише "мозок".
// Кожен контролер повертає команду { turn: -1..1, thrust, fire }.

const IDLE = Object.freeze({ turn: 0, thrust: false, fire: false })

export const controllers = {
  keyboard(ship, world) {
    const input = world.input
    if (!input) return IDLE
    const left = input.isDown('KeyA') || input.isDown('ArrowLeft')
    const right = input.isDown('KeyD') || input.isDown('ArrowRight')
    return {
      turn: (right ? 1 : 0) - (left ? 1 : 0),
      thrust: input.isDown('KeyW') || input.isDown('ArrowUp'),
      fire: input.isDown('Space'),
    }
  },

  // простий ворог-переслідувач: розвертається до найближчого чужого корабля,
  // летить до нього і стріляє, коли ціль майже точно попереду
  chaser(ship, world) {
    const target = world.nearest(ship.pos, (t) => t.kind === 'ship' && t.team !== ship.team && t.collidable)
    if (!target) return { turn: 0.3, thrust: false, fire: false } // кружляє, поки гравець на респауні

    const to = target.pos.sub(ship.pos)
    const diff = wrapAngle(to.angle() - ship.angle)
    const dist = to.length()
    return {
      turn: Math.max(-1, Math.min(1, diff * 3)),
      thrust: dist > 170 && Math.abs(diff) < 1.2,
      fire: dist < 420 && Math.abs(diff) < 0.2,
    }
  },
}

// ---------- Effects: тимчасові бонуси на кораблі ----------
// ship.effects — Map<назва, секунд залишилось>. Поведінка як дані:
// корабель просто питає effects.has('rapid'), без жодних підкласів.

export const EFFECTS = {
  shield: { duration: 6, label: 'SHIELD', color: '#5ad1ff', letter: 'S' },
  rapid: { duration: 6, label: 'RAPID FIRE', color: '#ffd166', letter: 'R' },
  homing: { duration: 8, label: 'HOMING', color: '#c77dff', letter: 'H' },
}

export function tickEffects(effects, dt) {
  for (const [name, left] of effects) {
    if (left - dt <= 0) effects.delete(name)
    else effects.set(name, left - dt)
  }
}

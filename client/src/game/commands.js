import { wrapAngle } from '../../../shared/src/sim/vector.js'

// Клавіатура → команда. Саме команду (а не клавіші) отримує симуляція:
// локально (офлайн) і на сервері (онлайн, по мережі) — та сама форма.
export function keyboardCommand(input) {
  const left = input.isDown('KeyA') || input.isDown('ArrowLeft')
  const right = input.isDown('KeyD') || input.isDown('ArrowRight')
  return {
    turn: (right ? 1 : 0) - (left ? 1 : 0),
    thrust: input.isDown('KeyW') || input.isDown('ArrowUp'),
    fire: input.isDown('Space'),
  }
}

// ?bot=1 — літак сам літає і стріляє по найближчій цілі (для демо у двох вікнах і замірів)
export function botCommand(me, targets, step) {
  if (!me) return { turn: 0, thrust: false, fire: false }
  let best = null
  let bestD = Infinity
  for (const t of targets) {
    const d = Math.hypot(t.x - me.x, t.y - me.y)
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  if (!best) return { turn: 1, thrust: step % 120 < 60, fire: false }
  const diff = wrapAngle(Math.atan2(best.y - me.y, best.x - me.x) - me.angle)
  return {
    turn: diff > 0.08 ? 1 : diff < -0.08 ? -1 : 0,
    thrust: bestD > 220 && Math.abs(diff) < 1,
    fire: Math.abs(diff) < 0.25 && bestD < 600,
  }
}

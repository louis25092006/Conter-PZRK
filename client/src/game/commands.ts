import { wrapAngle, type Point } from '../../../shared/src/sim/vector.ts'
import type { Input } from '../input.ts'

export interface PlayerCommand {
  readonly turn: -1 | 0 | 1
  readonly thrust: boolean
  readonly fire: boolean
}

// Клавіатура → команда. Саме команду (а не клавіші) отримує симуляція:
// локально (офлайн) і на сервері (онлайн, по мережі) — та сама форма.
export function keyboardCommand(input: Input): PlayerCommand {
  const left = input.isDown('KeyA') || input.isDown('ArrowLeft')
  const right = input.isDown('KeyD') || input.isDown('ArrowRight')
  return {
    turn: right === left ? 0 : right ? 1 : -1,
    thrust: input.isDown('KeyW') || input.isDown('ArrowUp'),
    fire: input.isDown('Space'),
  }
}

// ?bot=1 — літак сам літає і стріляє по найближчій цілі (для демо у двох вікнах і замірів)
export function botCommand(
  me: (Point & { readonly angle: number }) | null,
  targets: Iterable<Point>,
  step: number,
): PlayerCommand {
  if (!me) return { turn: 0, thrust: false, fire: false }
  let best: Point | null = null
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

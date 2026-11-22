// Фізика корабля як ЧИСТА функція над простими числами.
// Її викликають І сервер (через Ship.update), І клієнт (передбачення власного літака).
// Тому тут не можна нічого "приблизно": той самий порядок операцій, ті самі константи,
// жодного Math.random() чи Date.now() — інакше передбачення розійдеться з сервером.

import type { Seq } from '../types.ts'

export const SHIP_DRAG = 0.97 // множник швидкості за крок 1/60 с
export const BULLET_SPEED = 600
export const RAPID_COOLDOWN = 0.05
export const SIM_DT = 1 / 60 // один крок симуляції = одна команда гравця

export interface ShipParams {
  readonly turnSpeed: number
  readonly thrustPower: number
  readonly maxSpeed: number
  readonly fireCooldown: number
}

// параметри літака гравця (вороги мають свої — див. spawner.ts)
export const PLAYER_SHIP = Object.freeze({
  turnSpeed: 6,
  thrustPower: 900,
  maxSpeed: 300,
  fireCooldown: 0.1,
  radius: 16,
  maxHp: 10,
})

// стан руху — прості числа (саме це передбачає клієнт); змінюється на місці
export interface MotionState {
  x: number
  y: number
  vx: number
  vy: number
  angle: number
  cooldown: number
}

export type Turn = -1 | 0 | 1

// команда гравця на один крок
export interface Command {
  readonly turn: number // контролер ворога дає дробові значення; гравець — лише -1 | 0 | 1
  readonly thrust: boolean
  readonly fire: boolean
  readonly seq?: Seq
  readonly skip?: true
}

// Для досліду M2 (Lab 5): навмисно зламати детермінізм (лише на клієнті!).
export const debug = { breakDeterminism: false }

export function stepShip(
  s: MotionState,
  cmd: Command,
  p: ShipParams & { readonly rapid?: boolean },
  dt: number,
  width: number,
  height: number,
): { wrapped: boolean; fired: boolean } {
  s.cooldown = Math.max(0, s.cooldown - dt)
  s.angle += cmd.turn * p.turnSpeed * dt
  if (cmd.thrust) {
    const len = p.thrustPower * dt
    s.vx += Math.cos(s.angle) * len
    s.vy += Math.sin(s.angle) * len
    if (debug.breakDeterminism) s.vx += (Math.random() - 0.5) * 40 // ← БАГ навмисно
  }
  s.vx *= SHIP_DRAG
  s.vy *= SHIP_DRAG
  const speed = Math.hypot(s.vx, s.vy)
  if (speed > p.maxSpeed) {
    const k = p.maxSpeed / speed
    s.vx *= k
    s.vy *= k
  }
  s.x += s.vx * dt
  s.y += s.vy * dt

  let wrapped = false
  if (s.x < 0) {
    s.x += width
    wrapped = true
  } else if (s.x > width) {
    s.x -= width
    wrapped = true
  }
  if (s.y < 0) {
    s.y += height
    wrapped = true
  } else if (s.y > height) {
    s.y -= height
    wrapped = true
  }

  let fired = false
  if (cmd.fire && s.cooldown <= 0) {
    s.cooldown = p.rapid ? RAPID_COOLDOWN : p.fireCooldown
    fired = true
  }
  return { wrapped, fired }
}

// де і з якою швидкістю народжується куля (той самий розрахунок на сервері й клієнті)
export function muzzle(
  s: Readonly<MotionState>,
  radius: number,
): { x: number; y: number; vx: number; vy: number } {
  const dx = Math.cos(s.angle)
  const dy = Math.sin(s.angle)
  return {
    x: s.x + dx * (radius + 6),
    y: s.y + dy * (radius + 6),
    vx: s.vx + dx * BULLET_SPEED,
    vy: s.vy + dy * BULLET_SPEED,
  }
}

export const IDLE: Command = Object.freeze({ turn: 0, thrust: false, fire: false })

// Команда гравця ще не дійшла до сервера (затримка/джитер). Літак НЕ рухається на цьому кроці:
// кожна команда дає рівно один крок і на сервері, і в передбаченні клієнта — тож вони не розходяться.
export const SKIP: Command = Object.freeze({ turn: 0, thrust: false, fire: false, skip: true })
